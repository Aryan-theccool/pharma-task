-- =====================================================================
-- Clinical-row integrity: detect mutations that did not come from the
-- application, including writes made directly with a database client.
--
-- WHY THIS EXISTS
-- ---------------
-- The audit hash chain in 0001 protects `audit_logs`. It says nothing about
-- `prescriptions`, `consultations` or `payments`: an attacker holding a
-- database credential could `UPDATE prescriptions SET diagnosis_enc = NULL`
-- and the chain would still verify, because no audit row was touched. That
-- was a documented, test-proven gap. This migration closes it.
--
-- HOW IT WORKS
-- ------------
-- 1. Every INSERT/UPDATE/DELETE on a clinical table fires a SECURITY DEFINER
--    trigger that appends a row to `clinical_integrity_journal` recording a
--    SHA-256 digest of the whole row, plus *who* wrote it.
--
-- 2. "Who" is a proof of application origin. The API passes a per-process
--    token in the libpq startup packet (`options=-c amrutam.proof=...`),
--    which is `"<issuedAtEpoch>.<nonce>.<HMAC-SHA256(INTEGRITY_KEY, payload)>"`.
--    The database never holds INTEGRITY_KEY, so it cannot mint a proof, and
--    neither can anyone connecting with psql. The trigger just copies the GUC
--    verbatim; the verifier recomputes the HMAC out-of-band.
--
-- 3. The journal is append-only *by grant*: app_user has SELECT and nothing
--    else. Only the SECURITY DEFINER trigger (running as the table owner)
--    inserts. A compromised application credential therefore cannot forge,
--    edit or remove an entry.
--
-- 4. Deleting journal rows outright is caught by `integrity_checkpoints`: a
--    periodic job hashes each contiguous id range and chains the checkpoints
--    together. Removing or altering a journaled row changes its range hash.
--
-- WHAT EACH ATTACK LOOKS LIKE
--   direct UPDATE via psql        -> journal entry with an absent/invalid proof
--   trigger disabled, then UPDATE -> live row digest != newest journal digest
--   journal rows deleted          -> checkpoint range hash mismatch
--   replayed proof from a row     -> same nonce observed under two txids
--
-- Residual risk: an attacker who exfiltrates INTEGRITY_KEY *and* has database
-- write access can mint valid proofs. The key lives in KMS and is never
-- stored in the database, so this requires compromising two systems.
-- See docs/SECURITY.md and docs/adr/0010-clinical-integrity.md.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_integrity_journal (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name    TEXT   NOT NULL,
  row_id        TEXT   NOT NULL,
  op            CHAR(1) NOT NULL CHECK (op IN ('I', 'U', 'D')),
  -- SHA-256 over the canonical jsonb rendering of the row after the change
  -- (before the change, for a delete).
  row_digest    BYTEA  NOT NULL,
  -- Application-origin proof, copied verbatim from the connection GUC.
  proof         TEXT,
  -- Forensics: who the database itself thinks made the change.
  db_user       TEXT   NOT NULL DEFAULT current_user,
  app_name      TEXT,
  client_addr   INET,
  pg_txid       BIGINT NOT NULL,
  -- Self-digest, so checkpoints can detect edits to journal rows themselves.
  entry_hash    BYTEA  NOT NULL
);

CREATE INDEX IF NOT EXISTS cij_row_idx      ON clinical_integrity_journal (table_name, row_id, id DESC);
CREATE INDEX IF NOT EXISTS cij_occurred_idx ON clinical_integrity_journal (occurred_at);
CREATE INDEX IF NOT EXISTS cij_txid_idx     ON clinical_integrity_journal (pg_txid);

COMMENT ON TABLE clinical_integrity_journal IS
  'Append-only record of every clinical-row mutation with a proof of application origin. Written only by the SECURITY DEFINER trigger clinical_integrity_capture().';

-- ---------------------------------------------------------------------
-- Checkpoints — chained summaries that make journal deletion detectable
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrity_checkpoints (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_id     BIGINT NOT NULL,
  to_id       BIGINT NOT NULL,
  entry_count BIGINT NOT NULL,
  range_hash  BYTEA  NOT NULL,
  prev_hash   BYTEA,
  chain_hash  BYTEA  NOT NULL
);

COMMENT ON TABLE integrity_checkpoints IS
  'Rolling hash of contiguous journal id ranges, chained head-to-tail. Makes deletion of journaled rows detectable without serialising every clinical write behind a single chain head.';

-- ---------------------------------------------------------------------
-- Canonical row digest
--
-- `to_jsonb(row)` renders timestamptz using the session TimeZone, so the
-- digest would differ between a writer in Asia/Kolkata and a verifier in UTC.
-- Both the trigger and the verifier below pin `timezone = UTC` via the
-- function's SET clause, which makes the rendering reproducible.
-- jsonb::text is itself canonical — Postgres normalises key order on storage.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinical_digest_of(doc jsonb)
RETURNS BYTEA
LANGUAGE sql
IMMUTABLE
AS $$ SELECT digest(doc::text, 'sha256') $$;

