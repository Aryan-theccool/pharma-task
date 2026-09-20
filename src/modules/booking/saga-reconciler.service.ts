import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../infra/database.service';
import { PaymentsService } from '../payments/payments.service';
import { AvailabilityService } from '../availability/availability.service';
import { AuditService } from '../audit/audit.service';
import { metrics } from '../../observability/metrics';
import { withSpan } from '../../observability/tracing';

interface StuckSaga {
  id: string;
  type: string;
  state: string;
  step: string | null;
  payload: Record<string, unknown>;
  completed_steps: string[];
  compensations: string[];
  recovery_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeadLetteredSaga {
  id: string;
  type: string;
  step: string | null;
  payload: Record<string, unknown>;
  last_error: string | null;
  recovery_attempts: number;
  created_at: Date;
  dead_lettered_at: Date;
}

export interface ReconcileResult {
  scanned: number;
  recovered: number;
  deadLettered: number;
  skipped: number;
  details: Array<{ sagaId: string; action: string; reason: string }>;
}

/**
 * Recovers sagas abandoned by a crashed process.
 *
 * The in-request compensation path only runs when a step *throws*. If the
 * process dies mid-saga — OOM kill, SIGKILL, node eviction — nothing runs: the
 * payment stays authorized, the slot stays held, and `saga_instances` keeps a
 * row in 'running' forever. That was the documented gap this closes.
 *
 * Design decisions that matter:
 *
 * 1. **Roll back, never roll forward.** A stuck booking is compensated, not
 *    completed. Completing would mean charging a patient for a consultation
 *    they were never told they had. Refunding a patient who did get their
 *    booking is recoverable; silently charging one is not.
 *
 * 2. **Recovery is idempotent.** Every compensation is expressed as a
 *    conditional UPDATE (`WHERE status = ...`) or a provider call carrying a
 *    deterministic idempotency key, so running it twice is the same as once.
 *    Two replicas reconciling simultaneously cannot double-refund.
 *
 * 3. **Claim before acting.** A saga is claimed with `FOR UPDATE SKIP LOCKED`
 *    and its state moved to 'compensating' in the same transaction, so a second
 *    replica skips it instead of racing.
 *
 * 4. **Give up loudly.** After `maxAttempts` the saga moves to 'dead_letter'
 *    and a gauge rises; it is never retried silently forever. A human gets a
 *    bounded, named list rather than an unbounded backlog.
 */
@Injectable()
export class SagaReconcilerService {
  private readonly logger = new Logger(SagaReconcilerService.name);
  private readonly stuckAfterMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly payments: PaymentsService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.stuckAfterMs = config.get<number>('SAGA_STUCK_AFTER_SECONDS', 300) * 1000;
    this.maxAttempts = config.get<number>('SAGA_RECOVERY_MAX_ATTEMPTS', 5);
    this.batchSize = config.get<number>('SAGA_RECOVERY_BATCH_SIZE', 20);
  }

