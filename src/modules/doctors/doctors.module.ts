import { Module } from '@nestjs/common';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [AvailabilityModule],
  controllers: [DoctorsController],
  providers: [DoctorsService],
  exports: [DoctorsService],
})
export class DoctorsModule {}
