import { ConfigService } from '@nestjs/config';
import { JoinTokenService } from '../../src/modules/consultations/join-token.service';

/**
 * The join token is the credential that admits someone to a live medical
 * consultation. The implementation it replaced was
 * `stub-rtc-token-${consultationId}` — forgeable by anyone who had seen the id,
 * and ids appear in URLs. These tests are written from the attacker's side:
 * each one is an attempt to get into a consultation the caller has no right to.
 */
describe('JoinTokenService', () => {
  // ConfigService.get() consults process.env BEFORE the config object it was
  // constructed with. The integration project loads .env, and `--runInBand`
  // puts both projects in one process, so a real JOIN_TOKEN_SECRET would
  // silently override every key below and make all the "different key"
  // assertions pass for the wrong reason. Own the environment explicitly.
  // Scrubbed here, in the describe body, rather than in beforeAll: the body is
  // evaluated during collection, before any hook runs, so a service built on
  // the next line would already have captured the leaked value.
  const OVERRIDES = ['JOIN_TOKEN_SECRET', 'JOIN_TOKEN_TTL_SECONDS', 'PRESCRIPTION_SIGNING_KEY'];
  const saved: Record<string, string | undefined> = {};
  for (const k of OVERRIDES) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const config = new ConfigService({
    JOIN_TOKEN_SECRET: 'a'.repeat(64),
    JOIN_TOKEN_TTL_SECONDS: 900,
  });
  const service = new JoinTokenService(config);

  const CID = 'c0000000-0000-4000-8000-000000000001';
  const UID = 'u0000000-0000-4000-8000-000000000002';

  it('issues a token that verifies for the right user and consultation', () => {
    const { token, expiresAt } = service.issue(CID, UID, 'host');
    const result = service.verify(token, { consultationId: CID, userId: UID });

    expect(result.valid).toBe(true);
    expect(result.payload).toMatchObject({ cid: CID, uid: UID, role: 'host' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('is not derivable from the consultation id — the bug it replaced', () => {
    const { token } = service.issue(CID, UID, 'host');
    // The old scheme. Anyone could build this string.
    expect(token).not.toContain('stub');
    expect(service.verify(`stub-rtc-token-${CID}`).valid).toBe(false);
    // Nor does the raw id appear anywhere a guesser could exploit.
    expect(token.split('.')[2]).not.toContain(CID);
  });

  it('refuses a token minted for a DIFFERENT consultation', () => {
    const other = 'c0000000-0000-4000-8000-00000000dead';
    const { token } = service.issue(other, UID, 'guest');

    // Signature is valid — it is a real token — but not for this room.
    expect(service.verify(token).valid).toBe(true);
    expect(service.verify(token, { consultationId: CID })).toMatchObject({
      valid: false,
      reason: 'wrong-subject',
    });
  });

  it('refuses a token belonging to a DIFFERENT user', () => {
    const { token } = service.issue(CID, 'u0000000-0000-4000-8000-00000000beef', 'guest');
    expect(service.verify(token, { consultationId: CID, userId: UID })).toMatchObject({
      valid: false,
      reason: 'wrong-subject',
    });
  });

  it('refuses a token signed with a different key', () => {
    const attacker = new JoinTokenService(
      new ConfigService({ JOIN_TOKEN_SECRET: 'b'.repeat(64), JOIN_TOKEN_TTL_SECONDS: 900 }),
    );
    const forged = attacker.issue(CID, UID, 'host').token;
    expect(service.verify(forged)).toMatchObject({ valid: false, reason: 'bad-signature' });
  });

  it('refuses a payload edited to escalate role or extend expiry', () => {
    const { token } = service.issue(CID, UID, 'guest');
    const [version, encoded, signature] = token.split('.');

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.role = 'host';
    payload.exp = Math.floor(Date.now() / 1000) + 86_400;
    const tampered = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    // Old signature over new payload — the MAC covers both fields.
    expect(service.verify(`${version}.${tampered}.${signature}`)).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('expires', () => {
    const shortLived = new JoinTokenService(
      new ConfigService({ JOIN_TOKEN_SECRET: 'a'.repeat(64), JOIN_TOKEN_TTL_SECONDS: 1 }),
    );
    const { token } = shortLived.issue(CID, UID, 'host');

    expect(shortLived.verify(token).valid).toBe(true);
    // Two seconds later the same token is worthless.
    expect(shortLived.verify(token, undefined, new Date(Date.now() + 2_000))).toMatchObject({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects malformed input rather than throwing', () => {
    for (const bad of ['', 'garbage', 'a.b', 'a.b.c.d', 'v9.abc.def', '..']) {
      expect(() => service.verify(bad)).not.toThrow();
      expect(service.verify(bad).valid).toBe(false);
    }
    expect(service.verify('v1.!!!notbase64!!!.xxx').valid).toBe(false);
  });

  it('mints a distinct token each time, so one cannot be correlated to another', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => service.issue(CID, UID, 'host').token));
    expect(tokens.size).toBe(100);
  });

  it('falls back to the prescription signing key when no dedicated secret is set', () => {
    const fallback = new JoinTokenService(new ConfigService({ PRESCRIPTION_SIGNING_KEY: 'c'.repeat(64) }));
    const { token } = fallback.issue(CID, UID, 'host');
    expect(fallback.verify(token, { consultationId: CID, userId: UID }).valid).toBe(true);
    // Distinct key material => the other service cannot verify it.
    expect(service.verify(token).valid).toBe(false);
  });
});
