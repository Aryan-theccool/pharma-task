import { randomUUID } from 'node:crypto';
import {
  bookSlot,
  createDoctorWithSlots,
  createTestApp,
  createUser,
  resetRateLimits,
  type TestContext,
  type TestUser,
} from './helpers/app';
import request from 'supertest';

/**
 * The booking flow is the highest-risk part of the system: it moves money and
 * it is the one place where two users genuinely race for the same row. These
 * tests drive the real HTTP surface against the real database.
 */
describe('booking (integration)', () => {
  let ctx: TestContext;
  let patient: TestUser;
  let slots: Array<{ id: string; startsAt: string }>;

  beforeAll(async () => {
    ctx = await createTestApp();
    const doctor = await createDoctorWithSlots(ctx.server);
    slots = doctor.slots;
    patient = await createUser(ctx.server, 'patient');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetRateLimits(ctx.redis);
  });

  const takeSlot = () => {
    const slot = slots.shift();
    if (!slot) throw new Error('test fixture ran out of slots');
    return slot;
  };

  describe('hold → confirm', () => {
    it('holds a slot and returns a bounded, token-protected reservation', async () => {
      const slot = takeSlot();
      const res = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      expect(res.body.holdToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const { rows } = await ctx.db.query<{ status: string; held_by: string }>(
        'SELECT status, held_by FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(rows[0].status).toBe('held');
      expect(rows[0].held_by).toBe(patient.id);
    });

    it('confirms the hold into a consultation with a captured payment', async () => {
      const slot = takeSlot();
      const { consultationId } = await bookSlot(ctx.server, patient, slot.id);

      const { rows } = await ctx.db.query<{ status: string; slot_id: string }>(
        'SELECT status, slot_id FROM consultations WHERE id = $1',
        [consultationId],
      );
      expect(rows[0].status).toBe('scheduled');
      expect(rows[0].slot_id).toBe(slot.id);

      const payment = await ctx.db.query<{ status: string }>(
        'SELECT status FROM payments WHERE consultation_id = $1',
        [consultationId],
      );
      expect(payment.rows[0].status).toBe('captured');
    });

    it('refuses to confirm with a hold token belonging to someone else', async () => {
      const slot = takeSlot();
      const hold = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      const attacker = await createUser(ctx.server, 'patient');
      // 403, not 404/409: the hold exists, the caller simply has no claim on it.
      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${attacker.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id, holdToken: hold.body.holdToken })
        .expect(403);

      // …and the legitimate holder can still complete the booking afterwards.
      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id, holdToken: hold.body.holdToken })
        .expect(201);
    });

    it('rejects a forged hold token', async () => {
      const slot = takeSlot();
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id, holdToken: randomUUID() })
        .expect(403);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of many simultaneous holds win', async () => {
      const slot = takeSlot();
      const attempts = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(ctx.server)
            .post('/api/v1/bookings/hold')
            .set('Authorization', `Bearer ${patient.token}`)
            .set('Idempotency-Key', randomUUID())
            .send({ slotId: slot.id }),
        ),
      );

      const created = attempts.filter((r) => r.status === 201);
      const conflicts = attempts.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(9);
      // No request may fail for any *other* reason — a 500 here would mean a
      // defence threw instead of degrading to a clean conflict.
      expect(attempts.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    });

    it('never creates two consultations for one slot under a confirm race', async () => {
      const slot = takeSlot();
      const hold = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      // Distinct idempotency keys: the DB constraints, not the cache, must hold.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(ctx.server)
            .post('/api/v1/bookings/confirm')
            .set('Authorization', `Bearer ${patient.token}`)
            .set('Idempotency-Key', randomUUID())
            .send({ slotId: slot.id, holdToken: hold.body.holdToken }),
        ),
      );

      const winners = results.filter((r) => r.status === 201);
      expect(winners).toHaveLength(1);
      // The losing attempts must not have compensated away the winner's slot.
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);

      const { rows } = await ctx.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM consultations WHERE slot_id = $1',
        [slot.id],
      );
      expect(rows[0].count).toBe('1');

      const slotState = await ctx.db.query<{ status: string }>(
        'SELECT status FROM availability_slots WHERE id = $1',
        [slot.id],
      );
      expect(slotState.rows[0].status).toBe('booked');

      // Exactly one payment, and it is not left dangling in `authorized`.
      const payments = await ctx.db.query<{ status: string }>(
        `SELECT p.status FROM payments p WHERE p.consultation_id = $1`,
        [winners[0].body.consultationId],
      );
      expect(payments.rows).toHaveLength(1);
      expect(payments.rows[0].status).toBe('captured');
    });

    it('records which defence layer caught each conflict', async () => {
      const metrics = await request(ctx.server).get('/metrics').expect(200);
      expect(metrics.text).toContain('booking_conflicts_total');
    });
  });

  describe('idempotency', () => {
    it('replays the original response for a repeated key', async () => {
      const slot = takeSlot();
      const hold = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      const key = randomUUID();
      const payload = { slotId: slot.id, holdToken: hold.body.holdToken, chiefComplaint: 'Acidity' };

      const first = await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      const replay = await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send(payload);

      expect(replay.body.consultationId).toBe(first.body.consultationId);
      expect(replay.headers['idempotent-replay']).toBe('true');

      const { rows } = await ctx.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM consultations WHERE slot_id = $1',
        [slot.id],
      );
      expect(rows[0].count).toBe('1');
    });

    it('ignores JSON key order when fingerprinting the payload', async () => {
      const slot = takeSlot();
      const hold = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      const key = randomUUID();
      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: slot.id, holdToken: hold.body.holdToken, chiefComplaint: 'Acidity' })
        .expect(201);

      // Same document, different key order — must replay, not 409.
      const reordered = await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ chiefComplaint: 'Acidity', holdToken: hold.body.holdToken, slotId: slot.id });

      expect(reordered.status).toBeLessThan(300);
      expect(reordered.headers['idempotent-replay']).toBe('true');
    });

    it('rejects the same key with a different payload', async () => {
      const slot = takeSlot();
      const hold = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);

      const key = randomUUID();
      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: slot.id, holdToken: hold.body.holdToken, chiefComplaint: 'First' })
        .expect(201);

      await request(ctx.server)
        .post('/api/v1/bookings/confirm')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: slot.id, holdToken: hold.body.holdToken, chiefComplaint: 'Second' })
        .expect(409);
    });

    it('requires an Idempotency-Key on mutating money endpoints', async () => {
      const slot = takeSlot();
      const res = await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ slotId: slot.id })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/idempotency/i);
    });

    it('scopes keys per user, so one tenant cannot squat another key', async () => {
      const slotA = takeSlot();
      const slotB = takeSlot();
      const other = await createUser(ctx.server, 'patient');
      const key = randomUUID();

      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: slotA.id })
        .expect(201);

      // Same key, different user, different payload → must NOT 409.
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${other.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: slotB.id })
        .expect(201);
    });
  });

  describe('cancellation', () => {
    it('cancels and refunds when outside the cutoff window', async () => {
      const slot = takeSlot();
      const { consultationId } = await bookSlot(ctx.server, patient, slot.id);

      const res = await request(ctx.server)
        .post(`/api/v1/bookings/${consultationId}/cancel`)
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Schedule conflict' })
        .expect(200);

      expect(res.body.refundEligible).toBe(true);

      const { rows } = await ctx.db.query<{ status: string }>(
        'SELECT status FROM consultations WHERE id = $1',
        [consultationId],
      );
      expect(rows[0].status).toBe('cancelled');
    });

    it('releases the slot so another patient can book it', async () => {
      const slot = takeSlot();
      const { consultationId } = await bookSlot(ctx.server, patient, slot.id);
      await request(ctx.server)
        .post(`/api/v1/bookings/${consultationId}/cancel`)
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Changed my mind' })
        .expect(200);

      const nextPatient = await createUser(ctx.server, 'patient');
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${nextPatient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slot.id })
        .expect(201);
    });

    it("forbids cancelling someone else's consultation", async () => {
      const slot = takeSlot();
      const { consultationId } = await bookSlot(ctx.server, patient, slot.id);
      const stranger = await createUser(ctx.server, 'patient');

      const res = await request(ctx.server)
        .post(`/api/v1/bookings/${consultationId}/cancel`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'not mine' });

      expect([403, 404]).toContain(res.status);
    });
  });

  describe('validation', () => {
    it('rejects unknown properties instead of silently ignoring them', async () => {
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: slots[0]?.id ?? randomUUID(), role: 'admin' })
        .expect(400);
    });

    it('rejects a malformed slot id', async () => {
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: 'not-a-uuid' })
        .expect(400);
    });

    it('404s on a well-formed but unknown slot', async () => {
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: randomUUID() })
        .expect(404);
    });

    it('requires authentication', async () => {
      await request(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Idempotency-Key', randomUUID())
        .send({ slotId: randomUUID() })
        .expect(401);
    });
  });
});
