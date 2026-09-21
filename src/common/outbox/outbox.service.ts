import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../infra/database.service';
import { currentTraceIds } from '../../observability/tracing';

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox.
 *
 * Domain state and its resulting event are written in the SAME database
 * transaction, which removes the dual-write problem: it is impossible to
 * confirm a booking without also enqueuing its notification, or to send a
 * notification for a booking that rolled back.
 *
 * A background drainer (OutboxWorker) publishes rows to BullMQ at-least-once;
 * consumers dedupe on event id, making the end-to-end path effectively
 * exactly-once. The active W3C trace id is stored with the event so the async
 * work stays attached to the originating request's trace.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly db: DatabaseService) {}

  /** Enlist an event in the caller's transaction. */
  async emit(client: PoolClient, event: OutboxEvent): Promise<string> {
    const { traceId } = currentTraceIds();
    const res = await client.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, trace_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        traceId ?? null,
      ],
    );
    return res.rows[0].id;
  }

  /** Emit outside an existing transaction (own single-statement tx). */
  async emitStandalone(event: OutboxEvent): Promise<string> {
    return this.db.transaction((client) => this.emit(client, event));
  }

  /**
   * Claim a batch of due events. `FOR UPDATE SKIP LOCKED` lets multiple worker
   * replicas drain the same table concurrently without contending or
   * double-publishing.
   */
  async claimBatch(limit: number) {
    return this.db.transaction(async (client) => {
      const res = await client.query<{
        id: string;
        aggregate_type: string;
        aggregate_id: string | null;
        event_type: string;
        payload: Record<string, unknown>;
        trace_id: string | null;
        attempts: number;
      }>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, trace_id, attempts
           FROM outbox
          WHERE published_at IS NULL AND next_attempt_at <= now()
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return res.rows;
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.db.query(`UPDATE outbox SET published_at = now() WHERE id = $1`, [id]);
  }

  /** Reschedule with capped exponential backoff: min(2^attempts, 300) seconds. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE outbox
          SET attempts = attempts + 1,
              last_error = $2,
              next_attempt_at = now() + (least(power(2, attempts + 1), 300) || ' seconds')::interval
        WHERE id = $1`,
      [id, error.slice(0, 500)],
    );
  }

  async pendingCount(): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM outbox WHERE published_at IS NULL`,
    );
    return Number(res.rows[0].count);
  }
}
