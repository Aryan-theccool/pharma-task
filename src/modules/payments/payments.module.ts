import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockPaymentGateway } from './mock-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway.interface';

/**
 * The concrete provider is bound to the PAYMENT_GATEWAY token, so swapping in
 * Razorpay/Stripe is a one-line change here and nowhere else.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, MockPaymentGateway, { provide: PAYMENT_GATEWAY, useClass: MockPaymentGateway }],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
