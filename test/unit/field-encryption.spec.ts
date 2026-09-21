import { ConfigService } from '@nestjs/config';
import { FieldEncryptionService } from '../../src/common/crypto/field-encryption.service';

const MASTER = 'a'.repeat(64);
const HMAC_KEY = 'b'.repeat(64);

function makeService(version = 1): FieldEncryptionService {
  process.env.ENCRYPTION_KEY_VERSION = String(version);
  const config = {
    getOrThrow: (key: string) => (key === 'ENCRYPTION_MASTER_KEY' ? MASTER : HMAC_KEY),
  } as unknown as ConfigService;
  return new FieldEncryptionService(config);
}

describe('FieldEncryptionService', () => {
  const svc = makeService();

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY_VERSION;
  });

  it('round-trips a value', () => {
    const plaintext = 'asha.patel@example.com';
    expect(svc.decrypt(svc.encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips unicode and long values intact', () => {
    for (const value of ['रोगी का नाम', '🩺 emoji', 'x'.repeat(10_000), '']) {
      expect(svc.decrypt(svc.encrypt(value))).toBe(value);
    }
  });

  it('is non-deterministic — the same input encrypts differently every time', () => {
    const a = svc.encrypt('same input');
    const b = svc.encrypt('same input');
    expect(a.equals(b)).toBe(false);
    expect(svc.decrypt(a)).toBe(svc.decrypt(b));
  });

  it('writes the key version into the envelope header', () => {
    expect(svc.encrypt('x').readUInt16BE(0)).toBe(1);
    expect(makeService(2).encrypt('x').readUInt16BE(0)).toBe(2);
  });

  it('can still read ciphertext written under an older key version', () => {
    const v1 = makeService(1);
    const envelope = v1.encrypt('written under v1');
    // A service running at v2 must transparently decrypt v1 data.
    const v2 = makeService(2);
    expect(v2.decrypt(envelope)).toBe('written under v1');
    expect(v2.keyVersion).toBe(2);
  });

  it('rejects tampered ciphertext via the GCM auth tag', () => {
    const envelope = svc.encrypt('sensitive clinical note');
    envelope[envelope.length - 1] ^= 0xff; // flip a bit in the tag
    expect(() => svc.decrypt(envelope)).toThrow();
  });

  it('rejects a tampered body', () => {
    const envelope = svc.encrypt('sensitive clinical note');
    envelope[20] ^= 0x01;
    expect(() => svc.decrypt(envelope)).toThrow();
  });

  it('treats null, undefined and truncated buffers as absent', () => {
    expect(svc.decrypt(null)).toBeNull();
    expect(svc.decrypt(undefined)).toBeNull();
    expect(svc.decrypt(Buffer.alloc(4))).toBeNull();
  });

  it('produces a stable, case-insensitive blind index for emails', () => {
    // The index is a keyed digest, so compare by value rather than identity.
    const a = svc.emailHash('Asha.Patel@Example.com');
    const b = svc.emailHash('asha.patel@example.com');
    const other = svc.emailHash('someone.else@example.com');

    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(other).toString('hex'));
    // It must not be reversible to, or contain, the address.
    expect(Buffer.from(a).toString('utf8')).not.toContain('asha');
  });
});
