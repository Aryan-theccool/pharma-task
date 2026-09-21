import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthorizeRequest, PaymentGateway, PaymentResult } from './payment-gateway.interface';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { isTransientError, retry, withTimeout } from '../../common/resilience/retry';

/**
 * In-memory payment provider used for local development, tests and the demo.
 *
 * It faithfully models the behaviours the real integration must survive:
 *  - provider-side idempotency (same key -> same charge, never a second one)
 *  - configurable fault injection (PAYMENT_FAILURE_RATE) for chaos testing
 *  - network latency
 *  - HMAC-signed webhooks with a timestamp to bound replay windows
 *
 * All outbound calls go through retry-with-full-jitter + a circuit breaker +
 * a hard timeout, so a degraded provider sheds load instead of exhausting our
 * request threads.
 */
@Injectable()
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';
  private readonly logger = new Logger(MockPaymentGateway.name);
  private readonly charges = new Map<string, PaymentResult>();
  private readonly byRef = new Map<string, PaymentResult>();
  private readonly failureRate: number;
  private readonly webhookSecret: string;

  private readonly breaker = new CircuitBreaker({
    name: 'payment-gateway',
    errorThreshold: 0.5,
    volumeThreshold: 20,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  });

  constructor(config: ConfigService) {
    this.failureRate = config.get<number>('PAYMENT_FAILURE_RATE', 0);
    this.webhookSecret = config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET');
  }

  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.breaker.execute(() =>
      retry(() => withTimeout(fn(), 5_000, label), {
        attempts: 5,
        baseMs: 200,
        capMs: 10_000,
        retryable: isTransientError,
        onRetry: (_e, attempt, delay) =>
          this.logger.warn(`${label} retry ${attempt} in ${delay}ms (transient provider error)`),
      }),
    );
  }

  private async simulate(): Promise<void> {
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    if (Math.random() < this.failureRate) {
      const err = new Error('provider temporarily unavailable') as Error & { status: number };
      err.status = 503;
      throw err;
    }
  }

  async authorize(req: AuthorizeRequest): Promise<PaymentResult> {
    return this.call('payment.authorize', async () => {
      const existing = this.charges.get(req.idempotencyKey);
      if (existing) return existing; // provider-side idempotency

      await this.simulate();

      const result: PaymentResult = {
        providerRef: `mock_${randomUUID()}`,
        status: 'authorized',
        amount: req.amount,
        currency: req.currency,
      };
      this.charges.set(req.idempotencyKey, result);
      this.byRef.set(result.providerRef, result);
      return result;
    });
  }

  async capture(providerRef: string, idempotencyKey: string): Promise<PaymentResult> {
    return this.call('payment.capture', async () => {
      const cached = this.charges.get(idempotencyKey);
      if (cached) return cached;
      await this.simulate();
      const charge = this.byRef.get(providerRef);
      if (!charge) throw new Error(`unknown providerRef ${providerRef}`);
      const result: PaymentResult = { ...charge, status: 'captured' };
      this.byRef.set(providerRef, result);
      this.charges.set(idempotencyKey, result);
      return result;
    });
  }

  async void(providerRef: string, idempotencyKey: string): Promise<PaymentResult> {
    return this.call('payment.void', async () => {
      const cached = this.charges.get(idempotencyKey);
      if (cached) return cached;
      await this.simulate();
      const charge = this.byRef.get(providerRef);
      if (!charge) throw new Error(`unknown providerRef ${providerRef}`);
      const result: PaymentResult = { ...charge, status: 'voided' };
      this.byRef.set(providerRef, result);
      this.charges.set(idempotencyKey, result);
      return result;
    });
  }

  async refund(providerRef: string, amount: number, idempotencyKey: string): Promise<PaymentResult> {
    return this.call('payment.refund', async () => {
      const cached = this.charges.get(idempotencyKey);
      if (cached) return cached;
      await this.simulate();
      const charge = this.byRef.get(providerRef);
      if (!charge) throw new Error(`unknown providerRef ${providerRef}`);
      const result: PaymentResult = { ...charge, status: 'refunded', amount };
      this.byRef.set(providerRef, result);
      this.charges.set(idempotencyKey, result);
      return result;
    });
  }

  /**
   * Verify `t=<unix>,v1=<hex hmac>` over `${timestamp}.${rawBody}`.
   * Constant-time comparison; the caller additionally rejects stale timestamps.
   */
  verifyWebhookSignature(rawBody: string, signature: string, timestamp: string): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }

  /** Helper used by tests and the demo script to forge a valid signature. */
  signWebhook(rawBody: string, timestamp: string): string {
    return createHmac('sha256', this.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  }

  get breakerState() {
    return this.breaker.currentState;
  }
}
