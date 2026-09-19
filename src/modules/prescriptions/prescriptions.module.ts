import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { ConsultationPrescriptionsController } from './consultation-prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';

@Module({
  controllers: [PrescriptionsController, ConsultationPrescriptionsController],
  providers: [PrescriptionsService],
  exports: [PrescriptionsService],
})
export class PrescriptionsModule {}
