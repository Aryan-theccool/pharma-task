import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RazorpayGateway, fromMinorUnit, toMinorUnit } from '../../src/modules/payments/razorpay.gateway';

/**
 * Contract test for the live payment adapter.
 *
 * `fetch` is stubbed so the HTTP conversation can be asserted precisely without
 * network access: the URL, method, auth header, idempotency header and body
 * shape are all part of the provider contract, and a silent change to any of
 * them is a production incident (double charges, unvoided authorizations).
 *
 * This proves the adapter speaks Razorpay's documented protocol. It is not a
 * substitute for a sandbox run against the real API — see the header comment
 * on RazorpayGateway and the go-live checklist in docs/RUNBOOK.md.
 */
describe('RazorpayGateway', () => {
  const config = new ConfigService({
    RAZORPAY_BASE_URL: 'https://api.razorpay.test',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test',
    PAYMENT_WEBHOOK_SECRET: 'fallback_secret_at_least_16',
    PAYMENT_TIMEOUT_MS: 2_000,
  });

  let calls: Array<{ url: string; init: RequestInit }>;
  let gateway: RazorpayGateway;

  const stubFetch = (status: number, body: unknown) => {
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `HTTP ${status}`,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    calls = [];
    gateway = new RazorpayGateway(config);
  });

  describe('authorize', () => {
    it('creates an order with the amount in paise and the caller idempotency key', async () => {
      stubFetch(200, { id: 'order_123', amount: 49_900, currency: 'INR', status: 'created' });

      const result = await gateway.authorize({
        idempotencyKey: 'auth:booking-1',
        amount: 499,
        currency: 'INR',
        patientId: 'patient-1',
        bookingRef: 'booking-1',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.razorpay.test/v1/orders');
      expect(calls[0].init.method).toBe('POST');

      const headers = calls[0].init.headers as Record<string, string>;
      // Basic auth is key_id:key_secret, base64.
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`,
      );
      // The header that stops a retry becoming a second charge.
      expect(headers['X-Razorpay-Idempotency']).toBe('auth:booking-1');

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.amount).toBe(49_900); // paise, not rupees
      expect(body.receipt).toBe('booking-1');
      expect(body.payment_capture).toBe(0); // authorize now, capture in the saga

      expect(result).toEqual({
        providerRef: 'order_123',
        status: 'authorized',
        amount: 499,
        currency: 'INR',
      });
    });
  });

  it('captures against the payment id', async () => {
    stubFetch(200, { id: 'pay_9', amount: 49_900, currency: 'INR' });
    const result = await gateway.capture('pay_9', 'capture:booking-1');

    expect(calls[0].url).toBe('https://api.razorpay.test/v1/payments/pay_9/capture');
    expect((calls[0].init.headers as Record<string, string>)['X-Razorpay-Idempotency']).toBe(
      'capture:booking-1',
    );
    expect(result.status).toBe('captured');
    expect(result.amount).toBe(499);
  });

  it('maps void onto a full pre-capture refund', async () => {
    stubFetch(200, { amount: 49_900, currency: 'INR' });
    const result = await gateway.void('pay_9', 'void:booking-1');

    expect(calls[0].url).toBe('https://api.razorpay.test/v1/payments/pay_9/refund');
    expect(result.status).toBe('voided');
  });

  it('sends a partial refund amount in paise', async () => {
    stubFetch(200, { amount: 10_000, currency: 'INR' });
    const result = await gateway.refund('pay_9', 100, 'refund:booking-1');

    expect(JSON.parse(calls[0].init.body as string).amount).toBe(10_000);
    expect(result.status).toBe('refunded');
    expect(result.amount).toBe(100);
  });

  it('percent-encodes the provider reference into the path', async () => {
    stubFetch(200, { id: 'x', amount: 100, currency: 'INR' });
    await gateway.capture('pay/../../admin', 'k');
    expect(calls[0].url).toBe('https://api.razorpay.test/v1/payments/pay%2F..%2F..%2Fadmin/capture');
  });

  describe('error handling', () => {
    it('does not retry a 4xx — a declined card must not be re-attempted', async () => {
      stubFetch(400, { error: { description: 'card declined' } });

      await expect(
        gateway.authorize({
          idempotencyKey: 'k',
          amount: 10,
          currency: 'INR',
          patientId: 'p',
          bookingRef: 'b',
        }),
      ).rejects.toThrow(/razorpay 400: card declined/);

      expect(calls).toHaveLength(1);
    });

    it('retries a 5xx and surfaces the error after exhausting attempts', async () => {
      stubFetch(503, { error: { description: 'service unavailable' } });

      await expect(gateway.capture('pay_1', 'k')).rejects.toThrow(/razorpay 503/);
      // 5 attempts per the retry policy.
      expect(calls).toHaveLength(5);
    }, 30_000);
  });

  describe('webhook signature', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'evt_1' });

    it('accepts a signature computed with the webhook secret', () => {
      const signature = createHmac('sha256', 'whsec_test').update(rawBody).digest('hex');
      expect(gateway.verifyWebhookSignature(rawBody, signature, '0')).toBe(true);
    });

    it('rejects a signature from the wrong key, a wrong body, or no signature', () => {
      const wrongKey = createHmac('sha256', 'nope').update(rawBody).digest('hex');
      const right = createHmac('sha256', 'whsec_test').update(rawBody).digest('hex');

      expect(gateway.verifyWebhookSignature(rawBody, wrongKey, '0')).toBe(false);
      expect(gateway.verifyWebhookSignature('{"event":"other"}', right, '0')).toBe(false);
      expect(gateway.verifyWebhookSignature(rawBody, '', '0')).toBe(false);
      expect(gateway.verifyWebhookSignature(rawBody, 'short', '0')).toBe(false);
    });
  });

  describe('minor-unit conversion', () => {
    it('rounds rather than truncates, so no paisa is lost to floating point', () => {
      // Math.trunc(19.99 * 100) === 1998 in IEEE-754. That undercharge is the
      // bug this function exists to prevent.
      expect(toMinorUnit(19.99)).toBe(1999);
      expect(toMinorUnit(0.1 + 0.2)).toBe(30);
      expect(toMinorUnit(1234.56)).toBe(123_456);
      expect(fromMinorUnit(123_456)).toBe(1234.56);
    });

    it('round-trips every amount in a representative range', () => {
      for (let paise = 0; paise <= 200_000; paise += 137) {
        expect(toMinorUnit(fromMinorUnit(paise))).toBe(paise);
      }
    });
  });
});
