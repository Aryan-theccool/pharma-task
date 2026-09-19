import { Module } from '@nestjs/common';
import { WorkersService } from './workers.service';
import { SchedulerService } from './scheduler.service';
import { PrescriptionsModule } from '../modules/prescriptions/prescriptions.module';
import { AdminModule } from '../modules/admin/admin.module';
import { AvailabilityModule } from '../modules/availability/availability.module';

/**
 * Asynchronous processing: BullMQ consumers plus the cron-driven maintenance
 * jobs (outbox drain, hold expiry, partition pre-creation, MV refresh).
 * Runs in-process locally and as a separate ECS service in production.
 */
@Module({
  imports: [PrescriptionsModule, AdminModule, AvailabilityModule],
  providers: [WorkersService, SchedulerService],
  exports: [WorkersService],
})
export class QueueModule {}
