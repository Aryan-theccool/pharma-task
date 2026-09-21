import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { SagaReconcilerService } from '../booking/saga-reconciler.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

/**
 * Clinical integrity verification.
 *
 * Admin-only and MFA-gated by the same guards as the rest of /admin: the
 * report names the rows an attacker touched, which is exactly the map an
 * attacker would like to read.
 */
@ApiTags('integrity')
@ApiBearerAuth()
@Controller('admin/integrity')
@Roles('admin')
@RequireMfa()
export class IntegrityController {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly reconciler: SagaReconcilerService,
    private readonly audit: AuditService,
  ) {}

  @Get('verify')
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Verify clinical-row integrity',
    description:
      'Detects modifications to consultations, prescriptions and payments that did not originate from the application — including writes made with a direct database session, writes made with the capture trigger disabled, and tampering with the journal itself.',
  })
  @ApiResponse({ status: 200, description: 'Integrity report (ok=false when findings exist)' })
  async verify(@CurrentUser() user: JwtPayload, @Query('sinceJournalId') sinceJournalId?: string) {
    const since = sinceJournalId ? Number(sinceJournalId) : 0;
    const report = await this.integrity.verify(Number.isFinite(since) ? since : 0);

    // The verification itself is an auditable event: a reviewer must be able to
    // see who checked, when, and what they were told.
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'integrity.verify',
      resourceType: 'clinical_integrity',
      outcome: report.ok ? 'success' : 'failure',
      after: { ok: report.ok, findings: report.summary, journalEntries: report.journalEntries },
    });

    return report;
  }

  @Post('checkpoint')
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Seal the journal up to the current head',
    description:
      'Folds all journal entries since the last checkpoint into a chained hash, making any later deletion of those entries detectable.',
  })
  async checkpoint(@CurrentUser() user: JwtPayload) {
    const result = await this.integrity.checkpoint();
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'integrity.checkpoint',
      resourceType: 'clinical_integrity',
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  @Get('saga-dead-letters')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Sagas parked for manual intervention',
    description:
      'Sagas the reconciler could not complete or compensate after the configured number of attempts. Each entry needs a human decision; the runbook has the procedure.',
  })
  async deadLetters(@Query('limit') limit?: string) {
    const entries = await this.reconciler.deadLetters(boundedLimit(limit, 50));
    return { count: entries.length, entries };
  }

  @Post('reconcile-sagas')
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Force a saga reconciliation pass',
    description:
      'Runs the recovery sweep immediately instead of waiting for the next scheduled pass. Idempotent and safe to call during an incident.',
  })
  async reconcileNow(@CurrentUser() user: JwtPayload) {
    const result = await this.reconciler.reconcile();
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'saga.reconcile.manual',
      resourceType: 'saga',
      outcome: result.deadLettered > 0 ? 'failure' : 'success',
      after: {
        scanned: result.scanned,
        recovered: result.recovered,
        deadLettered: result.deadLettered,
      },
    });
    return result;
  }

  @Get('history/:table/:rowId')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Mutation history for one clinical row',
    description:
      'Every recorded change to a row, with the database user, client address and whether the write carried a valid proof of application origin.',
  })
  async history(
    @CurrentUser() user: JwtPayload,
    @Param('table') table: string,
    @Param('rowId') rowId: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.integrity.history(table, rowId, boundedLimit(limit, 50));
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'integrity.history',
      resourceType: table,
      resourceId: rowId,
    });
    return result;
  }
}

/**
 * Parse an optional `?limit=` into a sane bound.
 *
 * Deliberately hand-rolled rather than `ParseIntPipe({ optional: true })`: the
 * global ValidationPipe runs first with `forbidNonWhitelisted`, and a
 * parameter-scoped pipe on a primitive never gets the chance to apply its
 * `optional` handling — the request is rejected with a 400 before the handler
 * is reached. Caught by driving the live endpoint rather than by unit tests.
 */
function boundedLimit(raw: string | undefined, fallback: number, max = 200): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
