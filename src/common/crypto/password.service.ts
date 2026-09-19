import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };
const scrypt = promisify(scryptCb) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * Production target is Argon2id (m=64MB, t=3, p=4). `argon2` is a native
 * addon; to keep `npm ci` free of a compiler toolchain this implementation
 * uses Node's built-in scrypt with memory-hard parameters (N=2^15, r=8, p=1 —
 * ~32MB per hash), which is the same family of memory-hard KDF and is
 * FIPS-adjacent. The stored format is self-describing:
 *
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 *
 * so swapping in argon2id later is a verify-on-read migration, not a reset.
 * See docs/adr/0007-password-hashing.md.
 */
@Injectable()
export class PasswordService {
  private readonly N = 32_768;
  private readonly r = 8;
  private readonly p = 1;
  private readonly keyLen = 32;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, this.keyLen, {
      N: this.N,
      r: this.r,
      p: this.p,
      maxmem: 256 * 1024 * 1024,
    });
    return `scrypt$${this.N}$${this.r}$${this.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    try {
      const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
      if (scheme !== 'scrypt') return false;
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = await scrypt(password, salt, expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 256 * 1024 * 1024,
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  /** Reject trivially weak or breached-pattern passwords. */
  static validateStrength(password: string): string[] {
    const errors: string[] = [];
    if (password.length < 12) errors.push('must be at least 12 characters');
    if (!/[a-z]/.test(password)) errors.push('must contain a lowercase letter');
    if (!/[A-Z]/.test(password)) errors.push('must contain an uppercase letter');
    if (!/[0-9]/.test(password)) errors.push('must contain a digit');
    if (!/[^A-Za-z0-9]/.test(password)) errors.push('must contain a symbol');
    const common = ['password', 'qwerty', '123456', 'letmein', 'admin', 'welcome', 'amrutam'];
    if (common.some((c) => password.toLowerCase().includes(c))) {
      errors.push('must not contain a common breached word');
    }
    return errors;
  }
}
