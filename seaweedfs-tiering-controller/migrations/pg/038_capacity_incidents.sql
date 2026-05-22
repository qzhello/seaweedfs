-- Capacity incidents — the closed loop for "tiering hit a capacity wall".
--
-- When an execution fails with a capacity-class error (classified by
-- internal/executor/failure.go), the executor opens an incident for the
-- task's cluster. While an incident is open the scheduler skips that
-- cluster entirely ("capacity hold"), so we stop generating tasks that
-- would just slam into the same wall. The incident also carries the AI
-- analyst's brief (root cause + recommended actions). Resolving the
-- incident lifts the hold and resumes tiering for that cluster.

CREATE TABLE IF NOT EXISTS capacity_incidents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    trigger_task_id UUID,                          -- task whose failure opened this (no FK: survives task cleanup)
    failure_message TEXT NOT NULL DEFAULT '',
    ai_report       JSONB,                         -- AI analyst brief; NULL until analysed
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT
);

-- At most one OPEN incident per cluster — repeated capacity failures
-- while already held collapse into the existing incident (ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS capacity_incidents_one_open
    ON capacity_incidents (cluster_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_capacity_incidents_status
    ON capacity_incidents (status, triggered_at DESC);
