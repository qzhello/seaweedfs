-- ============================================================
-- Migration 007 — Safety: blocklist + maintenance windows
-- emergency_stop and change_window already live in system_config (003).
-- This migration adds the per-resource blocklist and per-cluster
-- maintenance calendar that the scheduler also checks before queueing.
-- ============================================================

CREATE TABLE IF NOT EXISTS migration_blocklist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Match scope: 'collection' | 'bucket' | 'volume_id' | 'cluster'
    scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('collection','bucket','volume_id','cluster')),
    -- Exact value, or a glob (we support trailing/leading * for v1).
    scope_value TEXT NOT NULL,
    -- Specific actions denied; empty array = all actions denied.
    actions     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- 'deny' = absolute (the only mode for v1)
    -- 'allow' = whitelist override (overrides any matching deny). Reserved.
    mode        TEXT NOT NULL DEFAULT 'deny' CHECK (mode IN ('deny','allow')),
    reason      TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    expires_at  TIMESTAMPTZ,                          -- NULL = never expire
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(scope_kind, scope_value)
);
CREATE INDEX IF NOT EXISTS idx_blocklist_scope ON migration_blocklist(scope_kind, scope_value);

CREATE TABLE IF NOT EXISTS maintenance_windows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id  UUID REFERENCES clusters(id) ON DELETE CASCADE,    -- NULL = global
    name        TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_maint_active ON maintenance_windows(starts_at, ends_at);

-- Convenience view: rows currently in effect
CREATE OR REPLACE VIEW maintenance_active AS
SELECT * FROM maintenance_windows WHERE NOW() BETWEEN starts_at AND ends_at;
