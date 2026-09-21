import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  PASSWORD,
  TestContext,
  api,
  bookSlot,
  createDoctorWithSlots,
  createTestApp,
  createUser,
  freshTotp,
  resetRateLimits,
} from './helpers/app';
import { IntegrityService } from '../../src/modules/integrity/integrity.service';
import { SagaReconcilerService } from '../../src/modules/booking/saga-reconciler.service';

/**
 * Proof that the two controls this suite covers actually work, exercised
 * against the real database rather than a mock.
 *
 * Gap 1 — clinical-row tampering. The audit hash chain protects `audit_logs`
 *         and nothing else, so a database-level write to a clinical table used
 *         to be undetectable. `test/integration/consultation.spec.ts` still
 *         contains the test proving the chain does not cover it; these tests
 *         prove the new control does.
 *
 * Gap 2 — stuck sagas. Compensation only ran when a step threw. A process
 *         killed mid-saga left the slot held and the payment authorized
 *         forever.
 *
 * The "attacker" here is a second pg Client opened WITHOUT the proof option,
 * which is exactly what psql, a BI tool or a leaked credential looks like.
 */
describe('clinical integrity and saga recovery', () => {
  let ctx: TestContext;
  let integrity: IntegrityService;
  let reconciler: SagaReconcilerService;

  /** A raw connection carrying no proof of application origin. */
  const attackerClient = async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    integrity = ctx.app.get(IntegrityService);
    reconciler = ctx.app.get(SagaReconcilerService);
    // Start from a clean journal so counts in assertions are about this suite.
    await ctx.db.query('TRUNCATE clinical_integrity_journal RESTART IDENTITY CASCADE');
    await ctx.db.query('TRUNCATE integrity_checkpoints RESTART IDENTITY CASCADE');
    await ctx.db.query('SELECT * FROM integrity_baseline()');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetRateLimits(ctx.redis);
  });

  // ------------------------------------------------------------- detection

  describe('tamper detection', () => {
    it('reports a clean bill of health when only the application has written', async () => {
      const report = await integrity.verify();
      expect(report.ok).toBe(true);
      expect(report.findings).toHaveLength(0);
    });

    it('records a proof of application origin for writes made through the API', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      const history = await integrity.history('consultations', consultationId);
      expect(history.protected).toBe(true);
      expect(history.entries.length).toBeGreaterThan(0);
      // Every entry for a row the API created must be attributed.
      expect(history.entries.every((e) => e.attributed === true)).toBe(true);

      const report = await integrity.verify();
      expect(report.ok).toBe(true);
    });

    it('DETECTS a direct SQL write to a consultation — the previously accepted gap', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      expect((await integrity.verify()).ok).toBe(true);

      // The attack: change clinical data without going through the application.
      const attacker = await attackerClient();
      await attacker.query(`UPDATE consultations SET chief_complaint = $2 WHERE id = $1`, [
        consultationId,
        'ALTERED EVIDENCE',
      ]);
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);

      const finding = report.findings.find(
        (f) => f.kind === 'unattributed_write' && f.rowId === consultationId,
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('critical');
      expect(finding!.table).toBe('consultations');
      // Forensics an incident responder actually needs.
      expect(finding!.dbUser).toBeTruthy();
      expect(finding!.detail).toMatch(/no proof of application origin/i);
    });

    it('detects a direct SQL write to a payment row', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      await bookSlot(ctx.server, patient, slots[0].id);

      const paymentId = (
        await ctx.db.query<{ id: string }>(`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`)
      ).rows[0].id;

      const attacker = await attackerClient();
      // Marking a payment refunded without refunding it is straightforward fraud.
      await attacker.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [paymentId]);
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.kind === 'unattributed_write' && f.rowId === paymentId)).toBe(
        true,
      );
    });

    it('detects a write made with the capture trigger disabled', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      const attacker = await attackerClient();
      // A sophisticated attacker turns off the recorder first.
      await attacker.query(`ALTER TABLE consultations DISABLE TRIGGER clinical_integrity_consultations`);
      await attacker.query(`UPDATE consultations SET chief_complaint = 'SILENT EDIT' WHERE id = $1`, [
        consultationId,
      ]);
      // ...and turns it back on to cover their tracks.
      await attacker.query(`ALTER TABLE consultations ENABLE TRIGGER clinical_integrity_consultations`);
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);

      // The live row no longer hashes to what was last journaled.
      const finding = report.findings.find((f) => f.kind === 'divergent_row' && f.rowId === consultationId);
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('critical');
    });

    it('reports protection that is currently disabled', async () => {
      const attacker = await attackerClient();
      await attacker.query(`ALTER TABLE prescriptions DISABLE TRIGGER clinical_integrity_prescriptions`);

      try {
        const report = await integrity.verify();
        const finding = report.findings.find(
          (f) => f.kind === 'protection_disabled' && f.table === 'prescriptions',
        );
        expect(finding).toBeDefined();
        expect(finding!.detail).toMatch(/not being recorded/i);
      } finally {
        await attacker.query(`ALTER TABLE prescriptions ENABLE TRIGGER clinical_integrity_prescriptions`);
        await attacker.end();
      }
    });

    it('detects an in-place edit of a journal entry', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      const journalId = (
        await ctx.db.query<{ id: string }>(
          `SELECT id FROM clinical_integrity_journal
            WHERE table_name = 'consultations' AND row_id = $1
            ORDER BY id DESC LIMIT 1`,
          [consultationId],
        )
      ).rows[0].id;

      const attacker = await attackerClient();
      // Rewriting the recorded digest to match a tampered row.
      await attacker.query(
        `UPDATE clinical_integrity_journal SET row_digest = digest('forged', 'sha256') WHERE id = $1`,
        [journalId],
      );
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((f) => f.kind === 'forged_journal_entry' && f.journalId === journalId),
      ).toBe(true);
    });

    it('detects deletion of journal entries once a checkpoint has sealed them', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      // Seal everything written so far.
      const sealed = await integrity.checkpoint();
      expect(sealed.created).toBe(true);

      const journalId = (
        await ctx.db.query<{ id: string }>(
          `SELECT id FROM clinical_integrity_journal
            WHERE table_name = 'consultations' AND row_id = $1
            ORDER BY id DESC LIMIT 1`,
          [consultationId],
        )
      ).rows[0].id;

      const attacker = await attackerClient();
      // Destroying the evidence rather than altering it.
      await attacker.query(`DELETE FROM clinical_integrity_journal WHERE id = $1`, [journalId]);
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.kind === 'checkpoint_mismatch')).toBe(true);
    });

    it('cannot be silenced by an attacker minting their own proof without the key', async () => {
      const { slots } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const { consultationId } = await bookSlot(ctx.server, patient, slots[0].id);

      const attacker = new Client({
        connectionString: process.env.DATABASE_URL,
        // A plausible-looking but unsigned token.
        options: '-c amrutam.proof=v1.9999999999.deadbeefdeadbeefdeadbeef.abc123',
      });
      await attacker.connect();
      await attacker.query(`UPDATE consultations SET chief_complaint = 'FORGED PROOF' WHERE id = $1`, [
        consultationId,
      ]);
      await attacker.end();

      const report = await integrity.verify();
      expect(report.ok).toBe(false);
      const finding = report.findings.find(
        (f) => f.kind === 'unattributed_write' && f.rowId === consultationId,
      );
      expect(finding).toBeDefined();
      expect(finding!.detail).toMatch(/failed verification/i);
    });
  });

  // -------------------------------------------------------------- endpoint

  describe('admin endpoint', () => {
    const adminSession = async () => {
      const admin = await createUser(ctx.server, 'patient', { mfa: true });
      await ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
      await resetRateLimits(ctx.redis);
      const code = await freshTotp(admin.totpSecret!, admin.spentTotp);
      const login = await api(ctx.server)
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: PASSWORD, totp: code })
        .expect(200);
      return login.body.accessToken as string;
    };

    it('exposes the report to an MFA-authenticated admin', async () => {
      const token = await adminSession();
      const res = await api(ctx.server)
        .get('/api/v1/admin/integrity/verify')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveProperty('ok');
      expect(res.body).toHaveProperty('summary.unattributed_write');
      expect(res.body).toHaveProperty('journalEntries');
    });

    it('refuses a patient — the report maps exactly what an attacker touched', async () => {
      const patient = await createUser(ctx.server, 'patient');
      await api(ctx.server)
        .get('/api/v1/admin/integrity/verify')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await api(ctx.server).get('/api/v1/admin/integrity/verify').expect(401);
    });
  });

  // ------------------------------------------------------------- saga recovery

  describe('stuck saga recovery', () => {
    /**
     * Simulate a process killed mid-saga: the saga row is left 'running' with
     * its compensations recorded, the slot stays held, and the payment stays
     * authorized. Nothing rolls it back, because the catch block never ran.
     */
    const abandonSaga = async (opts: {
      slotId: string;
      patientId: string;
      doctorId: string;
      paymentId?: string;
      compensations: string[];
      ageMinutes?: number;
    }) => {
      const bookingRef = randomUUID();
      const res = await ctx.db.query<{ id: string }>(
        `INSERT INTO saga_instances (type, state, step, payload, completed_steps, compensations, updated_at)
         VALUES ('booking.confirm', 'running', 'authorize_payment', $1::jsonb, $2::jsonb, $3::jsonb,
                 now() - ($4 || ' minutes')::interval)
         RETURNING id`,
        [
          JSON.stringify({
            slotId: opts.slotId,
            patientId: opts.patientId,
            doctorId: opts.doctorId,
            bookingRef,
            ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
          }),
          JSON.stringify(['validate_hold']),
          JSON.stringify(opts.compensations),
          String(opts.ageMinutes ?? 30),
        ],
      );
      return res.rows[0].id;
    };

    it('releases a slot left held by a crashed process', async () => {
      const { slots, doctorId } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const slotId = slots[0].id;

      // Hold the slot, then abandon the saga as if the pod died.
      await api(ctx.server)
        .post('/api/v1/bookings/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ slotId })
        .expect(201);

      const sagaId = await abandonSaga({
        slotId,
        patientId: patient.id,
        doctorId,
        compensations: [],
      });

      expect(
        (await ctx.db.query(`SELECT status FROM availability_slots WHERE id = $1`, [slotId])).rows[0].status,
      ).toBe('held');

      const result = await reconciler.reconcile();
      expect(result.recovered).toBeGreaterThanOrEqual(1);

      // The slot is back in the pool and the saga reached a terminal state.
      expect(
        (await ctx.db.query(`SELECT status FROM availability_slots WHERE id = $1`, [slotId])).rows[0].status,
      ).toBe('available');
      expect(
        (await ctx.db.query(`SELECT state FROM saga_instances WHERE id = $1`, [sagaId])).rows[0].state,
      ).toBe('compensated');
    });

    it('refunds a captured payment stranded by a crash', async () => {
      const { slots, doctorId } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const slotId = slots[1].id;

      const payment = await ctx.db.query<{ id: string }>(
        `INSERT INTO payments (patient_id, amount, currency, status, provider, provider_ref, booking_ref)
         VALUES ($1, 800, 'INR', 'captured', 'mock', $2, gen_random_uuid())
         RETURNING id`,
        [patient.id, `mock_${randomUUID()}`],
      );
      const paymentId = payment.rows[0].id;

      await abandonSaga({
        slotId,
        patientId: patient.id,
        doctorId,
        paymentId,
        compensations: ['void_payment', 'cancel_consultation', 'refund_payment'],
      });

      await reconciler.reconcile();

      const after = await ctx.db.query<{ status: string; refunded_amount: string }>(
        `SELECT status, refunded_amount FROM payments WHERE id = $1`,
        [paymentId],
      );
      expect(after.rows[0].status).toBe('refunded');
      expect(Number(after.rows[0].refunded_amount)).toBe(800);
    });

    it('leaves a fresh in-flight saga alone', async () => {
      const { slots, doctorId } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');

      // Updated seconds ago — a booking legitimately in progress.
      const sagaId = await abandonSaga({
        slotId: slots[2].id,
        patientId: patient.id,
        doctorId,
        compensations: [],
        ageMinutes: 0,
      });

      await reconciler.reconcile();

      expect(
        (await ctx.db.query(`SELECT state FROM saga_instances WHERE id = $1`, [sagaId])).rows[0].state,
      ).toBe('running');
    });

    it('is idempotent — a second pass changes nothing', async () => {
      const { slots, doctorId } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');

      await abandonSaga({
        slotId: slots[3].id,
        patientId: patient.id,
        doctorId,
        compensations: [],
      });

      const first = await reconciler.reconcile();
      expect(first.recovered).toBeGreaterThanOrEqual(1);

      // Nothing stale is left, so the second pass finds no work.
      const second = await reconciler.reconcile();
      expect(second.recovered).toBe(0);
      expect(second.scanned).toBe(0);
    });

    it('never cancels a consultation the patient already attended', async () => {
      const { slots, doctorId } = await createDoctorWithSlots(ctx.server);
      const patient = await createUser(ctx.server, 'patient');
      const slotId = slots[4].id;
      const { consultationId } = await bookSlot(ctx.server, patient, slotId);

      // The consultation went ahead even though the saga row was orphaned.
      await ctx.db.query(`UPDATE consultations SET status = 'completed' WHERE id = $1`, [consultationId]);

      await abandonSaga({
        slotId,
        patientId: patient.id,
        doctorId,
        compensations: ['cancel_consultation'],
      });

      await reconciler.reconcile();

      // Compensation is conditional on 'scheduled', so history is preserved.
      expect(
        (await ctx.db.query(`SELECT status FROM consultations WHERE id = $1`, [consultationId])).rows[0]
          .status,
      ).toBe('completed');
    });

    it('dead-letters a saga it has no strategy for, rather than retrying forever', async () => {
      const res = await ctx.db.query<{ id: string }>(
        `INSERT INTO saga_instances (type, state, step, payload, updated_at)
         VALUES ('unknown.saga', 'running', 'mystery', '{}'::jsonb, now() - interval '30 minutes')
         RETURNING id`,
      );
      const sagaId = res.rows[0].id;

      await reconciler.reconcile();

      const after = await ctx.db.query<{ state: string; last_error: string }>(
        `SELECT state, last_error FROM saga_instances WHERE id = $1`,
        [sagaId],
      );
      expect(after.rows[0].state).toBe('dead_letter');
      expect(after.rows[0].last_error).toMatch(/no recovery strategy/i);

      const parked = await reconciler.deadLetters();
      expect(parked.some((p: { id: string }) => p.id === sagaId)).toBe(true);
    });
  });
});