  /** One reconciliation pass. Safe to run concurrently on every replica. */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      scanned: 0,
      recovered: 0,
      deadLettered: 0,
      skipped: 0,
      details: [],
    };

    await this.publishStuckGauges();

    for (let i = 0; i < this.batchSize; i++) {
      const saga = await this.claimOne();
      if (!saga) break;
      result.scanned += 1;

      try {
        const outcome = await withSpan(
          'saga.reconcile',
          { 'saga.id': saga.id, 'saga.type': saga.type, 'saga.step': saga.step ?? 'unknown' },
          () => this.recover(saga),
        );
        if (outcome === 'recovered') {
          result.recovered += 1;
          result.details.push({ sagaId: saga.id, action: 'compensated', reason: saga.step ?? 'unknown' });
          metrics.sagaRecoveries.inc({ saga: saga.type, action: 'compensated' });
        } else {
          result.skipped += 1;
          result.details.push({ sagaId: saga.id, action: 'skipped', reason: outcome });
        }
      } catch (error) {
        const attempts = saga.recovery_attempts + 1;
        const message = (error as Error).message ?? 'unknown error';

        if (attempts >= this.maxAttempts) {
          await this.deadLetter(saga, message);
          result.deadLettered += 1;
          result.details.push({ sagaId: saga.id, action: 'dead_lettered', reason: message });
          metrics.sagaRecoveries.inc({ saga: saga.type, action: 'dead_lettered' });
        } else {
          // Release the claim so a later pass retries with backoff.
          await this.db.query(
            `UPDATE saga_instances
                SET state = 'compensating', last_error = $2, updated_at = now()
              WHERE id = $1`,
            [saga.id, message.slice(0, 500)],
          );
          result.details.push({ sagaId: saga.id, action: 'retry_later', reason: message });
          metrics.sagaRecoveries.inc({ saga: saga.type, action: 'retry_later' });
        }
      }
    }

    if (result.recovered || result.deadLettered) {
      this.logger.warn(
        { recovered: result.recovered, deadLettered: result.deadLettered, scanned: result.scanned },
        'saga reconciliation acted on abandoned sagas',
      );
    }
    return result;
  }

  /**
   * Claim exactly one stale saga.
   *
   * `SKIP LOCKED` means a replica never waits on a row another replica is
   * already handling. Incrementing `recovery_attempts` inside the claim makes
   * the attempt count honest even if this process also dies mid-recovery.
   */
  private async claimOne(): Promise<StuckSaga | null> {
    return this.db.transaction(async (client) => {
      const res = await client.query<StuckSaga>(
        `SELECT id, type, state, step, payload, completed_steps, compensations,
                recovery_attempts, last_error, created_at, updated_at
           FROM saga_instances
          WHERE state IN ('running', 'compensating')
            AND updated_at < now() - ($1::bigint || ' milliseconds')::interval
          ORDER BY updated_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [String(this.stuckAfterMs)],
      );
      const saga = res.rows[0];
      if (!saga) return null;

      await client.query(
        `UPDATE saga_instances
            SET state = 'compensating',
                recovery_attempts = recovery_attempts + 1,
                updated_at = now()
          WHERE id = $1`,
        [saga.id],
      );
      return saga;
    });
  }

  /**
   * Undo whatever the abandoned saga managed to do, in reverse order.
   *
   * Reads the compensation list the saga itself recorded, so the reconciler
   * never guesses how far it got.
   */
  private async recover(saga: StuckSaga): Promise<'recovered' | string> {
    if (saga.type !== 'booking.confirm') {
      // Unknown saga types are parked rather than guessed at.
      await this.deadLetter(saga, `no recovery strategy for saga type "${saga.type}"`);
      return `unsupported type ${saga.type}`;
    }

    const payload = saga.payload ?? {};
    const slotId = typeof payload.slotId === 'string' ? payload.slotId : undefined;
    const bookingRef = typeof payload.bookingRef === 'string' ? payload.bookingRef : undefined;
    const paymentId = typeof payload.paymentId === 'string' ? payload.paymentId : undefined;
    const patientId = typeof payload.patientId === 'string' ? payload.patientId : undefined;

    if (!slotId || !bookingRef) {
      await this.deadLetter(saga, 'saga payload is missing slotId or bookingRef');
      return 'incomplete payload';
    }

    const compensations = Array.isArray(saga.compensations) ? [...saga.compensations] : [];

    for (const step of compensations.reverse()) {
      switch (step) {
        case 'refund_payment':
          if (paymentId) {
            await this.db.query(
              `UPDATE payments
                  SET status = 'refunded', refunded_amount = amount, updated_at = now()
                WHERE id = $1 AND status IN ('captured', 'authorized')`,
              [paymentId],
            );
          }
          break;

        case 'cancel_consultation':
          // Conditional on 'scheduled': if the patient already attended, do not
          // rewrite history — the mismatch is surfaced instead.
          await this.db.query(
            `UPDATE consultations
                SET status = 'cancelled', cancelled_at = now(),
                    cancel_reason = 'saga_recovery', updated_at = now()
              WHERE slot_id = $1 AND status = 'scheduled'`,
            [slotId],
          );
          break;

        case 'void_payment':
          if (paymentId) {
            // Deterministic key: a void replayed after a crash is the same call.
            await this.payments.voidAuthorization(paymentId, `void:${bookingRef}`);
          }
          break;

        default:
          break;
      }
      metrics.sagaCompensations.inc({ saga: saga.type, step: `${step}:recovery` });
    }

    // Always release the slot: an abandoned saga must not hold inventory.
    // Conditional on still being held for THIS booking, so a slot someone else
    // has since booked is left alone.
    await this.db.query(
      `UPDATE availability_slots
          SET status = 'available', hold_token = NULL, held_by = NULL, held_until = NULL,
              version = version + 1, updated_at = now()
        WHERE id = $1
          AND status = 'held'
          AND NOT EXISTS (
            SELECT 1 FROM consultations c
             WHERE c.slot_id = $1 AND c.status <> 'cancelled')`,
      [slotId],
    );

    const doctorId = typeof payload.doctorId === 'string' ? payload.doctorId : undefined;
    if (doctorId) await this.availability.invalidateSlotCache(doctorId).catch(() => undefined);

    await this.db.query(
      `UPDATE saga_instances
          SET state = 'compensated', step = 'recovered', recovered_at = now(), updated_at = now()
        WHERE id = $1`,
      [saga.id],
    );

    await this.audit.record({
      actorId: null,
      actorRole: null,
      action: 'saga.recovered',
      resourceType: 'saga',
      resourceId: saga.id,
      outcome: 'success',
      before: { state: saga.state, step: saga.step, stuckSince: saga.updated_at },
      after: { state: 'compensated', compensations, slotId, patientId },
    });

    return 'recovered';
  }

  /** Park a saga that recovery cannot fix. */
  private async deadLetter(saga: StuckSaga, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE saga_instances
          SET state = 'dead_letter', dead_lettered_at = now(),
              last_error = $2, updated_at = now()
        WHERE id = $1`,
      [saga.id, reason.slice(0, 500)],
    );

    this.logger.error(
      { sagaId: saga.id, type: saga.type, step: saga.step, reason, attempts: saga.recovery_attempts + 1 },
      'saga dead-lettered — MANUAL INTERVENTION REQUIRED (see docs/RUNBOOK.md)',
    );

    await this.audit.record({
      actorId: null,
      actorRole: null,
      action: 'saga.dead_lettered',
      resourceType: 'saga',
      resourceId: saga.id,
      outcome: 'failure',
      after: { reason, step: saga.step, attempts: saga.recovery_attempts + 1 },
    });
  }

  /** Publish stuck/dead-letter counts so alerts fire before anyone complains. */
  private async publishStuckGauges(): Promise<void> {
    const res = await this.db.query<{ state: string; n: string }>(
      `SELECT state, count(*)::text AS n
         FROM saga_instances
        WHERE state IN ('running', 'compensating')
          AND updated_at < now() - ($1::bigint || ' milliseconds')::interval
        GROUP BY state`,
      [String(this.stuckAfterMs)],
    );
    const counts: Record<string, number> = { running: 0, compensating: 0 };
    for (const row of res.rows) counts[row.state] = Number(row.n);
    for (const [state, n] of Object.entries(counts)) metrics.sagaStuck.set({ state }, n);

    const dead = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM saga_instances WHERE state = 'dead_letter'`,
    );
    metrics.sagaDeadLettered.set(Number(dead.rows[0]?.n ?? 0));
  }

  /** Operator view: sagas parked for manual attention. */
  async deadLetters(limit = 50): Promise<DeadLetteredSaga[]> {
    const res = await this.db.query<DeadLetteredSaga>(
      `SELECT id, type, step, payload, last_error, recovery_attempts,
              created_at, dead_lettered_at
         FROM saga_instances
        WHERE state = 'dead_letter'
        ORDER BY dead_lettered_at DESC
        LIMIT $1`,
      [limit],
    );
    return res.rows;
  }
}
