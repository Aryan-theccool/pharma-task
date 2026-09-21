import { Module, forwardRef } from '@nestjs/common';
import { IntegrityController } from './integrity.controller';
import { IntegrityService } from './integrity.service';
import { BookingModule } from '../booking/booking.module';

/**
 * AuditService is provided by the global AuditModule, and DatabaseService by
 * the global InfraModule, so this module only declares what it owns.
 *
 * BookingModule supplies SagaReconcilerService, which backs the dead-letter and
 * manual-reconcile endpoints. `forwardRef` because QueueModule imports both
 * this module and BookingModule, and Nest resolves that pair lazily.
 */
@Module({
  imports: [forwardRef(() => BookingModule)],
  controllers: [IntegrityController],
  providers: [IntegrityService],
  exports: [IntegrityService],
})
export class IntegrityModule {}
