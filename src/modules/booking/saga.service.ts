import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../infra/database.service';
import { metrics } from '../../observability/metrics';

/**
 * Persistent saga log.
 *
 * Every step and its compensating action are written to `saga_instances`
 * before the next step runs, so an orchestrator crash leaves a durable record
 * of exactly how far the transaction got and what must be undone. This is why
 * the system uses a saga rather than 2PC: no distributed lock is held across
 * an external payment call, and each participant stays independently
 * available (see docs/adr/0004-saga-vs-2pc.md).
 */
@Injectable()
export class SagaService {
  constructor(private readonly db: DatabaseService) {}

  async start(type: string, payload: Record<string, unknown>): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO saga_instances (type, state, step, payload)
       VALUES ($1, 'running', 'started', $2::jsonb)
       RETURNING id`,
      [type, JSON.stringify(payload)],
    );
    return res.rows[0].id;
  }

  async completeStep(
    sagaId: string,
    step: string,
    meta?: { compensation?: string } & Record<string, unknown>,
  ): Promise<void> {
    const compensation = meta?.compensation;
    metrics.sagaSteps.inc({ saga: 'booking.confirm', step, result: 'success' });
    await this.db.query(
      `UPDATE saga_instances
          SET step = $2,
              completed_steps = completed_steps || $3::jsonb,
              compensations = CASE WHEN $4::text IS NULL THEN compensations
                                   ELSE compensations || to_jsonb($4::text) END,
              payload = payload || $5::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [sagaId, step, JSON.stringify([step]), compensation ?? null, JSON.stringify(stripMeta(meta))],
    );
  }

  async compensationsFor(sagaId: string): Promise<string[]> {
    const res = await this.db.query<{ compensations: string[] }>(
      `SELECT compensations FROM saga_instances WHERE id = $1`,
      [sagaId],
    );
    return res.rows[0]?.compensations ?? [];
  }

  async recordCompensation(sagaId: string, step: string): Promise<void> {
    await this.db.query(
      `UPDATE saga_instances
          SET payload = payload || jsonb_build_object('compensated_' || $2::text, true),
              updated_at = now()
        WHERE id = $1`,
      [sagaId, step],
    );
  }

  async complete(sagaId: string): Promise<void> {
    await this.db.query(
      `UPDATE saga_instances SET state='completed', step='done', updated_at = now() WHERE id = $1`,
      [sagaId],
    );
  }

  async fail(sagaId: string, error: string): Promise<void> {
    metrics.sagaSteps.inc({ saga: 'booking.confirm', step: 'failed', result: 'failure' });
    await this.db.query(
      `UPDATE saga_instances
          SET state='compensating', last_error = $2, attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [sagaId, error.slice(0, 500)],
    );
  }

  async get(sagaId: string) {
    const res = await this.db.query(`SELECT * FROM saga_instances WHERE id = $1`, [sagaId]);
    return res.rows[0] ?? null;
  }

  /** Sagas stuck mid-flight — surfaced to operators via the runbook. */
  async findStuck(olderThanMinutes = 15) {
    const res = await this.db.query(
      `SELECT id, type, state, step, last_error, created_at
         FROM saga_instances
        WHERE state IN ('running','compensating')
          AND updated_at < now() - ($1 || ' minutes')::interval
        ORDER BY created_at
        LIMIT 100`,
      [String(olderThanMinutes)],
    );
    return res.rows;
  }
}

function stripMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  const { compensation: _compensation, ...rest } = meta;
  return rest;
}
