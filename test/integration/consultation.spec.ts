import { randomUUID } from 'node:crypto';
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

describe('consultations & prescriptions (integration)', () => {
  let ctx: TestContext;
  let patient: TestUser;
  let doctor: TestUser;
  let slots: Array<{ id: string; startsAt: string }>;

  beforeAll(async () => {
    ctx = await createTestApp();
    const fixture = await createDoctorWithSlots(ctx.server);
    doctor = fixture.user;
    slots = fixture.slots;
    patient = await createUser(ctx.server, 'patient');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetRateLimits(ctx.redis);
  });

  const nextConsultation = async () => {
    const slot = slots.shift();
    if (!slot) throw new Error('fixture ran out of slots');
    const { consultationId } = await bookSlot(ctx.server, patient, slot.id);
    return consultationId;
  };

  const asDoctor = (method: 'post' | 'patch' | 'get', path: string) =>
    request(ctx.server)[method](path).set('Authorization', `Bearer ${doctor.token}`);

  describe('state machine', () => {
    it('walks the full happy path scheduled → in_progress → completed', async () => {
      const id = await nextConsultation();

      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);
      await asDoctor('post', `/api/v1/consultations/${id}/complete`).expect(200);

      const { rows } = await ctx.db.query<{ status: string; started_at: Date; ended_at: Date }>(
        'SELECT status, started_at, ended_at FROM consultations WHERE id = $1',
        [id],
      );
      expect(rows[0].status).toBe('completed');
      expect(rows[0].started_at).toBeInstanceOf(Date);
      expect(rows[0].ended_at).toBeInstanceOf(Date);
    });

    it('refuses to complete a consultation that never started', async () => {
      const id = await nextConsultation();
      const res = await asDoctor('post', `/api/v1/consultations/${id}/complete`).expect(409);
      // The error must tell the caller what *is* allowed.
      expect(JSON.stringify(res.body)).toMatch(/in_progress|cancelled|no_show/);
    });

    it('refuses to re-enter a state', async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(409);
    });

    it('treats completed as terminal', async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);
      await asDoctor('post', `/api/v1/consultations/${id}/complete`).expect(200);
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(409);
      await asDoctor('post', `/api/v1/consultations/${id}/no-show`).expect(409);
    });

    it('lets the doctor mark a no-show from scheduled', async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/no-show`).expect(200);
    });
  });

  describe('clinical notes', () => {
    it('are writable only by the treating doctor', async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);

      const otherDoctor = await createDoctorWithSlots(ctx.server, { mfa: false });
      await request(ctx.server)
        .patch(`/api/v1/consultations/${id}/notes`)
        .set('Authorization', `Bearer ${otherDoctor.user.token}`)
        .send({ notes: 'I am not the treating physician' })
        .expect(403);

      await request(ctx.server)
        .patch(`/api/v1/consultations/${id}/notes`)
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ notes: 'I am the patient' })
        .expect(403);
    });

    it('round-trip through encryption without corruption', async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);

      const notes = 'Patient reports 70% improvement. Continue Triphala. ☘ ünïcode ok.';
      await asDoctor('patch', `/api/v1/consultations/${id}/notes`).send({ notes }).expect(200);

      const res = await asDoctor('get', `/api/v1/consultations/${id}`).expect(200);
      expect(res.body.notes).toBe(notes);
    });
  });

  describe('prescriptions', () => {
    const rxBody = {
      items: [{ drug: 'Triphala Churna', dosage: '5 g', frequency: 'Twice daily', duration: '14 days' }],
      diagnosis: 'Functional dyspepsia',
      advice: 'Avoid cold drinks.',
    };

    const startedConsultation = async () => {
      const id = await nextConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/start`).expect(200);
      return id;
    };

    it('can only be issued by the treating doctor', async () => {
      const id = await startedConsultation();
      await request(ctx.server)
        .post(`/api/v1/consultations/${id}/prescriptions`)
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(403);
    });

    it('signs, verifies and becomes immutable', async () => {
      const id = await startedConsultation();
      const created = await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(201);

      const rxId = created.body.id;
      const signed = await asDoctor('post', `/api/v1/prescriptions/${rxId}/sign`)
        .set('Idempotency-Key', randomUUID())
        .expect(201);

      expect(signed.body.signatureAlg).toBe('HMAC-SHA256');
      expect(signed.body.signature).toMatch(/^[0-9a-f]{64}$/);

      const verified = await asDoctor('get', `/api/v1/prescriptions/${rxId}/verify`).expect(200);
      expect(verified.body.valid).toBe(true);

      // Signed prescriptions are a legal record: no re-signing, no edits.
      await asDoctor('post', `/api/v1/prescriptions/${rxId}/sign`)
        .set('Idempotency-Key', randomUUID())
        .expect(409);

      const { rows } = await ctx.db.query<{ immutable: boolean }>(
        'SELECT immutable FROM prescriptions WHERE id = $1',
        [rxId],
      );
      expect(rows[0].immutable).toBe(true);
    });

    it('detects tampering with the signed content', async () => {
      const id = await startedConsultation();
      const created = await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(201);
      const rxId = created.body.id;
      await asDoctor('post', `/api/v1/prescriptions/${rxId}/sign`)
        .set('Idempotency-Key', randomUUID())
        .expect(201);

      // Simulate a database-level tamper, bypassing the API entirely.
      await ctx.db.query(`UPDATE prescriptions SET diagnosis_enc = $2 WHERE id = $1`, [
        rxId,
        // Re-encrypt different text using the app's own key by round-tripping a
        // known-good ciphertext from another row would be brittle; instead null
        // the field, which must also invalidate the signature.
        null,
      ]);

      const verified = await asDoctor('get', `/api/v1/prescriptions/${rxId}/verify`).expect(200);
      expect(verified.body.valid).toBe(false);
    });

    it('stores prescription content encrypted at rest', async () => {
      const id = await startedConsultation();
      const created = await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(201);

      const { rows } = await ctx.db.query<{ items_enc: Buffer; diagnosis_enc: Buffer }>(
        'SELECT items_enc, diagnosis_enc FROM prescriptions WHERE id = $1',
        [created.body.id],
      );
      expect(rows[0].items_enc.toString('utf8')).not.toContain('Triphala');
      expect(rows[0].diagnosis_enc.toString('utf8')).not.toContain('dyspepsia');
    });

    it('requires at least one item', async () => {
      const id = await startedConsultation();
      await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...rxBody, items: [] })
        .expect(400);
    });

    it('is visible to the patient it was written for, and to nobody else', async () => {
      const id = await startedConsultation();
      const created = await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(201);

      await request(ctx.server)
        .get(`/api/v1/prescriptions/${created.body.id}`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);

      const stranger = await createUser(ctx.server, 'patient');
      await request(ctx.server)
        .get(`/api/v1/prescriptions/${created.body.id}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    });

    it('withholds the PDF until the worker has rendered it', async () => {
      const id = await startedConsultation();
      const created = await asDoctor('post', `/api/v1/consultations/${id}/prescriptions`)
        .set('Idempotency-Key', randomUUID())
        .send(rxBody)
        .expect(201);

      // Workers are disabled in this project, so the PDF can never become ready:
      // the endpoint must say "not yet", not 404 or 500.
      await asDoctor('get', `/api/v1/prescriptions/${created.body.id}/pdf`).expect(409);
    });
  });

  describe('history', () => {
    it("lists the caller's own consultations only", async () => {
      const id = await nextConsultation();

      const mine = await request(ctx.server)
        .get('/api/v1/me/consultations')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);
      expect(mine.body.items.some((c: { id: string }) => c.id === id)).toBe(true);

      const stranger = await createUser(ctx.server, 'patient');
      const theirs = await request(ctx.server)
        .get('/api/v1/me/consultations')
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);
      expect(theirs.body.items).toHaveLength(0);
    });
  });
});
