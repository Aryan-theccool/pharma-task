/**
 * Payment provider port.
 *
 * The domain depends on this interface, never on a concrete SDK, so swapping
 * the mock for Razorpay/Stripe is a single-provider change with no impact on
 * the booking saga (see docs/adr/0005-payment-adapter.md).
 *
 * Every method takes an `idempotencyKey`: retries after a timeout must never
 * double-charge a patient.
 */
export interface AuthorizeRequest {
  idempotencyKey: string;
  amount: number;
  currency: string;
  patientId: string;
  bookingRef: string;
}

export interface PaymentResult {
  providerRef: string;
  status: 'authorized' | 'captured' | 'failed' | 'voided' | 'refunded';
  amount: number;
  currency: string;
  failureReason?: string;
}

export interface PaymentGateway {
  readonly name: string;
  authorize(req: AuthorizeRequest): Promise<PaymentResult>;
  capture(providerRef: string, idempotencyKey: string): Promise<PaymentResult>;
  void(providerRef: string, idempotencyKey: string): Promise<PaymentResult>;
  refund(providerRef: string, amount: number, idempotencyKey: string): Promise<PaymentResult>;
  verifyWebhookSignature(rawBody: string, signature: string, timestamp: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
