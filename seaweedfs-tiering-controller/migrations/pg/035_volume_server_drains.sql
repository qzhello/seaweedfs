-- Persistent drain jobs for volumeServer.leave.
--
-- The synchronous /clusters/:id/volume-server/leave/stream endpoint
-- still works, but real ops want a record: who drained which node,
-- how many volumes were on it, and whether the node ended up empty.
-- This table is the durable backing store for that workflow.
--
-- Lifecycle:
--   pending   — row created, worker hasn't picked it up yet
--   running   — `weed shell volumeServer.leave` is in flight
--   verifying — shell exited cleanly; polling master topology until
--               the node reports 0 volumes (or until the deadline)
--   done      — node confirmed empty
--   failed    — shell errored OR verification timed out
--   cancelled — operator cancelled before completion

CREATE TABLE IF NOT EXISTS volume_server_drains (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    node            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    force           BOOLEAN NOT NULL DEFAULT false,
    reason          TEXT NOT NULL DEFAULT '',
    requested_by    TEXT NOT NULL DEFAULT '',
    initial_volumes INTEGER NOT NULL DEFAULT 0,
    initial_bytes   BIGINT  NOT NULL DEFAULT 0,
    last_volumes    INTEGER NOT NULL DEFAULT 0,
    last_bytes      BIGINT  NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    run_log         TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);

-- For the dashboard listing: surfacing active drains has to be fast.
CREATE INDEX IF NOT EXISTS volume_server_drains_active_idx
    ON volume_server_drains(cluster_id, status)
    WHERE status IN ('pending', 'running', 'verifying');

CREATE INDEX IF NOT EXISTS volume_server_drains_created_at_idx
    ON volume_server_drains(created_at DESC);

-- Any in-flight row from a previous process is dead now (the runner
-- lives in memory). Mark them failed so the operator can retry without
-- guessing at status. This statement is also re-run on every startup
-- by the orchestrator's housekeeping pass — putting it in the
-- migration is defence-in-depth for the first deployment.
UPDATE volume_server_drains
   SET status = 'failed',
       error  = COALESCE(NULLIF(error,''), 'orchestrator restarted before completion'),
       finished_at = COALESCE(finished_at, now())
 WHERE status IN ('pending', 'running', 'verifying');
