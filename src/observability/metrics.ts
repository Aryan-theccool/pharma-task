import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus registry + the RED metrics and domain counters that back the
 * committed Grafana dashboard (observability/grafana/dashboards/*.json).
 */
class Metrics {
  readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  });

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
  });

  readonly httpRequestsInFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'In-flight HTTP requests',
  });

  // ------------------------------------------------------------- domain

  readonly bookingAttempts = new Counter({
    name: 'booking_attempts_total',
    help: 'Booking attempts by result',
    labelNames: ['stage', 'result'] as const, // stage: hold|confirm|cancel|reschedule
  });

  readonly bookingConflicts = new Counter({
    name: 'booking_conflicts_total',
    help: 'Booking conflicts (slot already taken / lost race)',
    labelNames: ['defence'] as const, // redis_lock | row_lock | db_constraint | state
  });

  readonly bookingDuration = new Histogram({
    name: 'booking_duration_seconds',
    help: 'End-to-end booking stage duration',
    labelNames: ['stage'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  readonly idempotencyEvents = new Counter({
    name: 'idempotency_events_total',
    help: 'Idempotency interceptor outcomes',
    labelNames: ['outcome'] as const, // miss | replay | conflict | in_progress
  });

  readonly sagaSteps = new Counter({
    name: 'saga_steps_total',
    help: 'Saga step executions',
    labelNames: ['saga', 'step', 'result'] as const,
  });

  readonly sagaCompensations = new Counter({
    name: 'saga_compensations_total',
    help: 'Saga compensating actions executed',
    labelNames: ['saga', 'step'] as const,
  });

  readonly authEvents = new Counter({
    name: 'auth_events_total',
    help: 'Authentication events',
    labelNames: ['event', 'result'] as const,
  });

  readonly rateLimitRejections = new Counter({
    name: 'rate_limit_rejections_total',
    help: 'Requests rejected by the rate limiter',
    labelNames: ['scope'] as const,
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_events_published_total',
    help: 'Outbox events successfully published',
    labelNames: ['event_type'] as const,
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending_events',
    help: 'Outbox events awaiting publication',
  });

  readonly queueJobs = new Counter({
    name: 'queue_jobs_total',
    help: 'Queue jobs processed',
    labelNames: ['queue', 'result'] as const,
  });

  readonly queueJobDuration = new Histogram({
    name: 'queue_job_duration_seconds',
    help: 'Queue job processing duration',
    labelNames: ['queue'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15],
  });

  readonly queueDepth = new Gauge({
    name: 'queue_depth',
    help: 'Pending jobs per queue',
    labelNames: ['queue', 'state'] as const,
  });

  readonly cacheEvents = new Counter({
    name: 'cache_events_total',
    help: 'Cache hits and misses',
    labelNames: ['cache', 'result'] as const,
  });

  readonly dbQueryDuration = new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  });

  readonly dbTxRetries = new Counter({
    name: 'db_transaction_retries_total',
    help: 'Transactions retried after a transient serialization/deadlock error',
  });

  readonly dbPoolTotal = new Gauge({ name: 'db_pool_total', help: 'Total pooled connections' });
  readonly dbPoolIdle = new Gauge({ name: 'db_pool_idle', help: 'Idle pooled connections' });
  readonly dbPoolWaiting = new Gauge({ name: 'db_pool_waiting', help: 'Requests waiting for a connection' });

  readonly circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['breaker'] as const,
  });

  readonly encryptedFieldOps = new Counter({
    name: 'encrypted_field_operations_total',
    help: 'Field-level encryption operations',
    labelNames: ['operation'] as const,
  });

  private poolCollector?: () => { total: number; idle: number; waiting: number };

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'amrutam_' });
    for (const metric of [
      this.httpRequestDuration,
      this.httpRequestsTotal,
      this.httpRequestsInFlight,
      this.bookingAttempts,
      this.bookingConflicts,
      this.bookingDuration,
      this.idempotencyEvents,
      this.sagaSteps,
      this.sagaCompensations,
      this.authEvents,
      this.rateLimitRejections,
      this.outboxPublished,
      this.outboxPending,
      this.queueJobs,
      this.queueJobDuration,
      this.queueDepth,
      this.cacheEvents,
      this.dbQueryDuration,
      this.dbTxRetries,
      this.dbPoolTotal,
      this.dbPoolIdle,
      this.dbPoolWaiting,
      this.circuitBreakerState,
      this.encryptedFieldOps,
    ]) {
      this.registry.registerMetric(metric as never);
    }
  }

  registerDbPoolCollector(fn: () => { total: number; idle: number; waiting: number }): void {
    this.poolCollector = fn;
  }

  async scrape(): Promise<string> {
    if (this.poolCollector) {
      const stats = this.poolCollector();
      this.dbPoolTotal.set(stats.total);
      this.dbPoolIdle.set(stats.idle);
      this.dbPoolWaiting.set(stats.waiting);
    }
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

export const metrics = new Metrics();
