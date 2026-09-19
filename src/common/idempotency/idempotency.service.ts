import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../infra/database.service';
import { canonicalJson } from '../utils/canonical-json';

export interface IdempotencyRecord {
  key: string;
  request_hash: string;
  status: 'in_progress' | 'completed' | 'failed';
  response_status: number | null;
  response_body: unknown;
}

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; existing: IdempotencyRecord };

/**
 * Durable idempotency store.
 *
 * The claim is a single atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
 * so two concurrent requests with the same key can never both proceed: exactly
 * one wins the insert, the other reads the existing row. Postgres (not Redis)
 * is the source of truth because a replayed response must survive a cache
 * flush; Redis is only a read-through accelerator.
 */
@Injectable()
export class IdempotencyService {
  private readonly ttlHours: number;

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService,
  ) {
    this.ttlHours = config.get<number>('IDEMPOTENCY_TTL_HOURS', 24);
  }

  /**
   * Stable fingerprint of the request payload for replay-safety checks.
   *
   * Canonical (key-sorted) serialisation matters here: a client retrying the
   * exact same logical request must not be rejected with 409 merely because its
   * JSON serialiser emitted the object keys in a different order.
   */
  static fingerprint(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload ?? {})).digest('hex');
  }

  /** Scope keys per user + endpoint so one tenant cannot squat another's key. */
  static scope(userId: string | null, endpoint: string, key: string): string {
    return `${userId ?? 'anon'}:${endpoint}:${key}`;
  }

  async claim(
    scopedKey: string,
    userId: string | null,
    endpoint: string,
    requestHash: string,
  ): Promise<ClaimResult> {
    const inserted = await this.db.query<{ key: string }>(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'in_progress', now() + ($5 || ' hours')::interval)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [scopedKey, userId, endpoint, requestHash, String(this.ttlHours)],
    );

    if (inserted.rowCount === 1) return { claimed: true };

    const existing = await this.db.query<IdempotencyRecord>(
      `SELECT key, request_hash, status, response_status, response_body
         FROM idempotency_keys
        WHERE key = $1`,
      [scopedKey],
    );

    // Row expired and was swept between the INSERT and the SELECT — retry once.
    if (existing.rowCount === 0) {
      const retry = await this.db.query<{ key: string }>(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, 'in_progress', now() + ($5 || ' hours')::interval)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [scopedKey, userId, endpoint, requestHash, String(this.ttlHours)],
      );
      if (retry.rowCount === 1) return { claimed: true };
      throw new Error('idempotency claim race could not be resolved');
    }

    return { claimed: false, existing: existing.rows[0] };
  }

  async complete(scopedKey: string, status: number, body: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_status = $2, response_body = $3::jsonb, completed_at = now()
        WHERE key = $1`,
      [scopedKey, status, JSON.stringify(body ?? null)],
    );
  }

  /**
   * Release the claim after a failure so the client can retry the same key.
   * Deleting (rather than marking failed) is deliberate: a 500 means we do not
   * know whether the effect happened, and the caller's retry re-runs the same
   * guarded path. Business-rule 4xx are also released — the request was
   * rejected before any state change.
   */
  async release(scopedKey: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE key = $1 AND status = 'in_progress'`, [
      scopedKey,
    ]);
  }

  async purgeExpired(): Promise<number> {
    const res = await this.db.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    return res.rowCount ?? 0;
  }
}
