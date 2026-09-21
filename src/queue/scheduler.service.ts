import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../common/outbox/outbox.service';
import { QueueService } from './queue.service';
import { AvailabilityService } from '../modules/availability/availability.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { DatabaseService } from '../infra/database.service';
import { SagaReconcilerService } from '../modules/booking/saga-reconciler.service';
import { IntegrityService } from '../modules/integrity/integrity.service';
import { QUEUE_NOTIFICATIONS, QUEUE_PDF } from './queue.constants';
import { metrics } from '../observability/metrics';

/**
 * Background maintenance.
 *
 * Every job is safe to run on multiple replicas concurrently: the outbox uses
 * SKIP LOCKED, hold release is a single idempotent UPDATE, and partition
 * creation is guarded by IF NOT EXISTS.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly outbox: OutboxService,
    private readonly queues: QueueService,
    private readonly availability: AvailabilityService,
    private readonly idempotency: IdempotencyService,
    private readonly db: DatabaseService,
    private readonly sagaReconciler: SagaReconcilerService,
    private readonly integrity: IntegrityService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('RUN_WORKERS_IN_API', true);
  }

  /** Drain the transactional outbox into BullMQ every 2 seconds. */
  @Cron('*/2 * * * * *')
  async drainOutbox(): Promise<void> {
    if (!this.enabled) return;
    try {
      const events = await this.outbox.claimBatch(50);
      for (const event of events) {
        try {
          const queueName = event.event_type === 'prescription.signed' ? QUEUE_PDF : QUEUE_NOTIFICATIONS;
          await this.queues.byName(queueName).add(
            event.event_type,
            {
              eventId: event.id,
              eventType: event.event_type,
              aggregateId: event.aggregate_id,
              payload: event.payload,
              traceId: event.trace_id,
            },
            { jobId: `outbox-${event.id}` }, // producer-side dedupe
          );
          await this.outbox.markPublished(event.id);
          metrics.outboxPublished.inc({ event_type: event.event_type });
        } catch (error) {
          await this.outbox.markFailed(event.id, (error as Error).message);
        }
      }
      metrics.outboxPending.set(await this.outbox.pendingCount());
    } catch (error) {
      this.logger.warn(`outbox drain failed: ${(error as Error).message}`);
    }
  }

  /** Release expired slot holds every 30 seconds. */
  @Cron('*/30 * * * * *')
  async releaseHolds(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.availability.releaseExpiredHolds();
    } catch (error) {
      this.logger.warn(`hold release failed: ${(error as Error).message}`);
    }
  }

  /** Purge expired idempotency keys hourly. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeIdempotency(): Promise<void> {
    if (!this.enabled) return;
    const removed = await this.idempotency.purgeExpired();
    if (removed) this.logger.log(`purged ${removed} expired idempotency keys`);
  }

  /** Refresh analytics materialized views hourly, off the OLTP path. */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshAnalytics(): Promise<void> {
    if (!this.enabled) return;
    await this.queues.analytics.add(
      'refresh',
      {},
      { jobId: `analytics-${new Date().toISOString().slice(0, 13)}` },
    );
  }

  /**
   * Recover sagas abandoned by a crashed process (every minute).
   *
   * The in-request catch block cannot run if the process was killed, so
   * without this a half-finished booking holds a slot and an authorization
   * forever. Safe on every replica: claims use FOR UPDATE SKIP LOCKED.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileSagas(): Promise<void> {
    if (!this.enabled) return;
    try {
      const result = await this.sagaReconciler.reconcile();
      if (result.recovered || result.deadLettered) {
        this.logger.warn(
          `saga reconciliation: ${result.recovered} recovered, ${result.deadLettered} dead-lettered`,
        );
      }
    } catch (error) {
      this.logger.error(`saga reconciliation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Run one sweep at startup.
   *
   * Without this, `clinical_integrity_last_run_timestamp_seconds` stays at 0
   * until the first cron boundary, so the "sweep stalled" alert — which
   * compares `time()` against that gauge — fires on every deploy. A false page
   * on a security alert is worse than no alert: it teaches the on-call to
   * dismiss it. Deliberately not awaited, so a slow sweep cannot delay
   * readiness.
   */
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.verifyClinicalIntegrity().catch(() => undefined);
  }

  /**
   * Sweep clinical rows for tampering (every 5 minutes).
   *
   * Detects writes that did not come from the application — the control that
   * closes the \"direct SQL tampering is not detected\" gap. Findings raise the
   * `clinical_integrity_findings` gauge, which pages immediately.
   */
  @Cron('0 */5 * * * *')
  async verifyClinicalIntegrity(): Promise<void> {
    if (!this.enabled) return;
    try {
      const report = await this.integrity.verify();
      if (!report.ok) {
        this.logger.error(
          { summary: report.summary },
          'CLINICAL INTEGRITY VIOLATION — see GET /api/v1/admin/integrity/verify',
        );
      }
    } catch (error) {
      this.logger.error(`integrity sweep failed: ${(error as Error).message}`);
    }
  }

  /**
   * Seal the integrity journal every 15 minutes so later deletions are
   * detectable. Cheap: one fold over rows added since the last checkpoint.
   */
  @Cron('0 */15 * * * *')
  async checkpointIntegrityJournal(): Promise<void> {
    if (!this.enabled) return;
    try {
      const result = await this.integrity.checkpoint();
      if (result.created) {
        this.logger.log(`integrity checkpoint sealed entries ${result.from}..${result.to}`);
      }
    } catch (error) {
      this.logger.warn(`integrity checkpoint failed: ${(error as Error).message}`);
    }
  }

  /** Create next months' partitions ahead of time (daily at 02:00). */
  @Cron('0 0 2 * * *')
  async ensurePartitions(): Promise<void> {
    if (!this.enabled) return;
    for (let i = 0; i <= 3; i++) {
      for (const table of ['consultations', 'audit_logs']) {
        await this.db.query(
          `SELECT ensure_monthly_partition($1::regclass, now() + make_interval(months => $2))`,
          [table, i],
        );
      }
    }
    this.logger.log('monthly partitions ensured up to +3 months');
  }
}
