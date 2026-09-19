-- =====================================================================
-- Partition management for consultations + audit_logs
-- Monthly RANGE partitions, created ahead of time by a scheduled job.
-- =====================================================================

-- Creates a monthly partition for `parent` covering the month containing `anchor`.
CREATE OR REPLACE FUNCTION ensure_monthly_partition(parent regclass, anchor timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  start_ts  timestamptz := date_trunc('month', anchor);
  end_ts    timestamptz := start_ts + interval '1 month';
  part_name text := format('%s_p%s', parent::text, to_char(start_ts, 'YYYYMM'));
BEGIN
  IF to_regclass(part_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent::text, start_ts, end_ts
    );
  END IF;
  RETURN part_name;
END;
$$;

-- Default catch-all partitions so an unexpected date never errors a write.
DO $$
BEGIN
  IF to_regclass('consultations_default') IS NULL THEN
    CREATE TABLE consultations_default PARTITION OF consultations DEFAULT;
  END IF;
  IF to_regclass('audit_logs_default') IS NULL THEN
    CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
  END IF;
END $$;

-- Pre-create: previous month .. +3 months ahead.
DO $$
DECLARE
  i int;
BEGIN
  FOR i IN -1..3 LOOP
    PERFORM ensure_monthly_partition('consultations'::regclass, now() + make_interval(months => i));
    PERFORM ensure_monthly_partition('audit_logs'::regclass,    now() + make_interval(months => i));
  END LOOP;
END $$;
