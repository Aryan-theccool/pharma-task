import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import { currentTraceIds } from '../../observability/tracing';
import { canonicalJson } from '../../common/utils/canonical-json';
import type { UserRole } from '../../common/types/authenticated-request';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Append-only, tamper-evident audit trail.
 *
 * Every row carries `row_hash = SHA256(prev_hash || canonical(entry))`, so the
 * log forms a hash chain: altering or deleting any historical row breaks
 * verification for every subsequent row. The chain head is cached in Redis to
 * avoid a "SELECT last row" round-trip on the hot path, and a Redis lock
 * serialises appends so concurrent writers can't fork the chain.
 *
 * The runtime DB role additionally has UPDATE/DELETE revoked on audit_logs
 * (see db/migrations/0004_grants.sql) — defence in depth against a compromised
 * application credential.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private static readonly HEAD_KEY = 'audit:chain:head';
  private static readonly LOCK_KEY = 'audit:chain:lock';

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Deterministic serialisation so the hash is reproducible during verify.
   *
   * `canonicalJson` (not `JSON.stringify`) is essential for the `before`/`after`
   * documents: Postgres normalises `jsonb` key order on storage, so hashing the
   * raw insertion order would never match what we read back.
   */
  private canonical(entry: AuditEntry, occurredAt: string, traceId?: string): string {
    return canonicalJson([
      occurredAt,
      entry.actorId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.outcome ?? 'success',
      entry.ip ?? null,
      entry.requestId ?? null,
      traceId ?? null,
      entry.before ?? null,
      entry.after ?? null,
    ]);
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.append(entry);
    } catch (err) {
      // Auditing must never break the business request; alert instead.
      this.logger.error({ err, action: entry.action }, 'failed to append audit log');
    }
  }

  private async append(entry: AuditEntry): Promise<void> {
    const { traceId } = currentTraceIds();
    const occurredAt = new Date().toISOString();

    const token = await this.redis.acquireLock(AuditService.LOCK_KEY, 3_000);
    try {
      const prevHash = await this.chainHead();
      const payload = this.canonical(entry, occurredAt, traceId);
      const rowHash = createHash('sha256')
        .update(prevHash ?? Buffer.alloc(0))
        .update(payload)
        .digest();

      await this.db.query(
        `INSERT INTO audit_logs
           (occurred_at, actor_id, actor_role, action, resource_type, resource_id, outcome,
            ip, user_agent, request_id, trace_id, before, after, prev_hash, row_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)`,
        [
          occurredAt,
          entry.actorId ?? null,
          entry.actorRole ?? null,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.outcome ?? 'success',
          entry.ip ?? null,
          entry.userAgent ?? null,
          entry.requestId ?? null,
          traceId ?? null,
          entry.before ? canonicalJson(entry.before) : null,
          entry.after ? canonicalJson(entry.after) : null,
          prevHash,
          rowHash,
        ],
      );

      await this.redis.client.set(AuditService.HEAD_KEY, rowHash.toString('hex'));
    } finally {
      if (token) await this.redis.releaseLock(AuditService.LOCK_KEY, token);
    }
  }

  private async chainHead(): Promise<Buffer | null> {
    const cached = await this.redis.client.get(AuditService.HEAD_KEY);
    if (cached) return Buffer.from(cached, 'hex');
    const res = await this.db.query<{ row_hash: Buffer }>(
      `SELECT row_hash FROM audit_logs ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    return res.rows[0]?.row_hash ?? null;
  }

  /**
   * Recompute the chain and report the first divergence, if any.
   * Exposed to admins via GET /admin/audit-logs/verify.
   */
  async verifyChain(limit = 1000): Promise<{
    verified: boolean;
    checked: number;
    brokenAtId?: string;
  }> {
    const res = await this.db.query<{
      id: string;
      occurred_at: Date;
      actor_id: string | null;
      actor_role: UserRole | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      outcome: string;
      ip: string | null;
      request_id: string | null;
      trace_id: string | null;
      before: unknown;
      after: unknown;
      prev_hash: Buffer | null;
      row_hash: Buffer;
    }>(
      `SELECT id, occurred_at, actor_id, actor_role, action, resource_type, resource_id, outcome,
              host(ip) AS ip, request_id, trace_id, before, after, prev_hash, row_hash
         FROM audit_logs
        ORDER BY occurred_at ASC, id ASC
        LIMIT $1`,
      [limit],
    );

    let expectedPrev: Buffer | null = null;
    for (const row of res.rows) {
      if (expectedPrev !== null) {
        if (!row.prev_hash || !row.prev_hash.equals(expectedPrev)) {
          return { verified: false, checked: res.rows.length, brokenAtId: row.id };
        }
      }
      const payload = this.canonical(
        {
          actorId: row.actor_id,
          actorRole: row.actor_role,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          outcome: row.outcome as AuditEntry['outcome'],
          ip: row.ip,
          requestId: row.request_id,
          before: row.before,
          after: row.after,
        },
        row.occurred_at.toISOString(),
        row.trace_id ?? undefined,
      );
      const computed = createHash('sha256')
        .update(row.prev_hash ?? Buffer.alloc(0))
        .update(payload)
        .digest();
      if (!computed.equals(row.row_hash)) {
        return { verified: false, checked: res.rows.length, brokenAtId: row.id };
      }
      expectedPrev = row.row_hash;
    }
    return { verified: true, checked: res.rows.length };
  }

  async query(filters: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    from?: string;
    to?: string;
    limit: number;
    cursor?: string;
  }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (filters.actorId) add('actor_id = $?', filters.actorId);
    if (filters.action) add('action = $?', filters.action);
    if (filters.resourceType) add('resource_type = $?', filters.resourceType);
    if (filters.from) add('occurred_at >= $?', filters.from);
    if (filters.to) add('occurred_at <= $?', filters.to);
    if (filters.cursor) add('id < $?', filters.cursor);

    params.push(filters.limit + 1);
    const sql = `
      SELECT id, occurred_at, actor_id, actor_role, action, resource_type, resource_id, outcome,
             host(ip) AS ip, request_id, trace_id, encode(row_hash,'hex') AS row_hash
        FROM audit_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT $${params.length}`;

    const res = await this.db.queryReplica(sql, params);
    const rows = res.rows.slice(0, filters.limit);
    const nextCursor = res.rows.length > filters.limit ? String(rows[rows.length - 1].id) : null;
    return { items: rows, nextCursor };
  }
}
