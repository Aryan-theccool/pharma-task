import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrescriptionsService } from './prescriptions.service';
import { CreatePrescriptionDto } from './dto/prescriptions.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('prescriptions')
@ApiBearerAuth()
@Controller('consultations/:id/prescriptions')
export class ConsultationPrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Post()
  @HttpCode(201)
  @Roles('doctor', 'admin')
  @Idempotent()
  @ApiOperation({
    summary: 'Issue a prescription for a consultation',
    description:
      'Treating doctor only. Drug list, diagnosis and advice are encrypted at rest (AES-256-GCM). ' +
      'The prescription stays editable until it is signed.',
  })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePrescriptionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.prescriptions.create(id, user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List prescriptions issued for a consultation' })
  list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.prescriptions.listForConsultation(id, user);
  }
}
