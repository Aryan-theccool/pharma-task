import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  freshTotp,
  resetRateLimits,
  PASSWORD,
  type TestContext,
} from './helpers/app';

describe('auth (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetRateLimits(ctx.redis);
  });

  describe('registration', () => {
    it('creates a patient and never echoes the password back', async () => {
      const email = `reg-${randomUUID()}@amrutam.test`;
      const res = await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, fullName: 'Asha Patel' })
        .expect(201);

      expect(res.body).toMatchObject({ email, role: 'patient', mfaEnabled: false });
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
      expect(res.body.passwordHash).toBeUndefined();
    });

    it('stores the email encrypted, not in plaintext', async () => {
      const email = `enc-${randomUUID()}@amrutam.test`;
      const res = await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, fullName: 'Encrypted User' })
        .expect(201);

      const { rows } = await ctx.db.query<{ email_enc: Buffer; email_hash: string }>(
        'SELECT email_enc, email_hash FROM users WHERE id = $1',
        [res.body.id],
      );
      expect(rows[0].email_enc.toString('utf8')).not.toContain(email);
      expect(rows[0].email_hash).not.toContain(email);
    });

    it('refuses to mint a privileged role from public input', async () => {
      await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({
          email: `esc-${randomUUID()}@amrutam.test`,
          password: PASSWORD,
          fullName: 'Escalate',
          role: 'admin',
        })
        .expect(400);
    });

    it('does not disclose whether an email is already registered', async () => {
      const email = `dup-${randomUUID()}@amrutam.test`;
      await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, fullName: 'First' })
        .expect(201);

      const duplicate = await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, fullName: 'Second' })
        .expect(409);

      // The message must be generic — no "email already exists".
      expect(JSON.stringify(duplicate.body).toLowerCase()).not.toContain('already');
      expect(JSON.stringify(duplicate.body)).not.toContain(email);
    });

    it.each(['short1!A', 'nouppercase1!', 'NOLOWERCASE1!', 'NoDigitsHere!', 'NoSymbols1234'])(
      'rejects the weak password %s',
      async (password) => {
        await request(ctx.server)
          .post('/api/v1/auth/register')
          .send({ email: `weak-${randomUUID()}@amrutam.test`, password, fullName: 'Weak' })
          .expect(400);
      },
    );
  });

  describe('login', () => {
    it('issues an access token carrying the expected claims', async () => {
      const user = await createUser(ctx.server, 'patient');
      const [, payloadB64] = user.token.split('.');
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      expect(claims).toMatchObject({ sub: user.id, role: 'patient', mfa: false });
      expect(claims.amr).toEqual(['pwd']);
      expect(claims.sid).toBeDefined();
      // Short-lived: 10 minutes.
      expect(claims.exp - claims.iat).toBe(600);
    });

    it('gives the same generic error for a bad password and an unknown user', async () => {
      const user = await createUser(ctx.server, 'patient');

      const wrongPassword = await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'Wr0ng!Passphrase2024' })
        .expect(401);

      const unknownUser = await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: `ghost-${randomUUID()}@amrutam.test`, password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.title).toBe(unknownUser.body.title);
    });

    it('locks the account after repeated failures', async () => {
      const user = await createUser(ctx.server, 'patient');
      let locked = false;

      for (let i = 0; i < 6; i++) {
        const res = await request(ctx.server)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: 'Wr0ng!Passphrase2024' });
        if (res.status === 423 || /lock/i.test(JSON.stringify(res.body))) locked = true;
      }
      expect(locked).toBe(true);

      // Even the *correct* password is refused while the lockout stands.
      const afterLock = await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD });
      expect(afterLock.status).not.toBe(200);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates the refresh token on every use', async () => {
      const user = await createUser(ctx.server, 'patient');
      const res = await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);

      expect(res.body.refreshToken).not.toBe(user.refreshToken);
      expect(res.body.accessToken).toBeDefined();
    });

    it('detects reuse and revokes the whole token family', async () => {
      const user = await createUser(ctx.server, 'patient');
      const rotated = await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);

      // Replaying the consumed token is the classic stolen-token signal.
      await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);

      // …and it must also burn the descendant that the thief may hold.
      await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);

      const { rows } = await ctx.db.query<{ revoked_reason: string | null }>(
        `SELECT revoked_reason FROM refresh_tokens WHERE user_id = $1 AND revoked_reason IS NOT NULL`,
        [user.id],
      );
      expect(rows.some((r) => r.revoked_reason === 'reuse_detected')).toBe(true);
    });

    it('rejects a syntactically valid but forged refresh token', async () => {
      await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: `${randomUUID()}.${Buffer.from(randomUUID()).toString('base64url')}` })
        .expect(401);
    });
  });

  describe('multi-factor authentication', () => {
    it('requires the TOTP code once enrolled', async () => {
      const user = await createUser(ctx.server, 'patient', { mfa: true });

      await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(401);

      // The enrolment step already spent a code; replay protection means we
      // must wait for the next 30s window rather than regenerate the same one.
      await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({
          email: user.email,
          password: PASSWORD,
          totp: await freshTotp(user.totpSecret!, user.spentTotp),
        })
        .expect(200);
    });

    it('marks the session as MFA-backed in the token claims', async () => {
      const user = await createUser(ctx.server, 'patient', { mfa: true });
      const claims = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString());
      expect(claims.mfa).toBe(true);
      expect(claims.amr).toEqual(expect.arrayContaining(['pwd', 'mfa']));
    });

    it('refuses to accept the same TOTP code twice', async () => {
      const user = await createUser(ctx.server, 'patient', { mfa: true });
      const code = await freshTotp(user.totpSecret!, user.spentTotp);

      await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD, totp: code })
        .expect(200);

      // Replay within the same 30s step must be rejected.
      await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD, totp: code })
        .expect(401);
    });

    it('rejects an incorrect TOTP code', async () => {
      const user = await createUser(ctx.server, 'patient', { mfa: true });
      await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD, totp: '000000' })
        .expect(401);
    });

    it('stores the TOTP secret encrypted', async () => {
      const user = await createUser(ctx.server, 'patient', { mfa: true });
      const { rows } = await ctx.db.query<{ mfa_secret_enc: Buffer }>(
        'SELECT mfa_secret_enc FROM users WHERE id = $1',
        [user.id],
      );
      expect(rows[0].mfa_secret_enc).toBeInstanceOf(Buffer);
      expect(rows[0].mfa_secret_enc.toString('utf8')).not.toContain(user.totpSecret!);
    });
  });

  describe('session teardown', () => {
    it('invalidates the refresh token on logout', async () => {
      const user = await createUser(ctx.server, 'patient');
      await request(ctx.server)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ refreshToken: user.refreshToken })
        .expect(204);

      await request(ctx.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });
  });
});
