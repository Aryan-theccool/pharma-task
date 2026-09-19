import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { AvailabilityService } from '../availability/availability.service';
import { AuditService } from '../audit/audit.service';
import { SagaService } from './saga.service';
import { metrics } from '../../observability/metrics';
import { withSpan } from '../../observability/tracing';
import type { JwtPayload } from '../../common/types/authenticated-request';
import type { CancelBookingDto, ConfirmBookingDto, HoldSlotDto, RescheduleDto } from './dto/booking.dto';

/**
 * Booking orchestration.
 *
 * ── Double-booking defence in depth ───────────────────────────────────────
 *  1. Redis lock  `SET slot:{id} <token> NX PX 5000` — cheap pre-filter that
 *     sheds 99% of concurrent duplicates before they touch Postgres.
 *  2. Row lock    `SELECT ... FOR UPDATE NOWAIT` inside the transaction —
 *     serialises the survivors; losers fail fast (55P03) instead of queuing.
 *  3. DB constraints — `EXCLUDE USING gist` prevents overlapping slots and a
 *     partial `UNIQUE(slot_id) WHERE status <> 'cancelled'` prevents two live
 *     consultations on one slot. Even a direct psql writer cannot double-book.
 *
 * ── Hold → Confirm ────────────────────────────────────────────────────────
 * A hold reserves the slot for BOOKING_HOLD_TTL_SECONDS (default 5 min) with
 * an unguessable `holdToken` bound to the patient. Expired holds are swept by
 * a repeatable job and lazily released at confirm time.
 *
 * ── Saga ──────────────────────────────────────────────────────────────────
 * Confirm runs CreateHold → AuthorizePayment → CreateConsultation →
 * CapturePayment → Notify, persisting each step in `saga_instances` so a crash
 * mid-flight is resumable and every step has a registered compensation.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);
  private readonly holdTtlSeconds: number;
  private readonly refundWindowHours: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    private readonly saga: SagaService,
    config: ConfigService,
  ) {
    this.holdTtlSeconds = config.get<number>('BOOKING_HOLD_TTL_SECONDS', 300);
    this.refundWindowHours = config.get<number>('REFUND_WINDOW_HOURS', 24);
  }

  // --------------------------------------------------------------- HOLD

  async hold(user: JwtPayload, dto: HoldSlotDto) {
    const stop = metrics.bookingDuration.startTimer({ stage: 'hold' });
    try {
      return await withSpan('booking.hold', { 'slot.id': dto.slotId, 'user.id': user.sub }, async () => {
        // Defence 1 — Redis pre-filter.
        const lockKey = `lock:slot:${dto.slotId}`;
        const lockToken = await this.redis.acquireLock(lockKey, 5_000);
        if (!lockToken) {
          metrics.bookingConflicts.inc({ defence: 'redis_lock' });
          metrics.bookingAttempts.inc({ stage: 'hold', result: 'conflict' });
          throw new ConflictException({
            title: 'Slot is being booked by another request',
            detail: 'Please retry in a moment.',
          });
        }

        try {
          const result = await this.db.transaction(async (client) => {
            // Lazily release this slot's hold if it has expired.
            await client.query(
              `UPDATE availability_slots
                  SET status='available', hold_token=NULL, held_by=NULL, held_until=NULL,
                      version = version + 1
                WHERE id = $1 AND status = 'held' AND held_until < now()`,
              [dto.slotId],
            );

            // Defence 2 — row lock, fail fast rather than queue.
            const slotRes = await client.query<{
              id: string;
              doctor_id: string;
              status: string;
              starts_at: Date;
              ends_at: Date;
            }>(
              `SELECT id, doctor_id, status,
                      lower(slot_range) AS starts_at, upper(slot_range) AS ends_at
                 FROM availability_slots
                WHERE id = $1
                FOR UPDATE NOWAIT`,
              [dto.slotId],
            );

            const slot = slotRes.rows[0];
            if (!slot) throw new NotFoundException({ title: 'Slot not found' });

            if (slot.status !== 'available') {
              metrics.bookingConflicts.inc({ defence: 'state' });
              throw new ConflictException({
                title: 'Slot is not available',
                detail: `Slot is currently "${slot.status}".`,
              });
            }
            if (slot.starts_at <= new Date()) {
              throw new BadRequestException({ title: 'Cannot book a slot in the past' });
            }

            const doctorRes = await client.query<{ consultation_fee: string; currency: string }>(
              `SELECT consultation_fee, currency FROM doctors WHERE id = $1`,
              [slot.doctor_id],
            );
            const doctor = doctorRes.rows[0];

            const holdToken = randomUUID();
            await client.query(
              `UPDATE availability_slots
                  SET status='held', hold_token=$2, held_by=$3,
                      held_until = now() + ($4 || ' seconds')::interval,
                      version = version + 1, updated_at = now()
                WHERE id = $1`,
              [dto.slotId, holdToken, user.sub, String(this.holdTtlSeconds)],
            );

            const expiresAt = new Date(Date.now() + this.holdTtlSeconds * 1000);
            return {
              slotId: slot.id,
              doctorId: slot.doctor_id,
              holdToken,
              expiresAt,
              startsAt: slot.starts_at,
              endsAt: slot.ends_at,
              amount: Number(doctor?.consultation_fee ?? 0),
              currency: doctor?.currency ?? 'INR',
            };
          });

          await this.availability.invalidateSlotCache(result.doctorId);
          metrics.bookingAttempts.inc({ stage: 'hold', result: 'success' });
          await this.audit.record({
            actorId: user.sub,
            actorRole: user.role,
            action: 'booking.hold',
            resourceType: 'slot',
            resourceId: dto.slotId,
          });
          return result;
        } finally {
          await this.redis.releaseLock(lockKey, lockToken);
        }
      });
    } catch (error) {
      this.classifyConflict(error, 'hold');
      throw error;
    } finally {
      stop();
    }
  }

  // ------------------------------------------------------------ CONFIRM

  /**
   * Confirm a held slot: authorize payment, create the consultation, capture,
   * and emit notifications — with compensation on every failure.
   */
  async confirm(user: JwtPayload, dto: ConfirmBookingDto) {
    const stop = metrics.bookingDuration.startTimer({ stage: 'confirm' });
    const bookingRef = randomUUID();

    try {
      return await withSpan(
        'booking.confirm',
        { 'slot.id': dto.slotId, 'user.id': user.sub, 'booking.ref': bookingRef },
        async () => {
          const sagaId = await this.saga.start('booking.confirm', {
            slotId: dto.slotId,
            patientId: user.sub,
            bookingRef,
          });

          let paymentId: string | undefined;
          let doctorId: string | undefined;
          // Only an attempt that actually won the row lock in validate_hold owns
          // the slot, and only that attempt may release it while compensating.
          let ownsHold = false;

          try {
            // ---- Step 1: validate + lock the hold -----------------------
            const held = await withSpan('saga.step.validate_hold', { 'saga.id': sagaId }, () =>
              this.db.transaction(async (client) => {
                const res = await client.query<{
                  id: string;
                  doctor_id: string;
                  status: string;
                  hold_token: string | null;
                  held_by: string | null;
                  held_until: Date | null;
                  starts_at: Date;
                  ends_at: Date;
                }>(
                  `SELECT id, doctor_id, status, hold_token, held_by, held_until,
                          lower(slot_range) AS starts_at, upper(slot_range) AS ends_at
                     FROM availability_slots
                    WHERE id = $1
                    FOR UPDATE NOWAIT`,
                  [dto.slotId],
                );
                const slot = res.rows[0];
                if (!slot) throw new NotFoundException({ title: 'Slot not found' });

                if (slot.status === 'booked') {
                  metrics.bookingConflicts.inc({ defence: 'state' });
                  throw new ConflictException({ title: 'Slot has already been booked' });
                }
                if (slot.status !== 'held') {
                  throw new ConflictException({
                    title: 'Slot is not held',
                    detail: 'Create a hold first via POST /bookings/hold.',
                  });
                }
                if (slot.hold_token !== dto.holdToken) {
                  throw new ForbiddenException({ title: 'Invalid hold token for this slot' });
                }
                if (slot.held_by !== user.sub) {
                  throw new ForbiddenException({ title: 'This hold belongs to another user' });
                }
                if (!slot.held_until || slot.held_until < new Date()) {
                  metrics.bookingAttempts.inc({ stage: 'confirm', result: 'expired' });
                  throw new ConflictException({
                    title: 'Hold has expired',
                    detail: 'Create a new hold and confirm within the hold window.',
                  });
                }
                return slot;
              }),
            );

            doctorId = held.doctor_id;
            ownsHold = true;
            await this.saga.completeStep(sagaId, 'validate_hold');

            const doctorRes = await this.db.query<{ consultation_fee: string; currency: string }>(
              `SELECT consultation_fee, currency FROM doctors WHERE id = $1`,
              [held.doctor_id],
            );
            const amount = Number(doctorRes.rows[0]?.consultation_fee ?? 0);
            const currency = doctorRes.rows[0]?.currency ?? 'INR';

            // ---- Step 2: authorize payment ------------------------------
            const payment = await withSpan('saga.step.authorize_payment', { 'saga.id': sagaId }, () =>
              this.db.transaction((client) =>
                this.payments.authorizeForBooking(client, {
                  patientId: user.sub,
                  amount,
                  currency,
                  bookingRef,
                  idempotencyKey: `auth:${bookingRef}`,
                }),
              ),
            );
            paymentId = payment.id;
            await this.saga.completeStep(sagaId, 'authorize_payment', {
              paymentId,
              compensation: 'void_payment',
            });

            // ---- Step 3: create consultation + mark slot booked ---------
            const consultation = await withSpan(
              'saga.step.create_consultation',
              { 'saga.id': sagaId },
              () =>
                this.db.transaction(async (client) => {
                  // Defence 2 again, now in the writing transaction.
                  const slotRes = await client.query<{ status: string; hold_token: string | null }>(
                    `SELECT status, hold_token FROM availability_slots WHERE id = $1 FOR UPDATE NOWAIT`,
                    [dto.slotId],
                  );
                  const current = slotRes.rows[0];
                  if (!current || current.status !== 'held' || current.hold_token !== dto.holdToken) {
                    metrics.bookingConflicts.inc({ defence: 'row_lock' });
                    throw new ConflictException({ title: 'Hold is no longer valid' });
                  }

                  const created = await client.query<{ id: string; scheduled_at: Date }>(
                    `INSERT INTO consultations
                       (patient_id, doctor_id, slot_id, status, mode, scheduled_at, ends_at,
                        chief_complaint, amount)
                     VALUES ($1,$2,$3,'scheduled',$4,$5,$6,$7,$8)
                     RETURNING id, scheduled_at`,
                    [
                      user.sub,
                      held.doctor_id,
                      dto.slotId,
                      dto.mode ?? 'video',
                      held.starts_at,
                      held.ends_at,
                      dto.chiefComplaint ?? null,
                      amount,
                    ],
                  );

                  await client.query(
                    `UPDATE availability_slots
                        SET status='booked', held_until=NULL, version = version + 1, updated_at = now()
                      WHERE id = $1`,
                    [dto.slotId],
                  );

                  await client.query(
                    `UPDATE payments SET consultation_id = $2, updated_at = now() WHERE id = $1`,
                    [payment.id, created.rows[0].id],
                  );

                  // Same transaction as the state change — no dual write.
                  await this.outbox.emit(client, {
                    aggregateType: 'consultation',
                    aggregateId: created.rows[0].id,
                    eventType: 'consultation.booked',
                    payload: {
                      consultationId: created.rows[0].id,
                      patientId: user.sub,
                      doctorId: held.doctor_id,
                      scheduledAt: held.starts_at.toISOString(),
                      amount,
                      currency,
                    },
                  });

                  return created.rows[0];
                }),
            );
            await this.saga.completeStep(sagaId, 'create_consultation', {
              consultationId: consultation.id,
              compensation: 'cancel_consultation',
            });

            // ---- Step 4: capture payment --------------------------------
            await withSpan('saga.step.capture_payment', { 'saga.id': sagaId }, () =>
              this.payments.capture(payment.id, `capture:${bookingRef}`),
            );
            await this.saga.completeStep(sagaId, 'capture_payment', { compensation: 'refund_payment' });

            await this.saga.complete(sagaId);
            await this.availability.invalidateSlotCache(held.doctor_id);
            metrics.bookingAttempts.inc({ stage: 'confirm', result: 'success' });
            await this.audit.record({
              actorId: user.sub,
              actorRole: user.role,
              action: 'booking.confirm',
              resourceType: 'consultation',
              resourceId: consultation.id,
              after: { slotId: dto.slotId, amount, bookingRef },
            });

            return {
              consultationId: consultation.id,
              slotId: dto.slotId,
              doctorId: held.doctor_id,
              patientId: user.sub,
              status: 'scheduled',
              scheduledAt: held.starts_at,
              endsAt: held.ends_at,
              amount,
              currency,
              payment: { id: payment.id, status: 'captured', providerRef: payment.provider_ref },
              bookingRef,
            };
          } catch (error) {
            await this.compensate(sagaId, error, {
              paymentId,
              slotId: dto.slotId,
              doctorId,
              bookingRef,
              holdToken: dto.holdToken,
              ownsHold,
            });
            this.classifyConflict(error, 'confirm');
            throw error;
          }
        },
      );
    } finally {
      stop();
    }
  }

  /** Run the registered compensations in reverse order. */
  private async compensate(
    sagaId: string,
    error: unknown,
    ctx: {
      paymentId?: string;
      slotId: string;
      doctorId?: string;
      bookingRef: string;
      holdToken?: string;
      /** True only when this attempt won the hold; see the release below. */
      ownsHold?: boolean;
    },
  ): Promise<void> {
    const steps = await this.saga.compensationsFor(sagaId);
    await this.saga.fail(sagaId, (error as Error).message ?? 'unknown error');

    for (const step of steps.reverse()) {
      try {
        metrics.sagaCompensations.inc({ saga: 'booking.confirm', step });
        switch (step) {
          case 'void_payment':
            if (ctx.paymentId) {
              await this.payments.voidAuthorization(ctx.paymentId, `void:${ctx.bookingRef}`);
            }
            break;
          case 'cancel_consultation':
            await this.db.query(
              `UPDATE consultations SET status='cancelled', cancelled_at = now(),
                      cancel_reason='saga_compensation'
                WHERE slot_id = $1 AND status = 'scheduled'`,
              [ctx.slotId],
            );
            break;
          case 'refund_payment':
            // Capture succeeded but a later step failed — money must go back.
            if (ctx.paymentId) {
              await this.db.query(
                `UPDATE payments SET status='refunded', refunded_amount = amount, updated_at = now()
                  WHERE id = $1`,
                [ctx.paymentId],
              );
            }
            break;
          default:
            break;
        }
        await this.saga.recordCompensation(sagaId, step);
      } catch (compError) {
        this.logger.error({ err: compError, sagaId, step }, 'compensation failed — requires operator attention');
      }
    }

    // Return the slot to the pool — but only when this attempt actually owned
    // the hold. In a concurrent confirm race the losers fail at validate_hold
    // without ever acquiring the row lock; if they released the slot anyway
    // they would undo the work of the request that legitimately won, and every
    // attempt would end up failing. The hold_token predicate is a second guard
    // for the case where the winner has already moved the slot on.
    if (ctx.ownsHold && ctx.holdToken) {
      await this.db
        .query(
          `UPDATE availability_slots
              SET status='available', hold_token=NULL, held_by=NULL, held_until=NULL,
                  version = version + 1
            WHERE id = $1 AND status = 'held' AND hold_token = $2`,
          [ctx.slotId, ctx.holdToken],
        )
        .catch(() => undefined);
    }

    if (ctx.doctorId) await this.availability.invalidateSlotCache(ctx.doctorId);
  }

  // ------------------------------------------------------------- CANCEL

  async cancel(user: JwtPayload, consultationId: string, dto: CancelBookingDto) {
    return withSpan('booking.cancel', { 'consultation.id': consultationId }, async () => {
      const result = await this.db.transaction(async (client) => {
        const res = await client.query<{
          id: string;
          patient_id: string;
          doctor_id: string;
          slot_id: string;
          status: string;
          scheduled_at: Date;
          amount: string;
        }>(
          `SELECT id, patient_id, doctor_id, slot_id, status, scheduled_at, amount
             FROM consultations WHERE id = $1 FOR UPDATE`,
          [consultationId],
        );
        const consultation = res.rows[0];
        if (!consultation) throw new NotFoundException({ title: 'Consultation not found' });

        const isOwner = consultation.patient_id === user.sub;
        const isTreatingDoctor = await this.isDoctorOf(client, user, consultation.doctor_id);
        if (!isOwner && !isTreatingDoctor && user.role !== 'admin') {
          throw new ForbiddenException({ title: 'You may only cancel your own consultations' });
        }
        if (['cancelled', 'completed'].includes(consultation.status)) {
          throw new ConflictException({
            title: 'Consultation cannot be cancelled',
            detail: `Current status is "${consultation.status}".`,
          });
        }

        // Refund policy: full refund outside the cutoff window, none inside.
        const hoursUntil = (consultation.scheduled_at.getTime() - Date.now()) / 3_600_000;
        const refundEligible = hoursUntil >= this.refundWindowHours;

        await client.query(
          `UPDATE consultations
              SET status='cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now()
            WHERE id = $1`,
          [consultationId, dto.reason ?? 'cancelled_by_user'],
        );
        await client.query(
          `UPDATE availability_slots
              SET status='available', hold_token=NULL, held_by=NULL, held_until=NULL,
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [consultation.slot_id],
        );

        await this.outbox.emit(client, {
          aggregateType: 'consultation',
          aggregateId: consultationId,
          eventType: 'consultation.cancelled',
          payload: {
            consultationId,
            patientId: consultation.patient_id,
            doctorId: consultation.doctor_id,
            refundEligible,
            cancelledBy: user.sub,
          },
        });

        return { consultation, refundEligible };
      });

      // Refund outside the transaction — an external call must not hold locks.
      let refund: { id: string; amount: number } | null = null;
      if (result.refundEligible) {
        const paymentRes = await this.db.query<{ id: string; amount: string; status: string }>(
          `SELECT id, amount, status FROM payments WHERE consultation_id = $1 LIMIT 1`,
          [consultationId],
        );
        const payment = paymentRes.rows[0];
        if (payment && ['authorized', 'captured'].includes(payment.status)) {
          const refunded = await this.payments.refund(
            payment.id,
            user,
            Number(payment.amount),
            `refund:${consultationId}`,
            dto.reason,
          );
          refund = { id: refunded.id, amount: refunded.refundedAmount };
        }
      }

      await this.availability.invalidateSlotCache(result.consultation.doctor_id);
      metrics.bookingAttempts.inc({ stage: 'cancel', result: 'success' });
      await this.audit.record({
        actorId: user.sub,
        actorRole: user.role,
        action: 'booking.cancel',
        resourceType: 'consultation',
        resourceId: consultationId,
        after: { refundEligible: result.refundEligible, reason: dto.reason },
      });

      return {
        consultationId,
        status: 'cancelled',
        refundEligible: result.refundEligible,
        refund,
        policy: `Full refund when cancelled at least ${this.refundWindowHours}h before the appointment.`,
      };
    });
  }

  // --------------------------------------------------------- RESCHEDULE

  /**
   * Atomic move to a new slot: the new slot is claimed and the old one
   * released in a single transaction, so a failure can never leave the patient
   * with zero slots or the doctor with two bookings.
   */
  async reschedule(user: JwtPayload, consultationId: string, dto: RescheduleDto) {
    return withSpan('booking.reschedule', { 'consultation.id': consultationId }, async () => {
      const lockKey = `lock:slot:${dto.newSlotId}`;
      const lockToken = await this.redis.acquireLock(lockKey, 5_000);
      if (!lockToken) {
        metrics.bookingConflicts.inc({ defence: 'redis_lock' });
        throw new ConflictException({ title: 'Target slot is being booked by another request' });
      }

      try {
        const result = await this.db.transaction(async (client) => {
          const res = await client.query<{
            id: string;
            patient_id: string;
            doctor_id: string;
            slot_id: string;
            status: string;
          }>(`SELECT id, patient_id, doctor_id, slot_id, status FROM consultations WHERE id = $1 FOR UPDATE`, [
            consultationId,
          ]);
          const consultation = res.rows[0];
          if (!consultation) throw new NotFoundException({ title: 'Consultation not found' });
          if (consultation.patient_id !== user.sub && user.role !== 'admin') {
            throw new ForbiddenException({ title: 'You may only reschedule your own consultations' });
          }
          if (consultation.status !== 'scheduled') {
            throw new ConflictException({
              title: 'Only scheduled consultations can be rescheduled',
              detail: `Current status is "${consultation.status}".`,
            });
          }

          const slotRes = await client.query<{
            id: string;
            doctor_id: string;
            status: string;
            starts_at: Date;
            ends_at: Date;
          }>(
            `SELECT id, doctor_id, status, lower(slot_range) AS starts_at, upper(slot_range) AS ends_at
               FROM availability_slots WHERE id = $1 FOR UPDATE NOWAIT`,
            [dto.newSlotId],
          );
          const newSlot = slotRes.rows[0];
          if (!newSlot) throw new NotFoundException({ title: 'Target slot not found' });
          if (newSlot.status !== 'available') {
            metrics.bookingConflicts.inc({ defence: 'state' });
            throw new ConflictException({ title: 'Target slot is not available' });
          }
          if (newSlot.doctor_id !== consultation.doctor_id) {
            throw new BadRequestException({
              title: 'Cannot reschedule to a different doctor',
              detail: 'Cancel this consultation and book the other doctor instead.',
            });
          }
          if (newSlot.starts_at <= new Date()) {
            throw new BadRequestException({ title: 'Cannot reschedule into the past' });
          }

          await client.query(
            `UPDATE availability_slots
                SET status='booked', hold_token=NULL, held_by=NULL, held_until=NULL,
                    version = version + 1, updated_at = now()
              WHERE id = $1`,
            [dto.newSlotId],
          );
          await client.query(
            `UPDATE availability_slots
                SET status='available', hold_token=NULL, held_by=NULL, held_until=NULL,
                    version = version + 1, updated_at = now()
              WHERE id = $1`,
            [consultation.slot_id],
          );
          await client.query(
            `UPDATE consultations
                SET slot_id = $2, scheduled_at = $3, ends_at = $4, updated_at = now()
              WHERE id = $1`,
            [consultationId, dto.newSlotId, newSlot.starts_at, newSlot.ends_at],
          );

          await this.outbox.emit(client, {
            aggregateType: 'consultation',
            aggregateId: consultationId,
            eventType: 'consultation.rescheduled',
            payload: {
              consultationId,
              patientId: consultation.patient_id,
              doctorId: consultation.doctor_id,
              from: consultation.slot_id,
              to: dto.newSlotId,
              scheduledAt: newSlot.starts_at.toISOString(),
            },
          });

          return { consultation, newSlot };
        });

        await this.availability.invalidateSlotCache(result.consultation.doctor_id);
        metrics.bookingAttempts.inc({ stage: 'reschedule', result: 'success' });
        await this.audit.record({
          actorId: user.sub,
          actorRole: user.role,
          action: 'booking.reschedule',
          resourceType: 'consultation',
          resourceId: consultationId,
          before: { slotId: result.consultation.slot_id },
          after: { slotId: dto.newSlotId },
        });

        return {
          consultationId,
          slotId: dto.newSlotId,
          scheduledAt: result.newSlot.starts_at,
          endsAt: result.newSlot.ends_at,
          status: 'scheduled',
        };
      } catch (error) {
        this.classifyConflict(error, 'reschedule');
        throw error;
      } finally {
        await this.redis.releaseLock(lockKey, lockToken);
      }
    });
  }

  // -------------------------------------------------------------- utils

  private async isDoctorOf(client: PoolClient, user: JwtPayload, doctorId: string): Promise<boolean> {
    if (user.role !== 'doctor') return false;
    const res = await client.query(`SELECT 1 FROM doctors WHERE id = $1 AND user_id = $2`, [
      doctorId,
      user.sub,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Translate low-level races into the right metric + HTTP semantics. */
  private classifyConflict(error: unknown, stage: string): void {
    const code = (error as { code?: string }).code;
    if (code === '55P03') {
      metrics.bookingConflicts.inc({ defence: 'row_lock' });
      metrics.bookingAttempts.inc({ stage, result: 'conflict' });
    } else if (code === '23505' || code === '23P01') {
      metrics.bookingConflicts.inc({ defence: 'db_constraint' });
      metrics.bookingAttempts.inc({ stage, result: 'conflict' });
    } else if ((error as { status?: number }).status === 409) {
      metrics.bookingAttempts.inc({ stage, result: 'conflict' });
    } else {
      metrics.bookingAttempts.inc({ stage, result: 'error' });
    }
  }
}
