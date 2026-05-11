-- ============================================================
-- Migration 008 — Idempotency + executor state machine + verification
-- 1. tasks.idempotency_key — derived from (volume_id, action, target).
--    UNIQUE so that the same (vol, action) cannot be queued twice in any
--    state ∈ {pending, approved, running}.
-- 2. executions.phase — pending → locking → uploading → verifying → succeeded
--    A crash between phases is recoverable: on restart the executor inspects
--    the last phase and either retries the next step or marks failed if
--    the volume's actual state already advanced.
-- 3. executions.verification — JSON capturing the post-migration smoke test
--    result (sampled object count, checksum match, remote backend confirmed).
-- ============================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
-- Partial unique index: only enforce uniqueness for "active" task states so
-- a finished task doesn't block a future re-migration.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_task_per_volume_action
  ON tasks (idempotency_key)
  WHERE status IN ('pending','approved','running');

ALTER TABLE executions ADD COLUMN IF NOT EXISTS phase TEXT
  NOT NULL DEFAULT 'pending'
  CHECK (phase IN ('pending','locking','uploading','verifying','succeeded','failed','rolling_back'));
ALTER TABLE executions ADD COLUMN IF NOT EXISTS verification JSONB
  NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS attempts INTEGER
  NOT NULL DEFAULT 0;