-- Recompute the digest of a row as it exists *right now*. Used by the
-- verifier to spot rows changed while the trigger was disabled or dropped.
CREATE OR REPLACE FUNCTION clinical_live_digest(tbl TEXT, rid TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SET timezone TO 'UTC'
AS $$
DECLARE
  result BYTEA;
BEGIN
  EXECUTE format(
    'SELECT clinical_digest_of(to_jsonb(t)) FROM %I t WHERE t.id::text = $1',
    tbl
  ) INTO result USING rid;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------
-- Capture trigger
--
-- SECURITY DEFINER: runs as the table owner, so app_user needs no write
-- privilege on the journal. Combined with the grants at the bottom of this
-- file, a compromised application credential can read the journal but can
-- neither add a false entry nor remove a true one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinical_integrity_capture()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET timezone TO 'UTC'
AS $$
DECLARE
  v_doc     JSONB;
  v_id      TEXT;
  v_op      CHAR(1);
  v_digest  BYTEA;
  v_proof   TEXT;
  v_txid    BIGINT;
  v_when    TIMESTAMPTZ := clock_timestamp();
  v_app     TEXT := current_setting('application_name', true);
  v_addr    INET := inet_client_addr();
  -- `consultations` is partitioned, so TG_TABLE_NAME inside a cloned trigger
  -- is the *partition* ('consultations_p202608'). Journal the logical table
  -- instead, or the verifier's joins against integrity_protected_tables would
  -- never match and every partitioned write would look unjournaled.
  v_table   TEXT := coalesce(pg_partition_root(TG_RELID)::regclass::text, TG_TABLE_NAME);
BEGIN
  -- regclass renders as 'public.x' only when the schema is not on search_path;
  -- normalise so the stored value is always the bare table name.
  v_table := split_part(v_table, '.', greatest(1, array_length(string_to_array(v_table, '.'), 1)));
  IF TG_OP = 'DELETE' THEN
    v_doc := to_jsonb(OLD);
    v_op  := 'D';
  ELSIF TG_OP = 'UPDATE' THEN
    v_doc := to_jsonb(NEW);
    v_op  := 'U';
  ELSE
    v_doc := to_jsonb(NEW);
    v_op  := 'I';
  END IF;

  v_id     := v_doc ->> 'id';
  v_digest := clinical_digest_of(v_doc);
  -- Absent for any client that did not present one (psql, a BI tool, an
  -- attacker). NULL is itself the signal.
  v_proof  := current_setting('amrutam.proof', true);
  v_txid   := txid_current();

  INSERT INTO clinical_integrity_journal
    (occurred_at, table_name, row_id, op, row_digest, proof, db_user, app_name,
     client_addr, pg_txid, entry_hash)
  VALUES
    (v_when, v_table, v_id, v_op, v_digest, v_proof, current_user, v_app,
     v_addr, v_txid,
     digest(
       concat_ws('|',
         to_char(v_when AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
         v_table, v_id, v_op, encode(v_digest, 'hex'),
         coalesce(v_proof, ''), current_user, v_txid::text),
       'sha256'));

  RETURN NULL; -- AFTER trigger; return value is ignored
END;
$$;

-- ---------------------------------------------------------------------
-- Attach to the clinical tables.
--
-- `consultations` is partitioned. A row trigger created on the partitioned
-- parent is cloned to every existing partition and to any partition created
-- later, so `ensure_monthly_partition()` needs no change.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS clinical_integrity_consultations ON consultations;
CREATE TRIGGER clinical_integrity_consultations
  AFTER INSERT OR UPDATE OR DELETE ON consultations
  FOR EACH ROW EXECUTE FUNCTION clinical_integrity_capture();

DROP TRIGGER IF EXISTS clinical_integrity_prescriptions ON prescriptions;
CREATE TRIGGER clinical_integrity_prescriptions
  AFTER INSERT OR UPDATE OR DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION clinical_integrity_capture();

DROP TRIGGER IF EXISTS clinical_integrity_payments ON payments;
CREATE TRIGGER clinical_integrity_payments
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION clinical_integrity_capture();

-- ---------------------------------------------------------------------
-- Which tables are expected to be protected. The verifier reads this and
-- reports a violation if a trigger has been dropped or disabled, so removing
-- the trigger is itself a detectable act.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrity_protected_tables (
  table_name TEXT PRIMARY KEY,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO integrity_protected_tables (table_name)
VALUES ('consultations'), ('prescriptions'), ('payments')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------
-- Grants: read-only for the application role.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON clinical_integrity_journal FROM app_user;
    REVOKE ALL ON integrity_checkpoints      FROM app_user;
    REVOKE ALL ON integrity_protected_tables FROM app_user;

    GRANT SELECT ON clinical_integrity_journal TO app_user;
    GRANT SELECT ON integrity_protected_tables TO app_user;
    -- Checkpoints are written by the API's sweeper, which runs as app_user.
    -- INSERT only: an existing checkpoint can never be rewritten.
    GRANT SELECT, INSERT ON integrity_checkpoints TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE integrity_checkpoints_id_seq TO app_user;
  END IF;
END $$;
