import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService, integrityKeyFrom } from '../../infra/database.service';
import { verifyProof } from '../../common/crypto/integrity-proof';
import { metrics } from '../../observability/metrics';

export type IntegrityFindingKind =
  | 'unattributed_write'
  | 'divergent_row'
  | 'unjournaled_row'
  | 'vanished_row'
  | 'forged_journal_entry'
  | 'checkpoint_mismatch'
  | 'protection_disabled';

export interface IntegrityFinding {
  kind: IntegrityFindingKind;
  severity: 'critical' | 'high';
  table?: string;
  rowId?: string;
  journalId?: string;
  detail: string;
  occurredAt?: Date;
  dbUser?: string;
  clientAddr?: string | null;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  journalEntries: number;
  findings: IntegrityFinding[];
  summary: Record<IntegrityFindingKind, number>;
  /** Highest journal id covered, so a caller can resume an incremental scan. */
  scannedThroughId: string | null;
  durationMs: number;
}

/**
 * Clinical-row tamper detection.
 *
 * Closes the gap the threat model previously called out as accepted: the audit
 * hash chain protects `audit_logs`, but said nothing about `prescriptions`,
 * `consultations` or `payments`. A database-level write could change clinical
 * history and every chain verification would still pass.
 *
 * Six independent checks, each catching a different evasion:
 *
 *   unattributed_write   journal entry whose proof is absent or forged
 *                        -> someone wrote with a database client
 *   divergent_row        live row hashes differently to its newest journal entry
 *                        -> written while the trigger was disabled
 *   unjournaled_row      live row with no journal entry at all
 *                        -> inserted while the trigger was disabled
 *   vanished_row         journaled as live, now missing
 *                        -> deleted while the trigger was disabled
 *   forged_journal_entry entry_hash does not match its own contents
 *                        -> journal edited in place
 *   checkpoint_mismatch  a checkpointed range no longer folds to its hash
 *                        -> journal rows deleted
 *   protection_disabled  a capture trigger is missing or disabled right now
 *
 * The proof check deliberately lives here rather than in SQL: the database
 * must never hold the signing key, or anyone able to write to it could mint
 * proofs at will.
 */
