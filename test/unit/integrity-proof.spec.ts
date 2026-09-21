import { randomBytes } from 'node:crypto';
import {
  mintProof,
  proofConnectionOptions,
  verifyProof,
  PROOF_VERSION,
} from '../../src/common/crypto/integrity-proof';

/**
 * The proof is the thing that distinguishes an application write from an
 * attacker's. If it can be forged, guessed or replayed, the whole
 * clinical-integrity control collapses — so each of those is asserted rather
 * than assumed.
 */
describe('integrity proof', () => {
  const key = randomBytes(32);

  it('verifies a freshly minted token', () => {
    const result = verifyProof(mintProof(key), key);
    expect(result.valid).toBe(true);
    expect(result.issuedAt).toBeInstanceOf(Date);
  });

  it('rejects an absent token — the direct-database-session case', () => {
    expect(verifyProof(null, key)).toEqual({ valid: false, reason: 'absent' });
    expect(verifyProof(undefined, key)).toEqual({ valid: false, reason: 'absent' });
    expect(verifyProof('', key)).toEqual({ valid: false, reason: 'absent' });
  });

  it('rejects a token signed with a different key', () => {
    const forged = mintProof(randomBytes(32));
    expect(verifyProof(forged, key)).toMatchObject({ valid: false, reason: 'bad-signature' });
  });

  it('rejects a tampered signature of the correct length', () => {
    const token = mintProof(key);
    const parts = token.split('.');
    // Flip one hex digit, preserving length so the constant-time compare runs.
    const flipped = parts[3].slice(0, -1) + (parts[3].slice(-1) === 'a' ? 'b' : 'a');
    expect(verifyProof([parts[0], parts[1], parts[2], flipped].join('.'), key)).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a token whose timestamp was moved to extend its life', () => {
    const token = mintProof(key);
    const [, , nonce, mac] = token.split('.');
    const future = Math.floor(Date.now() / 1000) + 86_400;
    // The MAC covers the timestamp, so rewriting it invalidates the signature.
    expect(verifyProof(`${PROOF_VERSION}.${future}.${nonce}.${mac}`, key)).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('rejects malformed and wrong-version tokens', () => {
    expect(verifyProof('garbage', key)).toMatchObject({ reason: 'malformed' });
    expect(verifyProof('a.b.c', key)).toMatchObject({ reason: 'malformed' });
    expect(verifyProof('v9.1.2.3', key)).toMatchObject({ reason: 'bad-version' });
    expect(verifyProof('v1.notanumber.aa.bb', key)).toMatchObject({ reason: 'malformed' });
  });

  it('expires a token past its maximum age', () => {
    const old = mintProof(key, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    expect(verifyProof(old, key, new Date(), 7 * 24 * 60 * 60)).toMatchObject({
      valid: false,
      reason: 'expired',
    });
    // Same token, generous window -> still good.
    expect(verifyProof(old, key, new Date(), 30 * 24 * 60 * 60).valid).toBe(true);
  });

  it('rejects a token issued in the future beyond clock-skew tolerance', () => {
    const future = mintProof(key, new Date(Date.now() + 3_600_000));
    expect(verifyProof(future, key)).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('mints a distinct nonce every time, so two writes are never identical', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => mintProof(key).split('.')[2]));
    expect(nonces.size).toBe(200);
  });

  it('produces a token safe to embed in a libpq options string', () => {
    const token = mintProof(key);
    expect(token).toMatch(/^[A-Za-z0-9.]+$/);
    expect(proofConnectionOptions(token)).toBe(`-c amrutam.proof=${token}`);
  });

  it('refuses to build an options string from an unsafe token', () => {
    expect(() => proofConnectionOptions('bad token with spaces')).toThrow(/unsafe/i);
    expect(() => proofConnectionOptions("v1.1.a.b'; DROP TABLE users--")).toThrow(/unsafe/i);
  });
});
