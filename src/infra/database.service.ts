import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { metrics } from '../observability/metrics';

export type SqlParams = ReadonlyArray<unknown>;

/**
 * Thin, typed wrapper over pg with:
 *  - primary/replica routing (`queryReplica` for read-only traffic)
 *  - transaction helper with automatic retry on serialization/deadlock errors
 *  - pool telemetry exposed to Prometheus
 *
 * Only parameterised queries are issued — no string interpolation of user input.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly primary: Pool;
  private readonly replica: Pool;
  readonly hasReplica: boolean;

  constructor(private readonly config: ConfigService) {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    const max = this.config.get<number>('DATABASE_POOL_MAX', 20);
    const statementTimeout = this.config.get<number>('DATABASE_STATEMENT_TIMEOUT_MS', 10_000);

    this.primary = new Pool({
      connectionString,
      max,
      statement_timeout: statementTimeout,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'amrutam-api',
    });

    const replicaUrl = this.config.get<string>('DATABASE_REPLICA_URL');
    this.hasReplica = Boolean(replicaUrl);
    this.replica = this.hasReplica
      ? new Pool({
          connectionString: replicaUrl,
          max,
          statement_timeout: statementTimeout,
          application_name: 'amrutam-api-ro',
        })
      : this.primary;

    this.primary.on('error', (err) => this.logger.error({ err }, 'postgres pool error'));
  }

  async onModuleInit(): Promise<void> {
    await this.primary.query('SELECT 1');
    metrics.registerDbPoolCollector(() => ({
      total: this.primary.totalCount,
      idle: this.primary.idleCount,
      waiting: this.primary.waitingCount,
    }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.primary.end().catch(() => undefined);
    if (this.hasReplica) await this.replica.end().catch(() => undefined);
  }

  /** Query the primary (writer). */
  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: SqlParams = []) {
    const stop = metrics.dbQueryDuration.startTimer();
    try {
      return await this.primary.query<T>(text, params as unknown[]);
    } finally {
      stop();
    }
  }

  /** Query the read replica when one is configured, else the primary. */
  async queryReplica<T extends QueryResultRow = QueryResultRow>(text: string, params: SqlParams = []) {
    const stop = metrics.dbQueryDuration.startTimer();
    try {
      return await this.replica.query<T>(text, params as unknown[]);
    } finally {
      stop();
    }
  }

  /**
   * Run `fn` inside a transaction. Retries transient 40001 (serialization
   * failure) / 40P01 (deadlock) up to `retries` times with jittered backoff.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>, retries = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const client = await this.primary.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        lastError = error;
        const code = (error as { code?: string }).code;
        if ((code === '40001' || code === '40P01') && attempt < retries) {
          const delay = 50 * 2 ** attempt + Math.random() * 50;
          metrics.dbTxRetries.inc();
          this.logger.warn(`transient tx error ${code}, retry ${attempt + 1} in ${Math.round(delay)}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  async healthCheck(): Promise<boolean> {
    const res = await this.primary.query('SELECT 1 AS ok');
    return res.rows[0]?.ok === 1;
  }

  get poolStats() {
    return {
      total: this.primary.totalCount,
      idle: this.primary.idleCount,
      waiting: this.primary.waitingCount,
    };
  }
}
