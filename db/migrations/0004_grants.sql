-- =====================================================================
-- Least-privilege runtime role.
--
-- The application connects as `app_user`, which can INSERT into audit_logs
-- but can never UPDATE or DELETE it. Even a fully compromised application
-- credential (SQL injection, RCE) cannot rewrite history — the tamper-evident
-- hash chain is then a detection layer on top of this prevention layer.
--
-- Local/dev connects as the owner for convenience; production always uses
-- app_user (see infra/terraform + docs/RUNBOOK.md).
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE format('CREATE ROLE app_user LOGIN PASSWORD %L', coalesce(current_setting('amrutam.app_password', true), 'app_user_dev'));
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Append-only enforcement for the audit trail (and its partitions).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;
DO $$
DECLARE part record;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'audit_logs'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM app_user', part.relname);
  END LOOP;
END $$;

-- Immutable financial history: payments may be inserted and updated, never
-- deleted, so reconciliation always has a complete record.
REVOKE DELETE ON payments FROM app_user;
REVOKE DELETE ON payment_webhook_events FROM app_user;
