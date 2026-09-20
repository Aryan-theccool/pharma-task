-- =====================================================================
-- Server-side verification for the clinical integrity journal.
--
-- Kept in SQL rather than TypeScript because the checks are set-oriented:
-- comparing every live clinical row against its newest journal entry is one
-- join, not N round-trips. The API layer (IntegrityService) adds the HMAC
-- proof check, which must happen outside the database because the database
-- must never hold the signing key.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Rows whose current content does not match the newest journal digest.
--    Catches: trigger disabled/dropped, then the row edited.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_find_divergent_rows(p_limit INT DEFAULT 100)
RETURNS TABLE (
  table_name     TEXT,
  row_id         TEXT,
  journal_id     BIGINT,
  journal_digest BYTEA,
  live_digest    BYTEA,
  last_seen_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SET timezone TO 'UTC'
AS $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT ipt.table_name FROM integrity_protected_tables ipt ORDER BY 1 LOOP
    RETURN QUERY EXECUTE format($q$
      WITH newest AS (
        SELECT DISTINCT ON (j.row_id)
               j.row_id, j.id, j.row_digest, j.op, j.occurred_at
          FROM clinical_integrity_journal j
         WHERE j.table_name = %L
         ORDER BY j.row_id, j.id DESC
      )
      SELECT %L::text,
             n.row_id,
             n.id,
             n.row_digest,
             clinical_digest_of(to_jsonb(t.*)),
             n.occurred_at
        FROM newest n
        JOIN %I t ON t.id::text = n.row_id
       WHERE n.op <> 'D'
         AND clinical_digest_of(to_jsonb(t.*)) IS DISTINCT FROM n.row_digest
       LIMIT %s
    $q$, t, t, t, p_limit);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. Live rows with no journal entry at all.
--    Catches: INSERT performed while the trigger was disabled.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_find_unjournaled_rows(p_limit INT DEFAULT 100)
RETURNS TABLE (table_name TEXT, row_id TEXT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT ipt.table_name FROM integrity_protected_tables ipt ORDER BY 1 LOOP
    RETURN QUERY EXECUTE format($q$
      SELECT %L::text, t.id::text
        FROM %I t
       WHERE NOT EXISTS (
         SELECT 1 FROM clinical_integrity_journal j
          WHERE j.table_name = %L AND j.row_id = t.id::text)
       LIMIT %s
    $q$, t, t, t, p_limit);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Rows journaled as present but now absent from the table.
--    Catches: DELETE performed while the trigger was disabled.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_find_vanished_rows(p_limit INT DEFAULT 100)
RETURNS TABLE (table_name TEXT, row_id TEXT, journal_id BIGINT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT ipt.table_name FROM integrity_protected_tables ipt ORDER BY 1 LOOP
    RETURN QUERY EXECUTE format($q$
      WITH newest AS (
        SELECT DISTINCT ON (j.row_id) j.row_id, j.id, j.op
          FROM clinical_integrity_journal j
         WHERE j.table_name = %L
         ORDER BY j.row_id, j.id DESC
      )
      SELECT %L::text, n.row_id, n.id
        FROM newest n
       WHERE n.op <> 'D'
         AND NOT EXISTS (SELECT 1 FROM %I t WHERE t.id::text = n.row_id)
       LIMIT %s
    $q$, t, t, t, p_limit);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Protection that is supposed to be enabled but is not.
--    Catches: ALTER TABLE ... DISABLE TRIGGER / DROP TRIGGER.
--    `tgenabled = 'D'` is a disabled trigger; a missing row is a dropped one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_check_triggers()
RETURNS TABLE (table_name TEXT, state TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT ipt.table_name,
         CASE
           WHEN tg.tgname IS NULL      THEN 'missing'
           WHEN tg.tgenabled = 'D'     THEN 'disabled'
           ELSE 'enabled'
         END
    FROM integrity_protected_tables ipt
    LEFT JOIN pg_class c  ON c.relname = ipt.table_name
                         AND c.relnamespace = 'public'::regnamespace
    LEFT JOIN pg_trigger tg ON tg.tgrelid = c.oid
                         AND tg.tgname = 'clinical_integrity_' || ipt.table_name
                         AND NOT tg.tgisinternal
   ORDER BY 1;
$$;

-- ---------------------------------------------------------------------
-- 5. Journal self-consistency: recompute each entry_hash.
--    Catches: an in-place edit of a journal row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_find_forged_entries(
  p_from BIGINT DEFAULT 0,
  p_limit INT DEFAULT 5000
)
RETURNS TABLE (journal_id BIGINT, stored BYTEA, computed BYTEA)
LANGUAGE sql
STABLE
SET timezone TO 'UTC'
AS $$
  SELECT j.id, j.entry_hash, expected.h
    FROM clinical_integrity_journal j
    CROSS JOIN LATERAL (
      SELECT digest(
        concat_ws('|',
          to_char(j.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
          j.table_name, j.row_id, j.op, encode(j.row_digest, 'hex'),
          coalesce(j.proof, ''), j.db_user, j.pg_txid::text),
        'sha256') AS h
    ) expected
   WHERE j.id > p_from
     AND j.entry_hash IS DISTINCT FROM expected.h
   -- Newest first: with a bounded LIMIT, an ascending scan would pin the window
   -- to ancient history once the journal grew, and a recent forgery would never
   -- be reached. Older entries remain covered by the checkpoint chain.
   ORDER BY j.id DESC
   LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------
-- 6. Range hash for checkpointing.
--    Ordered fold over entry_hash; any deletion, insertion or edit inside the
--    range changes the result.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_range_hash(p_from BIGINT, p_to BIGINT)
RETURNS TABLE (range_hash BYTEA, entry_count BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT digest(coalesce(string_agg(encode(j.entry_hash, 'hex'), ':' ORDER BY j.id), ''), 'sha256'),
         count(*)
    FROM clinical_integrity_journal j
   WHERE j.id BETWEEN p_from AND p_to;
$$;

-- ---------------------------------------------------------------------
-- 7. Checkpoint chain verification: re-fold every range and re-link.
--    Catches: deletion of journal rows, or a rewritten checkpoint.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_verify_checkpoints()
RETURNS TABLE (checkpoint_id BIGINT, reason TEXT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  cp            RECORD;
  v_expected    BYTEA;
  v_count       BIGINT;
  v_prev        BYTEA := NULL;
  v_chain       BYTEA;
BEGIN
  FOR cp IN SELECT * FROM integrity_checkpoints ORDER BY id LOOP
    SELECT r.range_hash, r.entry_count
      INTO v_expected, v_count
      FROM integrity_range_hash(cp.from_id, cp.to_id) r;

    IF v_expected IS DISTINCT FROM cp.range_hash THEN
      checkpoint_id := cp.id;
      reason := 'range hash mismatch (journal rows added, removed or altered)';
      RETURN NEXT;
    ELSIF v_count IS DISTINCT FROM cp.entry_count THEN
      checkpoint_id := cp.id;
      reason := format('entry count mismatch: expected %s, found %s', cp.entry_count, v_count);
      RETURN NEXT;
    END IF;

    IF cp.prev_hash IS DISTINCT FROM v_prev THEN
      checkpoint_id := cp.id;
      reason := 'checkpoint chain broken (prev_hash does not match predecessor)';
      RETURN NEXT;
    END IF;

    v_chain := digest(
      concat_ws('|', coalesce(encode(v_prev, 'hex'), ''),
                cp.from_id::text, cp.to_id::text,
                encode(cp.range_hash, 'hex'), cp.entry_count::text),
      'sha256');

    IF v_chain IS DISTINCT FROM cp.chain_hash THEN
      checkpoint_id := cp.id;
      reason := 'chain hash mismatch';
      RETURN NEXT;
    END IF;

    v_prev := cp.chain_hash;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 8. Baseline.
--
-- Rows that already existed when protection was switched on have no journal
-- entry, and would otherwise be reported as "unjournaled" forever — a standing
-- false positive that trains operators to ignore the alert. Baselining writes
-- one 'I' entry per existing row, recording the state at the moment protection
-- began.
--
-- Honest limitation, stated because it matters: a baseline entry attests only
-- that the row looked like this when protection started. It cannot vouch for
-- anything that happened before. Only mutations from this point on carry a
-- proof of application origin.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integrity_baseline()
RETURNS TABLE (table_name TEXT, rows_baselined BIGINT)
LANGUAGE plpgsql
SET timezone TO 'UTC'
AS $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOR t IN SELECT ipt.table_name FROM integrity_protected_tables ipt ORDER BY 1 LOOP
    EXECUTE format($q$
      INSERT INTO clinical_integrity_journal
        (occurred_at, table_name, row_id, op, row_digest, proof, db_user,
         app_name, client_addr, pg_txid, entry_hash)
      SELECT now(), %L, t.id::text, 'I', clinical_digest_of(to_jsonb(t.*)),
             'baseline', current_user, 'migration', NULL, txid_current(),
             digest(concat_ws('|',
               to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
               %L, t.id::text, 'I', encode(clinical_digest_of(to_jsonb(t.*)), 'hex'),
               'baseline', current_user, txid_current()::text), 'sha256')
        FROM %I t
       WHERE NOT EXISTS (
         SELECT 1 FROM clinical_integrity_journal j
          WHERE j.table_name = %L AND j.row_id = t.id::text)
    $q$, t, t, t, t);
    GET DIAGNOSTICS n = ROW_COUNT;
    table_name := t; rows_baselined := n; RETURN NEXT;
  END LOOP;
END;
$$;

-- Baseline whatever already exists, so the system starts clean.
-- `occurred_at` is now() rather than clock_timestamp() so every baseline row
-- in this statement shares one timestamp and the entry_hash stays reproducible.
SELECT * FROM integrity_baseline();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION integrity_find_divergent_rows(INT)    TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_find_unjournaled_rows(INT)  TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_find_vanished_rows(INT)     TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_check_triggers()            TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_find_forged_entries(BIGINT, INT) TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_range_hash(BIGINT, BIGINT)  TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_verify_checkpoints()        TO app_user;
    GRANT EXECUTE ON FUNCTION integrity_baseline()                  TO app_user;
    GRANT EXECUTE ON FUNCTION clinical_live_digest(TEXT, TEXT)      TO app_user;
  END IF;
END $$;
