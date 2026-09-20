-- =====================================================================
-- Stuck-saga recovery.
--
-- The booking saga compensates correctly when a step throws, because the
-- catch block runs. It cannot compensate when the *process* dies: the pod is
-- OOM-killed between "payment authorized" and "consultation created", and the
-- catch block never runs. The row in `saga_instances` is left in 'running'
-- forever, the patient's money stays authorized, and the slot stays held.
--
-- This migration adds the state needed to find and finish those sagas safely
-- from another replica.
-- =====================================================================

-- Find stale non-terminal sagas cheaply. Partial index: terminal rows are the
-- overwhelming majority and are never scanned by the reconciler.
CREATE INDEX IF NOT EXISTS saga_instances_stuck_idx
  ON saga_instances (updated_at)
  WHERE state IN ('running', 'compensating');

-- Recovery bookkeeping.
--   recovery_attempts  how many times the reconciler has tried
--   recovered_at       when it reached a terminal state by recovery
--   dead_lettered_at   when it was parked for a human
ALTER TABLE saga_instances
  ADD COLUMN IF NOT EXISTS recovery_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovered_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_at  TIMESTAMPTZ;

COMMENT ON COLUMN saga_instances.recovery_attempts IS
  'Times the reconciler has attempted recovery. Past the configured cap the saga is dead-lettered rather than retried forever.';

-- Terminal states after this migration:
--   completed    — all steps succeeded
--   compensated  — rolled back cleanly (by the request, or by the reconciler)
--   dead_letter  — recovery failed repeatedly; needs a human
--
-- Deliberately not a CHECK constraint: a new saga type may need a new state,
-- and a failed deploy that writes an unknown value should degrade to a visible
-- anomaly rather than an insert error on the hot path.

CREATE INDEX IF NOT EXISTS saga_instances_dead_letter_idx
  ON saga_instances (dead_lettered_at)
  WHERE state = 'dead_letter';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON saga_instances TO app_user;
  END IF;
END $$;
