import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConsultationsService } from './consultations.service';
import { ListConsultationsQuery, UpdateNotesDto } from './dto/consultations.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('consultations')
@ApiBearerAuth()
@Controller('consultations')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List consultations visible to the caller',
    description: 'Patients see their own; doctors see theirs; admins see all. Cursor paginated.',
  })
  list(@Query() query: ListConsultationsQuery, @CurrentUser() user: JwtPayload) {
    return this.consultations.listForUser(user, query.status, query.limit, query.cursor);
  }

  @Get(':id')
  @Audit({ action: 'consultation.read', resourceType: 'consultation', resourceIdFrom: 'id' })
  @ApiOperation({
    summary: 'Fetch a consultation including decrypted clinical notes',
    description: 'PHI access is always written to the append-only audit log.',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.consultations.findById(id, user);
  }

  @Post(':id/start')
  @HttpCode(200)
  @Roles('doctor', 'admin')
  @ApiOperation({ summary: 'Start the consultation (scheduled → in_progress)' })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.consultations.start(id, user);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Roles('doctor', 'admin')
  @ApiOperation({ summary: 'Complete the consultation (in_progress → completed)' })
  complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.consultations.complete(id, user);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @Roles('doctor', 'admin')
  @ApiOperation({ summary: 'Mark the patient as a no-show (scheduled → no_show)' })
  noShow(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.consultations.markNoShow(id, user);
  }

  @Patch(':id/notes')
  @Roles('doctor', 'admin')
  @ApiOperation({
    summary: 'Write clinical notes (treating doctor only)',
    description: 'Notes are PHI and are stored AES-256-GCM encrypted with a versioned key envelope.',
  })
  updateNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.consultations.updateNotes(id, user, dto.notes);
  }
}
