-- Task failure classification + retry scheduling.
--
-- Adds columns so the executor can:
--   1. Tag the *kind* of failure (transient / capacity / validation /
--      unknown) without parsing free-form error text in three places.
--   2. Defer re-dispatch of transient failures via exponential backoff
--      instead of failing terminally on the first hiccup.
--   3. Surface the last raw error to the operator without a join into
--      `executions`.
--
-- Nothing here changes existing behaviour for tasks already in flight
-- — new columns default to 0/NULL.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS failure_reason   TEXT,
    ADD COLUMN IF NOT EXISTS failure_message  TEXT,
    ADD COLUMN IF NOT EXISTS retry_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ;

-- The dispatcher's "what should I run next?" question becomes
-- "approved AND (next_retry_at IS NULL OR <= NOW())". A partial index
-- keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_ready_to_run
    ON tasks(next_retry_at)
    WHERE status = 'approved' AND next_retry_at IS NOT NULL;

-- Same for the audit/inspector view of recent failures.
CREATE INDEX IF NOT EXISTS idx_tasks_failure_reason
    ON tasks(failure_reason)
    WHERE failure_reason IS NOT NULL;

COMMENT ON COLUMN tasks.failure_reason IS
    'classified failure category: transient | capacity | validation | unknown';
COMMENT ON COLUMN tasks.next_retry_at IS
    'next eligible run time when scheduling a backoff retry; NULL means run immediately';
