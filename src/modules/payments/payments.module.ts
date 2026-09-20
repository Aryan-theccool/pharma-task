import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockPaymentGateway } from './mock-payment.gateway';
import { RazorpayGateway } from './razorpay.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';

/**
 * The concrete provider is selected at boot from PAYMENT_PROVIDER, so moving
 * from the in-memory gateway to a real PSP is a configuration change with no
 * code edit and no redeploy of the domain layer.
 *
 * `mock` is refused outside development/test: shipping to production with the
 * in-memory gateway would mean every booking succeeds without money moving,
 * which is the kind of failure nobody notices until reconciliation. Failing at
 * boot makes it impossible.
 */
@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    MockPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, MockPaymentGateway],
      useFactory: (config: ConfigService, mock: MockPaymentGateway): PaymentGateway => {
        const provider = config.get<string>('PAYMENT_PROVIDER', 'mock');
        const env = config.get<string>('NODE_ENV', 'development');
        const logger = new Logger('PaymentsModule');

        if (provider === 'razorpay') {
          logger.log('payment provider: razorpay (live HTTP adapter)');
          return new RazorpayGateway(config);
        }

        if (env === 'production') {
          throw new Error(
            `PAYMENT_PROVIDER="${provider}" is not permitted in production. ` +
              'Set PAYMENT_PROVIDER=razorpay and supply RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
          );
        }

        logger.warn(`payment provider: ${provider} (in-memory; no money moves)`);
        return mock;
      },
    },
  ],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
