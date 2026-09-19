import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { DEFAULT_JOB_OPTIONS, QUEUE_ANALYTICS, QUEUE_NOTIFICATIONS, QUEUE_PDF } from './queue.constants';
import { metrics } from '../observability/metrics';

/**
 * Producer-side queue access plus depth telemetry.
 *
 * BullMQ needs its own ioredis connection with `maxRetriesPerRequest: null`,
 * so it does not share the application cache client.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly connection: Redis;
  readonly notifications: Queue;
  readonly pdf: Queue;
  readonly analytics: Queue;
  private depthTimer?: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    const opts = { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS };
    this.notifications = new Queue(QUEUE_NOTIFICATIONS, opts);
    this.pdf = new Queue(QUEUE_PDF, opts);
    this.analytics = new Queue(QUEUE_ANALYTICS, opts);
  }

  onModuleInit(): void {
    // Export queue depth for the Grafana panel and the queue-lag alert.
    this.depthTimer = setInterval(() => {
      void this.publishDepth();
    }, 10_000);
    this.depthTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.depthTimer) clearInterval(this.depthTimer);
    await Promise.all([
      this.notifications.close(),
      this.pdf.close(),
      this.analytics.close(),
    ]).catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }

  byName(name: string): Queue {
    switch (name) {
      case QUEUE_PDF:
        return this.pdf;
      case QUEUE_ANALYTICS:
        return this.analytics;
      default:
        return this.notifications;
    }
  }

  private async publishDepth(): Promise<void> {
    for (const queue of [this.notifications, this.pdf, this.analytics]) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, value] of Object.entries(counts)) {
          metrics.queueDepth.set({ queue: queue.name, state }, Number(value ?? 0));
        }
      } catch {
        // Redis unavailable — the readiness probe surfaces it.
      }
    }
  }
}
