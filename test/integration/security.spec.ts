import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bookSlot,
  createDoctorWithSlots,
  createTestApp,
  createUser,
  resetRateLimits,
  type TestContext,
  type TestUser,
} from './helpers/app';

/**
 * The assignment fails outright on missing critical security, so these are
 * expressed as attacks rather than as happy paths: each test plays the part of
 * an adversary and asserts that the system refuses.
 */
describe('security (integration)', () => {
  let ctx: TestContext;
  let patient: TestUser;
  let doctor: TestUser;
  let doctorId: string;
  let consultationId: string;
  let slots: Array<{ id: string; startsAt: string }>;

  beforeAll(async () => {
    ctx = await createTestApp();
    const fixture = await createDoctorWithSlots(ctx.server);
    doctor = fixture.user;
    doctorId = fixture.doctorId;
    slots = fixture.slots;
    patient = await createUser(ctx.server, 'patient');
    ({ consultationId } = await bookSlot(ctx.server, patient, slots.shift()!.id));
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetRateLimits(ctx.redis);
  });

  describe('authentication (OWASP A07)', () => {
    it('rejects requests with no credentials', async () => {
      await request(ctx.server).get('/api/v1/me').expect(401);
    });

    it('rejects a structurally invalid token', async () => {
      await request(ctx.server).get('/api/v1/me').set('Authorization', 'Bearer nonsense').expect(401);
    });

    it('rejects a token signed with the wrong key', async () => {
      const [header, payload] = patient.token.split('.');
      const forgedSignature = createHmac('sha256', 'attacker-key')
        .update(`${header}.${payload}`)
        .digest('base64url');

      await request(ctx.server)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${header}.${payload}.${forgedSignature}`)
        .expect(401);
    });

    it('rejects the "alg: none" downgrade', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: patient.id, role: 'admin', mfa: true, exp: 9_999_999_999 }),
      ).toString('base64url');

      await request(ctx.server)
        .get('/api/v1/admin/analytics/overview')
        .set('Authorization', `Bearer ${header}.${payload}.`)
        .expect(401);
    });

    it('rejects a token whose role claim has been tampered with', async () => {
      const [header, , signature] = patient.token.split('.');
      const escalated = Buffer.from(
        JSON.stringify({ sub: patient.id, role: 'admin', mfa: true, exp: 9_999_999_999 }),
      ).toString('base64url');

      await request(ctx.server)
        .get('/api/v1/admin/analytics/overview')
        .set('Authorization', `Bearer ${header}.${escalated}.${signature}`)
        .expect(401);
    });
  });

  describe('authorization (OWASP A01)', () => {
    it('blocks a patient from admin analytics', async () => {
      await request(ctx.server)
        .get('/api/v1/admin/analytics/overview')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(403);
    });

    it('blocks a patient from the audit trail', async () => {
      await request(ctx.server)
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(403);
    });

    it('blocks a patient from driving clinical state', async () => {
      await request(ctx.server)
        .post(`/api/v1/consultations/${consultationId}/start`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(403);
    });

    it("hides another patient's consultation (BOLA)", async () => {
      const stranger = await createUser(ctx.server, 'patient');
      await request(ctx.server)
        .get(`/api/v1/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404); // 404 not 403 — do not confirm the resource exists
    });

    it("blocks writing to another doctor's profile", async () => {
      const otherDoctor = await createDoctorWithSlots(ctx.server, { mfa: false });
      await request(ctx.server)
        .patch(`/api/v1/doctors/${doctorId}`)
        .set('Authorization', `Bearer ${otherDoctor.user.token}`)
        .send({ bio: 'hijacked' })
        .expect(403);
    });

    it('prevents a doctor from self-verifying', async () => {
      await request(ctx.server)
        .patch(`/api/v1/doctors/${doctorId}`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({ verificationState: 'verified' })
        .expect(403);
    });

    it('requires step-up MFA for admin analytics even with the admin role', async () => {
      const admin = await createUser(ctx.server, 'patient');
      await ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);

      // Re-login to pick up the elevated role without an MFA factor.
      const session = await request(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: 'Str0ng!Passphrase2024' })
        .expect(200);

      await request(ctx.server)
        .get('/api/v1/admin/analytics/overview')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .expect(403);
    });
  });

  describe('injection (OWASP A03)', () => {
    it.each([
      "'; DROP TABLE users; --",
      "' OR '1'='1",
      "admin'--",
      '1; DELETE FROM consultations WHERE 1=1; --',
    ])('treats %s as an ordinary search string', async (payload) => {
      const res = await request(ctx.server).get('/api/v1/doctors/search').query({ q: payload }).expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('still has its tables after the injection attempts', async () => {
      const { rows } = await ctx.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('users','consultations')`,
      );
      expect(rows[0].count).toBe('2');
    });

    it('rejects an oversized payload rather than buffering it', async () => {
      await request(ctx.server)
        .post('/api/v1/auth/register')
        .send({
          email: `big-${randomUUID()}@amrutam.test`,
          password: 'Str0ng!Passphrase2024',
          fullName: 'x'.repeat(200_000),
        })
        .expect((res) => {
          expect([400, 413]).toContain(res.status);
        });
    });
  });

  describe('webhook forgery', () => {
    const post = (headers: Record<string, string>, body: string) =>
      request(ctx.server)
        .post('/api/v1/payments/webhook')
        .set('Content-Type', 'application/json')
        .set(headers)
        .send(body);

    const secret = () => process.env.PAYMENT_WEBHOOK_SECRET!;
    const sign = (ts: string, body: string) =>
      createHmac('sha256', secret()).update(`${ts}.${body}`).digest('hex');

    it('accepts a correctly signed event exactly once', async () => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.captured' });

      const first = await post({ 'X-Signature': sign(ts, body), 'X-Timestamp': ts }, body).expect(200);
      expect(first.body.duplicate).toBe(false);

      const replay = await post({ 'X-Signature': sign(ts, body), 'X-Timestamp': ts }, body).expect(200);
      expect(replay.body.duplicate).toBe(true);
    });

    it('rejects a forged signature', async () => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.captured' });
      await post({ 'X-Signature': 'f'.repeat(64), 'X-Timestamp': ts }, body).expect(403);
    });

    it('rejects a missing signature without disclosing which check failed', async () => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.captured' });

      const missing = await post({ 'X-Timestamp': ts }, body).expect(403);
      const forged = await post({ 'X-Signature': 'f'.repeat(64), 'X-Timestamp': ts }, body).expect(403);
      expect(missing.body.title).toBe(forged.body.title);
    });

    it('rejects a replayed-but-stale timestamp', async () => {
      const stale = Math.floor(Date.now() / 1000 - 3_600).toString();
      const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.captured' });
      await post({ 'X-Signature': sign(stale, body), 'X-Timestamp': stale }, body).expect(400);
    });

    it('rejects a body altered after signing', async () => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const signed = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.captured' });
      const tampered = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.refunded' });
      await post({ 'X-Signature': sign(ts, signed), 'X-Timestamp': ts }, tampered).expect(403);
    });
  });

  describe('transport and headers', () => {
    it('sets the expected hardening headers', async () => {
      const res = await request(ctx.server).get('/healthz').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('echoes a correlation id on every response', async () => {
      const res = await request(ctx.server).get('/healthz').expect(200);
      expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    });

    it('never caches PHI responses', async () => {
      const res = await request(ctx.server)
        .get(`/api/v1/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    });
  });

  describe('error handling', () => {
    it('returns RFC 7807 problem documents', async () => {
      const res = await request(ctx.server).get('/api/v1/me').expect(401);
      expect(res.body).toMatchObject({
        type: expect.any(String),
        title: expect.any(String),
        status: 401,
        instance: '/api/v1/me',
      });
      expect(res.body.requestId).toBeDefined();
    });

    it('never leaks a stack trace or SQL to the client', async () => {
      const res = await request(ctx.server)
        .get(`/api/v1/consultations/${randomUUID()}`)
        .set('Authorization', `Bearer ${patient.token}`);

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toMatch(/at \w+ \(/); // stack frames
      expect(serialised).not.toMatch(/SELECT .* FROM/i);
      expect(serialised).not.toContain('node_modules');
    });
  });

  describe('rate limiting', () => {
    it('throttles credential stuffing and advertises Retry-After', async () => {
      const email = `stuff-${randomUUID()}@amrutam.test`;
      let throttled: request.Response | undefined;

      for (let i = 0; i < 25; i++) {
        const res = await request(ctx.server)
          .post('/api/v1/auth/login')
          .send({ email, password: `Wr0ng!Passphrase${i}` });
        if (res.status === 429) {
          throttled = res;
          break;
        }
      }

      expect(throttled).toBeDefined();
      expect(throttled!.headers['retry-after']).toBeDefined();
      expect(Number(throttled!.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('data protection', () => {
    it('encrypts clinical notes at rest', async () => {
      const note = `secret-note-${randomUUID()}`;
      await request(ctx.server)
        .post(`/api/v1/consultations/${consultationId}/start`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .expect(200);
      await request(ctx.server)
        .patch(`/api/v1/consultations/${consultationId}/notes`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({ notes: note })
        .expect(200);

      const { rows } = await ctx.db.query<{ notes_enc: Buffer | null }>(
        'SELECT notes_enc FROM consultations WHERE id = $1',
        [consultationId],
      );
      expect(rows[0].notes_enc).toBeInstanceOf(Buffer);
      expect(rows[0].notes_enc!.toString('utf8')).not.toContain(note);
    });

    it('records the key version so rotation stays online', async () => {
      const { rows } = await ctx.db.query<{ key_version: number }>(
        'SELECT key_version FROM users WHERE id = $1',
        [patient.id],
      );
      expect(rows[0].key_version).toBeGreaterThanOrEqual(1);
    });
  });
});
