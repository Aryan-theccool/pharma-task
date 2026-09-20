import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { SagaService } from './saga.service';
import { SagaReconcilerService } from './saga-reconciler.service';
import { PaymentsModule } from '../payments/payments.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [PaymentsModule, AvailabilityModule],
  controllers: [BookingController],
  providers: [BookingService, SagaService, SagaReconcilerService],
  exports: [BookingService, SagaService, SagaReconcilerService],
})
export class BookingModule {}
