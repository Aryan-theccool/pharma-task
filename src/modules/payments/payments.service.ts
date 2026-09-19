import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../infra/database.service';
import { AuditService } from '../audit/audit.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import type { JwtPayload } from '../../common/types/authenticated-request';

const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface PaymentRow {
  id: string;
  consultation_id: string | null;
  booking_ref: string | null;
  patient_id: string;
  amount: string;
  currency: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  refunded_amount: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /** Authorize inside the booking saga (client supplied by the caller's tx). */
  async authorizeForBooking(
    client: PoolClient,
    input: {
      patientId: string;
      amount: number;
      currency: string;
      bookingRef: string;
      idempotencyKey: string;
    },
  ): Promise<PaymentRow> {
    const result = await this.gateway.authorize({
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      currency: input.currency,
      patientId: input.patientId,
      bookingRef: input.bookingRef,
    });

    const res = await client.query<PaymentRow>(
      `INSERT INTO payments
         (patient_id, booking_ref, amount, currency, status, provider, provider_ref, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [
        input.patientId,
        input.bookingRef,
        input.amount,
        input.currency,
        result.status,
        this.gateway.name,
        result.providerRef,
        input.idempotencyKey,
      ],
    );
    return res.rows[0];
  }

  async capture(paymentId: string, idempotencyKey: string): Promise<PaymentRow> {
    const existing = await this.byId(paymentId);
    if (existing.status === 'captured') return existing;
    if (!existing.provider_ref) throw new BadRequestException({ title: 'Payment has no provider reference' });

    const result = await this.gateway.capture(existing.provider_ref, idempotencyKey);
    const res = await this.db.query<PaymentRow>(
      `UPDATE payments SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [paymentId, result.status],
    );
    return res.rows[0];
  }

  /** Compensating action for the saga: release an authorization hold. */
  async voidAuthorization(paymentId: string, idempotencyKey: string): Promise<void> {
    const existing = await this.byId(paymentId).catch(() => null);
    if (!existing?.provider_ref) return;
    if (['voided', 'refunded'].includes(existing.status)) return;
    try {
      await this.gateway.void(existing.provider_ref, idempotencyKey);
      await this.db.query(`UPDATE payments SET status = 'voided', updated_at = now() WHERE id = $1`, [
        paymentId,
      ]);
    } catch (error) {
      // Compensations must not throw — the saga records and retries them.
      this.logger.error({ err: error, paymentId }, 'void authorization failed; will be retried');
      throw error;
    }
  }

  async refund(
    paymentId: string,
    user: JwtPayload,
    amount: number | undefined,
    idempotencyKey: string,
    reason?: string,
  ) {
    const payment = await this.byId(paymentId);

    if (user.role !== 'admin' && payment.patient_id !== user.sub) {
      throw new ForbiddenException({ title: 'You may only refund your own payments' });
    }
    if (!['authorized', 'captured'].includes(payment.status)) {
      throw new BadRequestException({
        title: 'Payment is not refundable',
        detail: `Current status is "${payment.status}".`,
      });
    }

    const refundAmount = amount ?? Number(payment.amount);
    if (refundAmount <= 0 || refundAmount > Number(payment.amount) - Number(payment.refunded_amount)) {
      throw new BadRequestException({ title: 'Invalid refund amount' });
    }

    const result = await this.gateway.refund(payment.provider_ref!, refundAmount, idempotencyKey);
    const res = await this.db.query<PaymentRow>(
      `UPDATE payments
          SET status = CASE WHEN refunded_amount + $2 >= amount THEN 'refunded' ELSE status END,
              refunded_amount = refunded_amount + $2,
              refund_ref = $3,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [paymentId, refundAmount, result.providerRef],
    );

    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'payment.refund',
      resourceType: 'payment',
      resourceId: paymentId,
      after: { amount: refundAmount, reason },
    });

    return this.present(res.rows[0]);
  }

  /**
   * Idempotent webhook ingestion.
   *
   * Three independent protections:
   *   1. HMAC signature over `${timestamp}.${rawBody}` (authenticity)
   *   2. timestamp freshness window (bounds replay)
   *   3. UNIQUE(provider, event_id) insert (exactly-once effect)
   */
  async handleWebhook(input: {
    rawBody: string;
    signature?: string;
    timestamp?: string;
    body: { eventId?: string; type?: string; providerRef?: string; status?: string };
  }) {
    const { rawBody, signature, timestamp, body } = input;

    // A missing signature and a wrong signature are both "you are not the
    // payment provider". Answering 400 for one and 403 for the other would tell
    // an attacker exactly which check they tripped, so both return 403.
    if (!signature || !timestamp) {
      throw new ForbiddenException({ title: 'Invalid webhook signature' });
    }
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
      throw new BadRequestException({ title: 'Webhook timestamp outside tolerance window' });
    }
    if (!this.gateway.verifyWebhookSignature(rawBody, signature, timestamp)) {
      throw new ForbiddenException({ title: 'Invalid webhook signature' });
    }
    if (!body.eventId || !body.type) {
      throw new BadRequestException({ title: 'Webhook payload must include eventId and type' });
    }

    const claim = await this.db.query(
      `INSERT INTO payment_webhook_events (provider, event_id, provider_ref, payload)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [this.gateway.name, body.eventId, body.providerRef ?? null, JSON.stringify(body)],
    );

    if (claim.rowCount === 0) {
      return { received: true, duplicate: true };
    }

    if (body.providerRef && body.status) {
      const allowed = ['authorized', 'captured', 'failed', 'refunded', 'voided'];
      if (allowed.includes(body.status)) {
        await this.db.query(`UPDATE payments SET status = $2, updated_at = now() WHERE provider_ref = $1`, [
          body.providerRef,
          body.status,
        ]);
      }
    }

    await this.audit.record({
      action: 'payment.webhook',
      resourceType: 'payment',
      resourceId: body.providerRef ?? body.eventId,
      after: { type: body.type, status: body.status },
    });

    return { received: true, duplicate: false };
  }

  async listForUser(user: JwtPayload) {
    const res = await this.db.queryReplica<PaymentRow>(
      `SELECT * FROM payments WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user.sub],
    );
    return res.rows.map((r) => this.present(r));
  }

  async findForUser(paymentId: string, user: JwtPayload) {
    const payment = await this.byId(paymentId);
    if (user.role !== 'admin' && payment.patient_id !== user.sub) {
      throw new ForbiddenException({ title: 'You may only view your own payments' });
    }
    return this.present(payment);
  }

  private async byId(id: string): Promise<PaymentRow> {
    const res = await this.db.query<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [id]);
    if (!res.rowCount) throw new NotFoundException({ title: 'Payment not found' });
    return res.rows[0];
  }

  present(p: PaymentRow) {
    return {
      id: p.id,
      consultationId: p.consultation_id,
      bookingRef: p.booking_ref,
      patientId: p.patient_id,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      provider: p.provider,
      providerRef: p.provider_ref,
      refundedAmount: Number(p.refunded_amount),
    };
  }
}