@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);
  private readonly key: Buffer;
  private readonly maxAgeSeconds: number;
  private readonly scanLimit: number;

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService,
  ) {
    this.key = integrityKeyFrom(config);
    this.maxAgeSeconds = config.get<number>('INTEGRITY_PROOF_MAX_AGE_SECONDS', 30 * 24 * 60 * 60);
    this.scanLimit = config.get<number>('INTEGRITY_SCAN_LIMIT', 500);
  }

  /**
   * Full sweep.
   *
   * @param sinceJournalId only re-check proofs after this id (cheap incremental
   *        mode for the scheduled sweep; the row-level checks are set-based and
   *        always run in full).
   */
  async verify(sinceJournalId = 0): Promise<IntegrityReport> {
    const startedAt = Date.now();
    const findings: IntegrityFinding[] = [];

    const [proofFindings, divergent, unjournaled, vanished, forged, checkpoints, triggers, counts] =
      await Promise.all([
        this.checkProofs(sinceJournalId),
        this.db.query<{
          table_name: string;
          row_id: string;
          journal_id: string;
          last_seen_at: Date;
        }>('SELECT table_name, row_id, journal_id, last_seen_at FROM integrity_find_divergent_rows($1)', [
          this.scanLimit,
        ]),
        this.db.query<{ table_name: string; row_id: string }>(
          'SELECT table_name, row_id FROM integrity_find_unjournaled_rows($1)',
          [this.scanLimit],
        ),
        this.db.query<{ table_name: string; row_id: string; journal_id: string }>(
          'SELECT table_name, row_id, journal_id FROM integrity_find_vanished_rows($1)',
          [this.scanLimit],
        ),
        this.db.query<{ journal_id: string }>(
          'SELECT journal_id FROM integrity_find_forged_entries($1, $2)',
          [sinceJournalId, this.scanLimit],
        ),
        this.db.query<{ checkpoint_id: string; reason: string }>(
          'SELECT checkpoint_id, reason FROM integrity_verify_checkpoints()',
        ),
        this.db.query<{ table_name: string; state: string }>(
          'SELECT table_name, state FROM integrity_check_triggers()',
        ),
        this.db.query<{ n: string; max_id: string | null }>(
          'SELECT count(*)::text AS n, max(id)::text AS max_id FROM clinical_integrity_journal',
        ),
      ]);

    findings.push(...proofFindings);

    for (const row of divergent.rows) {
      findings.push({
        kind: 'divergent_row',
        severity: 'critical',
        table: row.table_name,
        rowId: row.row_id,
        journalId: row.journal_id,
        occurredAt: row.last_seen_at,
        detail:
          'Live row content does not match its most recent journal entry — it was modified without the capture trigger running.',
      });
    }

    for (const row of unjournaled.rows) {
      findings.push({
        kind: 'unjournaled_row',
        severity: 'high',
        table: row.table_name,
        rowId: row.row_id,
        detail: 'Row exists with no journal entry — inserted while protection was disabled.',
      });
    }

    for (const row of vanished.rows) {
      findings.push({
        kind: 'vanished_row',
        severity: 'critical',
        table: row.table_name,
        rowId: row.row_id,
        journalId: row.journal_id,
        detail: 'Row was journaled as live but is now absent — deleted while protection was disabled.',
      });
    }

    for (const row of forged.rows) {
      findings.push({
        kind: 'forged_journal_entry',
        severity: 'critical',
        journalId: row.journal_id,
        detail: 'Journal entry hash does not match its contents — the journal itself was edited.',
      });
    }

    for (const row of checkpoints.rows) {
      findings.push({
        kind: 'checkpoint_mismatch',
        severity: 'critical',
        journalId: row.checkpoint_id,
        detail: row.reason,
      });
    }

    for (const row of triggers.rows) {
      if (row.state !== 'enabled') {
        findings.push({
          kind: 'protection_disabled',
          severity: 'critical',
          table: row.table_name,
          detail: `Capture trigger is ${row.state}; clinical writes to this table are not being recorded.`,
        });
      }
    }

    const summary = this.summarise(findings);
    for (const [kind, count] of Object.entries(summary)) {
      metrics.integrityFindings.set({ kind }, count);
    }
    metrics.integrityLastRunTimestamp.set(Date.now() / 1000);

    const report: IntegrityReport = {
      ok: findings.length === 0,
      checkedAt: new Date().toISOString(),
      journalEntries: Number(counts.rows[0]?.n ?? 0),
      findings,
      summary,
      scannedThroughId: counts.rows[0]?.max_id ?? null,
      durationMs: Date.now() - startedAt,
    };

    if (!report.ok) {
      this.logger.error(
        { findings: report.summary, count: findings.length },
        'CLINICAL INTEGRITY VIOLATION DETECTED',
      );
    }
    return report;
  }

  /**
   * Validate the HMAC on every journal entry written since `sinceId`.
   *
   * An absent proof means the write did not come from the application — the
   * signature of a direct database session. An invalid one means somebody
   * tried to fabricate attribution without the key.
   *
   * Ordered NEWEST FIRST, deliberately. An earlier version scanned oldest-first
   * under the same LIMIT, so once the journal grew past `scanLimit` entries the
   * window sat permanently over ancient history and a fresh tamper was never
   * examined — the sweep reported "ok" while an attack sat in the journal
   * unread. Recent entries are both the most likely to be an active intrusion
   * and the most actionable, so they are checked first; anything older is
   * already covered by the checkpoint chain.
   */
  private async checkProofs(sinceId: number): Promise<IntegrityFinding[]> {
    const res = await this.db.query<{
      id: string;
      table_name: string;
      row_id: string;
      op: string;
      proof: string | null;
      db_user: string;
      client_addr: string | null;
      occurred_at: Date;
    }>(
      `SELECT id, table_name, row_id, op, proof, db_user, host(client_addr) AS client_addr, occurred_at
         FROM clinical_integrity_journal
        WHERE id > $1
        ORDER BY id DESC
        LIMIT $2`,
      [sinceId, this.scanLimit],
    );

    const findings: IntegrityFinding[] = [];
    const now = new Date();

    for (const row of res.rows) {
      // Rows written by integrity_baseline() are attested by the migration, not
      // by a running application; they carry the literal marker 'baseline'.
      if (row.proof === 'baseline') continue;

      const result = verifyProof(row.proof, this.key, now, this.maxAgeSeconds);
      if (result.valid) continue;

      findings.push({
        kind: 'unattributed_write',
        severity: 'critical',
        table: row.table_name,
        rowId: row.row_id,
        journalId: row.id,
        occurredAt: row.occurred_at,
        dbUser: row.db_user,
        clientAddr: row.client_addr,
        detail:
          result.reason === 'absent'
            ? `A ${opName(row.op)} on ${row.table_name} carried no proof of application origin — it was made with a direct database session by "${row.db_user}".`
            : `A ${opName(row.op)} on ${row.table_name} carried a proof that failed verification (${result.reason}).`,
      });
    }

    return findings;
  }

  /**
   * Fold the journal into a checkpoint so later deletions become detectable.
   *
   * Runs inside one transaction with the previous checkpoint locked, so two
   * replicas cannot interleave and produce a forked chain.
   */
  async checkpoint(): Promise<{ created: boolean; from?: string; to?: string; entries?: number }> {
    return this.db.transaction(async (client) => {
      // Serialise checkpoint creation across replicas. A transaction-scoped
      // advisory lock is released automatically on commit or rollback.
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        CHECKPOINT_LOCK_ID,
      ]);
      if (!lock.rows[0]?.locked) return { created: false };

      const prev = await client.query<{ to_id: string; chain_hash: Buffer }>(
        'SELECT to_id, chain_hash FROM integrity_checkpoints ORDER BY id DESC LIMIT 1',
      );
      const from = prev.rowCount ? BigInt(prev.rows[0].to_id) + 1n : 1n;
      const prevHash = prev.rowCount ? prev.rows[0].chain_hash : null;

      const head = await client.query<{ max_id: string | null }>(
        'SELECT max(id)::text AS max_id FROM clinical_integrity_journal',
      );
      const to = head.rows[0]?.max_id ? BigInt(head.rows[0].max_id) : 0n;
      if (to < from) return { created: false };

      const range = await client.query<{ range_hash: Buffer; entry_count: string }>(
        'SELECT range_hash, entry_count FROM integrity_range_hash($1, $2)',
        [from.toString(), to.toString()],
      );
      const { range_hash: rangeHash, entry_count: entryCount } = range.rows[0];

      // Every placeholder is cast explicitly and used at exactly one type.
      // Reusing a bare $1 as both a bigint column value and a ::text argument
      // makes Postgres deduce two different types for one parameter and fail
      // with "inconsistent types deduced for parameter $1".
      await client.query(
        `INSERT INTO integrity_checkpoints (from_id, to_id, entry_count, range_hash, prev_hash, chain_hash)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bytea, $5::bytea,
                 digest(concat_ws('|', coalesce(encode($5::bytea, 'hex'), ''),
                                  $1::bigint::text, $2::bigint::text,
                                  encode($4::bytea, 'hex'), $3::bigint::text), 'sha256'))`,
        [from.toString(), to.toString(), entryCount, rangeHash, prevHash],
      );

      return { created: true, from: from.toString(), to: to.toString(), entries: Number(entryCount) };
    });
  }

  /** Journal history for one row — the forensic view for an investigation. */
  async history(table: string, rowId: string, limit = 50) {
    const allowed = await this.db.query<{ table_name: string }>(
      'SELECT table_name FROM integrity_protected_tables WHERE table_name = $1',
      [table],
    );
    if (!allowed.rowCount) return { table, rowId, protected: false, entries: [] };

    const res = await this.db.query<{
      id: string;
      occurred_at: Date;
      op: string;
      row_digest: Buffer;
      proof: string | null;
      db_user: string;
      app_name: string | null;
      client_addr: string | null;
      pg_txid: string;
    }>(
      `SELECT id, occurred_at, op, row_digest, proof, db_user, app_name,
              host(client_addr) AS client_addr, pg_txid
         FROM clinical_integrity_journal
        WHERE table_name = $1 AND row_id = $2
        ORDER BY id DESC
        LIMIT $3`,
      [table, rowId, limit],
    );

    const now = new Date();
    return {
      table,
      rowId,
      protected: true,
      entries: res.rows.map((row) => ({
        journalId: row.id,
        occurredAt: row.occurred_at,
        operation: opName(row.op),
        digest: row.row_digest.toString('hex'),
        attributed:
          row.proof === 'baseline'
            ? 'baseline'
            : verifyProof(row.proof, this.key, now, this.maxAgeSeconds).valid,
        dbUser: row.db_user,
        appName: row.app_name,
        clientAddr: row.client_addr,
        transactionId: row.pg_txid,
      })),
    };
  }

  private summarise(findings: IntegrityFinding[]): Record<IntegrityFindingKind, number> {
    const base: Record<IntegrityFindingKind, number> = {
      unattributed_write: 0,
      divergent_row: 0,
      unjournaled_row: 0,
      vanished_row: 0,
      forged_journal_entry: 0,
      checkpoint_mismatch: 0,
      protection_disabled: 0,
    };
    for (const f of findings) base[f.kind] += 1;
    return base;
  }
}

/** Arbitrary but fixed: identifies the checkpoint advisory lock. */
const CHECKPOINT_LOCK_ID = 8_472_001;

function opName(op: string): string {
  return op === 'I' ? 'INSERT' : op === 'U' ? 'UPDATE' : 'DELETE';
}
