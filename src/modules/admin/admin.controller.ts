import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AuditService } from '../audit/audit.service';
import { AuditQueryDto, AnalyticsWindowDto } from './dto/admin.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { Audit } from '../../common/decorators/audit.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('admin')
@RequireMfa()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('analytics/overview')
  @ApiOperation({ summary: 'Platform KPI overview (60s cache)' })
  overview() {
    return this.admin.overview();
  }

  @Get('analytics/revenue')
  @ApiOperation({ summary: 'Daily revenue series from the materialized view' })
  revenue(@Query() query: AnalyticsWindowDto) {
    return this.admin.revenue(query.days ?? 30);
  }

  @Get('analytics/doctor-utilization')
  @ApiOperation({ summary: 'Slot utilisation ranked by doctor' })
  utilization(@Query() query: AnalyticsWindowDto) {
    return this.admin.doctorUtilization(query.limit ?? 20);
  }

  @Get('analytics/funnel')
  @ApiOperation({ summary: 'Booking conversion funnel: hold → confirm → complete' })
  funnel(@Query() query: AnalyticsWindowDto) {
    return this.admin.funnel(query.days ?? 7);
  }

  @Post('analytics/refresh')
  @ApiOperation({ summary: 'Force a refresh of the analytics materialized views' })
  async refresh() {
    await this.admin.refreshMaterializedViews();
    return { refreshed: true };
  }

  @Get('audit-logs')
  @Audit({ action: 'audit.query', resourceType: 'audit_log' })
  @ApiOperation({
    summary: 'Query the append-only audit trail',
    description: 'Filter by actor, action, resource type and time window. Cursor paginated.',
  })
  auditLogs(@Query() query: AuditQueryDto) {
    return this.audit.query({
      actorId: query.actor,
      action: query.action,
      resourceType: query.resourceType,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 50,
      cursor: query.cursor,
    });
  }

  @Get('audit-logs/verify')
  @ApiOperation({
    summary: 'Verify the tamper-evident hash chain',
    description:
      'Recomputes SHA-256(prev_hash ‖ row) for every entry and reports the first divergence. ' +
      'Any deletion or edit of a historical row is detected here.',
  })
  verifyChain() {
    return this.audit.verifyChain(5_000);
  }
}
