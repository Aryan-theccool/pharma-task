import { Module } from '@nestjs/common';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';
import { JoinTokenService } from './join-token.service';

@Module({
  controllers: [ConsultationsController],
  providers: [ConsultationsService, JoinTokenService],
  exports: [ConsultationsService, JoinTokenService],
})
export class ConsultationsModule {}
