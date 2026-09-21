import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION_LEN = 2;

/**
 * Envelope field-level encryption for PII / PHI.
 *
 * Layout of a stored ciphertext (BYTEA):
 *   [ 2 bytes key_version | 12 bytes IV | ciphertext | 16 bytes GCM tag ]
 *
 * The per-version Data Encryption Key (DEK) is derived from the master key
 * with HKDF. In production the master key lives in AWS KMS and the DEK is
 * unwrapped at boot; locally it comes from ENCRYPTION_MASTER_KEY. Because the
 * version travels with the ciphertext, rotation is non-breaking: new writes
 * use the newest version while old rows stay readable until re-encrypted by
 * `npm run keys:rotate`.
 *
 * Emails additionally get a deterministic HMAC ("blind index") so we can do
 * equality lookups without storing plaintext or a decryptable duplicate.
 */
@Injectable()
export class FieldEncryptionService implements OnModuleInit {
  private readonly logger = new Logger(FieldEncryptionService.name);
  private readonly dekCache = new Map<number, Buffer>();
  private masterKey!: Buffer;
  private emailHmacKey!: Buffer;
  private currentVersion = 1;

  constructor(private readonly config: ConfigService) {
    this.init();
  }

  onModuleInit(): void {
    this.logger.log(`field encryption ready (AES-256-GCM, key version ${this.currentVersion})`);
  }

  private init(): void {
    this.masterKey = this.toKey(this.config.getOrThrow<string>('ENCRYPTION_MASTER_KEY'));
    this.emailHmacKey = this.toKey(this.config.getOrThrow<string>('EMAIL_HMAC_KEY'));
    this.currentVersion = Number(process.env.ENCRYPTION_KEY_VERSION ?? 1);
  }

  private toKey(material: string): Buffer {
    const hex = /^[0-9a-f]+$/i.test(material) && material.length % 2 === 0;
    const buf = hex ? Buffer.from(material, 'hex') : Buffer.from(material, 'utf8');
    // Normalise any input length to exactly 32 bytes.
    return Buffer.from(hkdfSync('sha256', buf, Buffer.alloc(0), Buffer.from('amrutam-master'), 32));
  }

  /** Derive (and memoise) the DEK for a key version. */
  private dek(version: number): Buffer {
    const cached = this.dekCache.get(version);
    if (cached) return cached;
    const key = Buffer.from(
      hkdfSync('sha256', this.masterKey, Buffer.from(`v${version}`), Buffer.from('amrutam-dek'), 32),
    );
    this.dekCache.set(version, key);
    return key;
  }

  get keyVersion(): number {
    return this.currentVersion;
  }

  /** Encrypt a UTF-8 string into a versioned binary envelope. */
  encrypt(plaintext: string, version = this.currentVersion): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.dek(version), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.alloc(VERSION_LEN);
    header.writeUInt16BE(version, 0);
    return Buffer.concat([header, iv, body, tag]);
  }

  /** Decrypt a versioned envelope. Throws if the auth tag fails (tampering). */
  decrypt(payload: Buffer | null | undefined): string | null {
    if (!payload || payload.length < VERSION_LEN + IV_LEN + TAG_LEN) return null;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const version = buf.readUInt16BE(0);
    const iv = buf.subarray(VERSION_LEN, VERSION_LEN + IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const body = buf.subarray(VERSION_LEN + IV_LEN, buf.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.dek(version), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, version = this.currentVersion): Buffer {
    return this.encrypt(JSON.stringify(value), version);
  }

  decryptJson<T>(payload: Buffer | null | undefined): T | null {
    const raw = this.decrypt(payload);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** Re-encrypt an existing envelope under a new key version (rotation). */
  rotate(payload: Buffer, toVersion: number): Buffer {
    const plain = this.decrypt(payload);
    if (plain === null) throw new Error('cannot rotate: undecryptable payload');
    return this.encrypt(plain, toVersion);
  }

  versionOf(payload: Buffer): number {
    return payload.readUInt16BE(0);
  }

  /** Deterministic blind index for equality lookups on email. */
  emailHash(email: string): Buffer {
    return createHmac('sha256', this.emailHmacKey).update(email.trim().toLowerCase()).digest();
  }

  static constantTimeEquals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
