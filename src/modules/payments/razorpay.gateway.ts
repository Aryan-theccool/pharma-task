import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthorizeRequest, PaymentGateway, PaymentResult } from './payment-gateway.interface';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { isTransientError, retry, withTimeout } from '../../common/resilience/retry';
import { metrics } from '../../observability/metrics';

/**
 * Razorpay adapter — the production implementation of the payment port.
 *
 * Razorpay is the reference PSP for Indian healthcare (UPI, cards, netbanking).
 * Its order/payment model maps onto the saga's verbs as follows:
 *
 *   authorize  POST /v1/orders            create an order the client pays against
 *   capture    POST /v1/payments/:id/capture
 *   void       POST /v1/payments/:id/refund   (a pre-capture refund is a void)
 *   refund     POST /v1/payments/:id/refund   (partial or full, post-capture)
 *
 * Written against the documented HTTP contract using the platform `fetch`, with
 * no vendor SDK: the SDK adds a dependency, its own retry semantics and its own
 * error taxonomy, none of which compose with the circuit breaker and retry
 * policy the saga already relies on.
 *
 * Every mutating call carries the caller's idempotency key in the
 * `X-Razorpay-Idempotency` header, so a retry after a timeout — the case that
 * double-charges patients — resolves to the original charge rather than a new
 * one.
 *
 * NOTE ON VERIFICATION: this adapter has been exercised against a contract
 * test that asserts request shape, header set, idempotency propagation, error
 * mapping and signature verification (test/unit/razorpay-gateway.spec.ts). It
 * has NOT been run against Razorpay's live sandbox from this environment,
 * which has no outbound network access to their API. Before production use,
 * run the checklist in docs/RUNBOOK.md ("Going live with a real PSP").
 */
@Injectable()
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  private readonly logger = new Logger(RazorpayGateway.name);
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly timeoutMs: number;

  private readonly breaker = new CircuitBreaker({
    name: 'payment-gateway',
    errorThreshold: 0.5,
    volumeThreshold: 20,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  });

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('RAZORPAY_BASE_URL', 'https://api.razorpay.com');
    this.keyId = config.getOrThrow<string>('RAZORPAY_KEY_ID');
    this.keySecret = config.getOrThrow<string>('RAZORPAY_KEY_SECRET');
    // Razorpay signs webhooks with a secret set in their dashboard, which is
    // separate from the API secret.
    this.webhookSecret =
      config.get<string>('RAZORPAY_WEBHOOK_SECRET') ?? config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET');
    this.timeoutMs = config.get<number>('PAYMENT_TIMEOUT_MS', 5_000);
  }

  // ------------------------------------------------------------------ HTTP

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  /**
   * One outbound call: breaker -> retry(full jitter) -> hard timeout.
   *
   * Only 5xx/network failures are retried (`isTransientError`). A 4xx is a
   * deterministic rejection — retrying it burns the budget and, worse, can turn
   * one declined card into five.
   */
  private async call<T>(
    label: string,
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const stop = metrics.dbQueryDuration.startTimer();
    try {
      return await this.breaker.execute(() =>
        retry(() => withTimeout(this.request<T>(path, init), this.timeoutMs, label), {
          attempts: 5,
          baseMs: 200,
          capMs: 10_000,
          retryable: isTransientError,
          onRetry: (_e, attempt, delay) =>
            this.logger.warn(`${label} retry ${attempt} in ${delay}ms (transient provider error)`),
        }),
      );
    } finally {
      stop();
    }
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (init.idempotencyKey) headers['X-Razorpay-Idempotency'] = init.idempotencyKey;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      const description =
        (parsed as { error?: { description?: string } })?.error?.description ?? response.statusText;
      // `status` is what isTransientError inspects: 5xx retries, 4xx does not.
      const error = new Error(`razorpay ${response.status}: ${description}`) as Error & {
        status: number;
        body: unknown;
      };
      error.status = response.status;
      error.body = parsed;
      throw error;
    }

    return parsed as T;
  }

  // -------------------------------------------------------------- Port impl

  /**
   * Create an order. Razorpay works in the minor unit (paise), so amounts are
   * converted with rounding rather than truncation — `Math.trunc(19.99 * 100)`
   * is 1998 in IEEE-754, which would silently undercharge by a paisa.
   */
  async authorize(req: AuthorizeRequest): Promise<PaymentResult> {
    const body = {
      amount: toMinorUnit(req.amount),
      currency: req.currency,
      receipt: req.bookingRef,
      // Razorpay caps notes values at 256 chars; these are both short ids.
      notes: { patientId: req.patientId, bookingRef: req.bookingRef },
      payment_capture: 0, // authorize now, capture explicitly in the saga
    };

    const order = await this.call<{ id: string; amount: number; currency: string; status: string }>(
      'payment.authorize',
      '/v1/orders',
      { method: 'POST', body, idempotencyKey: req.idempotencyKey },
    );

    return {
      providerRef: order.id,
      status: 'authorized',
      amount: fromMinorUnit(order.amount),
      currency: order.currency,
    };
  }

  async capture(providerRef: string, idempotencyKey: string): Promise<PaymentResult> {
    const captured = await this.call<{ id: string; amount: number; currency: string }>(
      'payment.capture',
      `/v1/payments/${encodeURIComponent(providerRef)}/capture`,
      { method: 'POST', body: {}, idempotencyKey },
    );
    return {
      providerRef: captured.id,
      status: 'captured',
      amount: fromMinorUnit(captured.amount),
      currency: captured.currency,
    };
  }

  /**
   * Void an authorization.
   *
   * Razorpay has no distinct void verb: an un-captured payment is released by
   * refunding it in full. Modelled explicitly here so the saga's vocabulary
   * stays provider-independent.
   */
  async void(providerRef: string, idempotencyKey: string): Promise<PaymentResult> {
    const refund = await this.call<{ amount: number; currency: string }>(
      'payment.void',
      `/v1/payments/${encodeURIComponent(providerRef)}/refund`,
      { method: 'POST', body: { speed: 'normal' }, idempotencyKey },
    );
    return {
      providerRef,
      status: 'voided',
      amount: fromMinorUnit(refund.amount),
      currency: refund.currency,
    };
  }

  async refund(providerRef: string, amount: number, idempotencyKey: string): Promise<PaymentResult> {
    const refund = await this.call<{ amount: number; currency: string }>(
      'payment.refund',
      `/v1/payments/${encodeURIComponent(providerRef)}/refund`,
      { method: 'POST', body: { amount: toMinorUnit(amount), speed: 'normal' }, idempotencyKey },
    );
    return {
      providerRef,
      status: 'refunded',
      amount: fromMinorUnit(refund.amount),
      currency: refund.currency,
    };
  }

  /**
   * Verify `X-Razorpay-Signature`.
   *
   * Razorpay signs the raw body ONLY — unlike Stripe, there is no timestamp in
   * their signature base string. The controller still enforces its own
   * `X-Timestamp` freshness window on top, which is what bounds replay; this
   * method deliberately accepts the timestamp argument and ignores it for the
   * MAC so the port stays uniform across providers.
   */
  verifyWebhookSignature(rawBody: string, signature: string, _timestamp: string): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature ?? '', 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  get breakerState() {
    return this.breaker.currentState;
  }
}

/**
 * Rupees -> paise. `Math.round` after scaling, because 19.99 * 100 is
 * 1998.9999999999998 in binary floating point and truncation loses a paisa on
 * a large fraction of real prices.
 */
export function toMinorUnit(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinorUnit(minor: number): number {
  return minor / 100;
}
