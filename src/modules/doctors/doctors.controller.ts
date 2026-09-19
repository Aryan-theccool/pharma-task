import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DoctorsService } from './doctors.service';
import { AvailabilityService } from '../availability/availability.service';
import {
  BlockSlotDto,
  CreateAvailabilityRuleDto,
  MaterializeSlotsDto,
  OnboardDoctorDto,
  SearchDoctorsQuery,
  SlotQueryDto,
  UpdateDoctorDto,
} from './dto/doctors.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('doctors')
@Controller('doctors')
export class DoctorsController {
  constructor(
    private readonly doctors: DoctorsService,
    private readonly availability: AvailabilityService,
  ) {}

  @Public()
  @Get('search')
  @RateLimit({ limit: 120, windowSeconds: 60, scope: 'ip' })
  @ApiOperation({
    summary: 'Search and filter doctors',
    description:
      'Full-text + trigram search with specialization/language/fee/rating/availability filters, ' +
      'facet counts and keyset (cursor) pagination. Results are cached for 60s in Redis.',
  })
  search(@Query() query: SearchDoctorsQuery) {
    return this.doctors.search(query);
  }

  @Post('onboard')
  @Roles('doctor', 'admin')
  @Audit({ action: 'doctor.onboard', resourceType: 'doctor' })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create the doctor profile for the current account' })
  onboard(@Body() dto: OnboardDoctorDto, @CurrentUser() user: JwtPayload) {
    return this.doctors.onboard(user, dto);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Fetch a doctor profile (cache-aside, 10 min TTL)' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.findById(id);
  }

  @Patch(':id')
  @Roles('doctor', 'admin')
  @Audit({ action: 'doctor.update', resourceType: 'doctor', resourceIdFrom: 'id' })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a doctor profile',
    description: 'Doctors may only edit their own profile. Verification state is admin-only.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDoctorDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.doctors.update(id, user, dto);
  }

  // ------------------------------------------------------------ availability

  @Post(':id/availability-rules')
  @Roles('doctor', 'admin')
  @Audit({ action: 'availability.rule.create', resourceType: 'doctor', resourceIdFrom: 'id' })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a recurring availability rule',
    description: 'Authored in the doctor’s local timezone; materialised slots are stored in UTC.',
  })
  async createRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAvailabilityRuleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const doctor = await this.assertOwnership(id, user);
    return this.availability.createRule(doctor, dto);
  }

  @Get(':id/availability-rules')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List a doctor’s active availability rules' })
  listRules(@Param('id', ParseUUIDPipe) id: string) {
    return this.availability.listRules(id);
  }

  @Delete(':id/availability-rules/:ruleId')
  @Roles('doctor', 'admin')
  @HttpCode(204)
  @Audit({ action: 'availability.rule.delete', resourceType: 'doctor', resourceIdFrom: 'id' })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deactivate an availability rule' })
  async deleteRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const doctor = await this.assertOwnership(id, user);
    await this.availability.deleteRule(doctor, ruleId);
  }

  @Post(':id/slots/materialize')
  @Roles('doctor', 'admin')
  @Audit({ action: 'availability.materialize', resourceType: 'doctor', resourceIdFrom: 'id' })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Expand availability rules into bookable slots',
    description: 'Idempotent — re-running never duplicates slots (guarded by an EXCLUDE constraint).',
  })
  async materialize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MaterializeSlotsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const doctor = await this.assertOwnership(id, user);
    return this.availability.materialize(doctor, dto.from, dto.days);
  }

  @Public()
  @Get(':id/slots')
  @ApiOperation({ summary: 'List a doctor’s slots in a time window (30s cache)' })
  listSlots(@Param('id', ParseUUIDPipe) id: string, @Query() query: SlotQueryDto) {
    return this.availability.listSlots(id, query.from, query.to, query.status);
  }

  @Post(':id/slots/block')
  @Roles('doctor', 'admin')
  @Audit({ action: 'availability.block', resourceType: 'doctor', resourceIdFrom: 'id' })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Block a time range (leave). Only free slots are affected.' })
  async block(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockSlotDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const doctor = await this.assertOwnership(id, user);
    return this.availability.blockRange(doctor, dto.from, dto.to);
  }

  /** Admins act on any doctor; a doctor only on their own record. */
  private async assertOwnership(doctorId: string, user: JwtPayload): Promise<string> {
    if (user.role === 'admin') return doctorId;
    const own = await this.doctors.requireOwnDoctor(user);
    if (own.id !== doctorId) {
      const { ForbiddenException } = await import('@nestjs/common');
      throw new ForbiddenException({ title: 'You may only manage your own availability' });
    }
    return own.id;
  }
}
