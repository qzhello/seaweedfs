-- ============================================================
-- Tiering Controller — PostgreSQL schema
-- Stores: policies, tasks, executions, audit, AI provider config
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Policies bind a scope (collection / bucket / regex) to a strategy template.
CREATE TABLE IF NOT EXISTS policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('collection','bucket','regex','global')),
    scope_value     TEXT NOT NULL DEFAULT '*',
    strategy        TEXT NOT NULL CHECK (strategy IN ('hot_replicate','warm_ec','cold_cloud','archive')),
    -- JSON: {to_ec:0.55, to_cloud:0.75, weights:{...}, target_backend:"s3-glacier"}
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    sample_rate     NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    dry_run         BOOLEAN NOT NULL DEFAULT TRUE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each volume scoring run yields recommendations → one task per recommendation.
CREATE TABLE IF NOT EXISTS tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    volume_id       INTEGER NOT NULL,
    collection      TEXT NOT NULL DEFAULT '',
    src_server      TEXT NOT NULL,
    src_disk_type   TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('tier_move','ec_encode','tier_upload','tier_download','ec_decode')),
    target          JSONB NOT NULL,                 -- {disk_type:"hdd"} or {backend:"s3-cold"}
    score           NUMERIC(5,4) NOT NULL,
    features        JSONB NOT NULL DEFAULT '{}'::jsonb,
    explanation     TEXT NOT NULL DEFAULT '',       -- 人类可读的打分理由(AI/规则产出)
    policy_id       UUID REFERENCES policies(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','running','succeeded','failed','rolled_back','cancelled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    approved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_volume         ON tasks(volume_id);

-- One execution per attempt; preserves rollback metadata.
CREATE TABLE IF NOT EXISTS executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    trace_id        TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','rolled_back')),
    rollback_kind   TEXT,                            -- e.g. 'tier_download' for rolling back upload
    rollback_args   JSONB NOT NULL DEFAULT '{}'::jsonb,
    log             TEXT NOT NULL DEFAULT '',       -- captured stdout/stderr or step log
    error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_task    ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at DESC);

-- Cooldown: prevent re-migrating the same volume within N days.
CREATE TABLE IF NOT EXISTS volume_cooldown (
    volume_id       INTEGER PRIMARY KEY,
    last_action     TEXT NOT NULL,
    last_at         TIMESTAMPTZ NOT NULL,
    reason          TEXT
);

-- AI provider config (encrypted secrets ideally come from KMS in prod).
CREATE TABLE IF NOT EXISTS ai_providers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL CHECK (kind IN ('openai','anthropic','rule','local')),
    name            TEXT NOT NULL UNIQUE,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {model, base_url, ...}
    secret_ref      TEXT NOT NULL DEFAULT '',              -- e.g. env:OPENAI_API_KEY
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Generic audit log (UI actions, policy edits, force run/rollback).
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor           TEXT NOT NULL,
    action          TEXT NOT NULL,
    target_kind     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
