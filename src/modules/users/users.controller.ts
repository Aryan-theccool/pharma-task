import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/users.dto';
import { ConsultationsService } from '../consultations/consultations.service';
import { ListConsultationsQuery } from '../consultations/dto/consultations.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly consultations: ConsultationsService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile (PII decrypted for the owner)' })
  me(@CurrentUser() user: JwtPayload) {
    return this.users.me(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user’s profile' })
  updateMe(@Body() dto: UpdateProfileDto, @CurrentUser() user: JwtPayload) {
    return this.users.updateProfile(user, dto);
  }

  @Get('me/consultations')
  @ApiOperation({ summary: 'The caller’s consultation history' })
  myConsultations(@Query() query: ListConsultationsQuery, @CurrentUser() user: JwtPayload) {
    return this.consultations.listForUser(user, query.status, query.limit, query.cursor);
  }

  @Delete('users/:id/pii')
  @Roles('admin')
  @RequireMfa()
  @Audit({ action: 'user.erase.request', resourceType: 'user', resourceIdFrom: 'id' })
  @ApiOperation({
    summary: 'Right-to-erasure (crypto-shredding)',
    description:
      'Destroys the ability to read a user’s PII while retaining clinical records for the statutory ' +
      '7-year period. Admin + step-up MFA required.',
  })
  erase(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.users.eraseUser(user, id);
  }
}
