import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Proof of application origin for clinical writes.
 *
 * Every database connection the API opens carries a token in its libpq startup
 * options (`-c amrutam.proof=...`). The capture trigger copies that token into
 * `clinical_integrity_journal.proof` verbatim; it never validates it, because
 * the database must not hold the signing key — if it did, anyone who can write
 * to the database could also mint a proof and the control would be worthless.
 *
 * Verification therefore happens in the application (or an out-of-band
 * auditor), which has INTEGRITY_PROOF_KEY from KMS.
 *
 * Format: `v1.<issuedAtEpochSeconds>.<nonceHex>.<hmacHex>`
 *   hmac = HMAC-SHA256(key, "v1.<issuedAt>.<nonce>")
 *
 * What this proves: the write came from a process holding the key.
 * What it does not prove: which user requested it — that is the audit log's
 * job. The two are joined by the request id recorded in both.
 */

export const PROOF_VERSION = 'v1';
const SEPARATOR = '.';

export interface ProofVerification {
  valid: boolean;
  reason?: 'absent' | 'malformed' | 'bad-version' | 'bad-signature' | 'expired';
  issuedAt?: Date;
  nonce?: string;
}

/** Mint a proof token. Called once per process at boot. */
export function mintProof(key: Buffer, issuedAt: Date = new Date()): string {
  const seconds = Math.floor(issuedAt.getTime() / 1000);
  const nonce = randomBytes(12).toString('hex');
  const body = `${PROOF_VERSION}${SEPARATOR}${seconds}${SEPARATOR}${nonce}`;
  const mac = createHmac('sha256', key).update(body).digest('hex');
  return `${body}${SEPARATOR}${mac}`;
}

/**
 * Verify a proof token read back from the journal.
 *
 * `maxAgeSeconds` bounds how long a leaked token stays useful. It is generous
 * by default (30 days) because a long-lived API process legitimately keeps one
 * token for its whole lifetime; the value exists so an operator can tighten it
 * after an incident.
 */
export function verifyProof(
  token: string | null | undefined,
  key: Buffer,
  now: Date = new Date(),
  maxAgeSeconds = 30 * 24 * 60 * 60,
): ProofVerification {
  if (!token) return { valid: false, reason: 'absent' };

  const parts = token.split(SEPARATOR);
  if (parts.length !== 4) return { valid: false, reason: 'malformed' };

  const [version, issuedAtRaw, nonce, mac] = parts;
  if (version !== PROOF_VERSION) return { valid: false, reason: 'bad-version' };

  const issuedAtSeconds = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) {
    return { valid: false, reason: 'malformed' };
  }

  const body = `${version}${SEPARATOR}${issuedAtRaw}${SEPARATOR}${nonce}`;
  const expected = createHmac('sha256', key).update(body).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(mac, 'utf8');
  // Length check first: timingSafeEqual throws on a mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad-signature' };
  }

  const issuedAt = new Date(issuedAtSeconds * 1000);
  const ageSeconds = (now.getTime() - issuedAt.getTime()) / 1000;
  // A token from the future is as suspicious as an expired one.
  if (ageSeconds > maxAgeSeconds || ageSeconds < -300) {
    return { valid: false, reason: 'expired', issuedAt, nonce };
  }

  return { valid: true, issuedAt, nonce };
}

/**
 * The libpq `options` string that carries the proof on every connection.
 *
 * Postgres GUC values cannot contain unescaped spaces or backslashes in this
 * form; the token is restricted to hex, digits and dots, so no escaping is
 * required. Asserted here rather than assumed, because a malformed options
 * string fails the connection at boot with a confusing error.
 */
export function proofConnectionOptions(token: string): string {
  if (!/^[A-Za-z0-9.]+$/.test(token)) {
    throw new Error('integrity proof token contains characters unsafe for a libpq options string');
  }
  return `-c amrutam.proof=${token}`;
}
