-- ============================================================
-- Migration 005 — Monitoring targets & health state
-- The controller scrapes targets on a fixed cadence. A target may be:
--   http              - simple GET, 2xx within timeout
--   prometheus_query  - POST PromQL to /api/v1/query, expect non-empty
--                       result and (optional) numeric threshold
-- Per-target consecutive_failures drives flap-protected degraded state.
-- The scheduler reads overall health via the gate; degraded → no new tasks.
-- ============================================================

CREATE TABLE IF NOT EXISTS monitor_targets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL CHECK (kind IN ('http','prometheus_query')),
    url             TEXT NOT NULL,                    -- http: full URL; prometheus_query: prometheus base URL
    query           TEXT NOT NULL DEFAULT '',         -- prometheus_query only
    threshold_op    TEXT NOT NULL DEFAULT '',         -- '>', '<', '>=', '<=', '==', '!=' or empty
    threshold_value DOUBLE PRECISION,
    severity        TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
    interval_sec    INTEGER NOT NULL DEFAULT 30,
    timeout_sec     INTEGER NOT NULL DEFAULT 5,
    fail_threshold  INTEGER NOT NULL DEFAULT 3,       -- consecutive failures to flip degraded
    recover_threshold INTEGER NOT NULL DEFAULT 3,     -- consecutive successes to flip healthy
    cluster_id      UUID REFERENCES clusters(id) ON DELETE SET NULL,
    -- Whether failure of this target gates the scheduler. Some targets are
    -- informational (e.g. CH query latency); others are critical (master up).
    gates_scheduler BOOLEAN NOT NULL DEFAULT TRUE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_state (
    target_id            UUID PRIMARY KEY REFERENCES monitor_targets(id) ON DELETE CASCADE,
    state                TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('healthy','degraded','unknown')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    last_ok_at           TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    last_error           TEXT NOT NULL DEFAULT '',
    last_latency_ms      INTEGER NOT NULL DEFAULT 0,
    last_value           DOUBLE PRECISION,            -- for prometheus_query
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lightweight rolling window of samples for the UI sparkline. Truncated by TTL.
CREATE TABLE IF NOT EXISTS health_samples (
    target_id    UUID NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
    sample_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ok           BOOLEAN NOT NULL,
    latency_ms   INTEGER NOT NULL,
    value        DOUBLE PRECISION,
    PRIMARY KEY (target_id, sample_at)
);
CREATE INDEX IF NOT EXISTS idx_health_samples_recent ON health_samples(sample_at DESC);

-- Seed a couple of useful targets if none exist (admin can edit / disable).
INSERT INTO monitor_targets (name, kind, url, severity, interval_sec, gates_scheduler, notes) VALUES
  ('controller_self', 'http', 'http://127.0.0.1:8080/healthz', 'critical', 30, FALSE,
    '控制器自检 (绑定 health gate 会形成循环,故 gates_scheduler=FALSE)'),
  ('seaweedfs_master_default', 'http', 'http://127.0.0.1:9333/cluster/healthz', 'critical', 30, TRUE,
    'SeaweedFS master 健康端点,失败 3 次 → 暂停所有迁移')
ON CONFLICT (name) DO NOTHING;
