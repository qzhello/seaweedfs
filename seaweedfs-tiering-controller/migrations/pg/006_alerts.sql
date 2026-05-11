-- ============================================================
-- Migration 006 — Alert engine (WeCom robot first; pluggable kind)
-- An alert is emitted when:
--   * a monitor target transitions to 'degraded' (auto)
--   * an executor task fails (auto)
--   * a workflow step matches an on_anomaly hook (Sprint 4)
--   * an admin manually fires one (test button)
-- The dispatcher applies dedupe + silence windows before sending.
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('wecom_robot','dingtalk_robot','feishu_robot','webhook')),
    -- channel-specific config; for wecom_robot this is just {webhook: "...", mention_mobiles: [...]}
    config       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- which severities this channel accepts
    severities   TEXT[] NOT NULL DEFAULT ARRAY['warning','critical']::TEXT[],
    -- per-channel rate limit: max messages per hour (0 = unlimited)
    rate_per_hour INTEGER NOT NULL DEFAULT 60,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Routing rules: which alerts go to which channel(s).
-- match_kind / match_value supports simple string equality first; regex later.
CREATE TABLE IF NOT EXISTS alert_rules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL UNIQUE,
    -- Routing key from emitted event: 'health.degraded' / 'task.failed' / 'workflow.anomaly'
    event_kind   TEXT NOT NULL,
    -- optional source filter, e.g. monitor_target name or cluster_id
    source_match TEXT NOT NULL DEFAULT '*',
    severity_min TEXT NOT NULL DEFAULT 'warning' CHECK (severity_min IN ('info','warning','critical')),
    channel_ids  UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    -- silence window: don't repeat the same (event_kind+source) within N seconds
    silence_sec  INTEGER NOT NULL DEFAULT 600,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only event log; UI shows recent alerts and which channels delivered.
CREATE TABLE IF NOT EXISTS alert_events (
    id           BIGSERIAL PRIMARY KEY,
    fired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_kind   TEXT NOT NULL,
    source       TEXT NOT NULL,
    severity     TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- per-channel delivery results: [{channel:"...", ok:true, error:""}]
    deliveries   JSONB NOT NULL DEFAULT '[]'::jsonb,
    suppressed   BOOLEAN NOT NULL DEFAULT FALSE,
    suppressed_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_alert_events_at ON alert_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_kind_src ON alert_events(event_kind, source, fired_at DESC);

-- Per-(rule, source) silence ledger so dedupe works across restarts.
CREATE TABLE IF NOT EXISTS alert_silence (
    rule_id     UUID NOT NULL,
    source      TEXT NOT NULL,
    last_fired  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (rule_id, source)
);
