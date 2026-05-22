-- ============================================================
-- Migration 034 — Analyzer script versioning
--
-- analyzer_script_versions captures every saved body. We append a
-- row on each upsert so operators can diff and revert. The current
-- live body still lives on analyzer_scripts; this table is the
-- history tail.
--
-- analyzer_scripts.version is the monotonic counter so the UI can
-- show "v3" next to "Edited 2 hours ago".
-- ============================================================

ALTER TABLE analyzer_scripts
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS analyzer_script_versions (
    id          BIGSERIAL PRIMARY KEY,
    script_id   UUID NOT NULL REFERENCES analyzer_scripts(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    params      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- "user-edit", "ai-optimize", "import", ...
    reason      TEXT NOT NULL DEFAULT '',
    actor       TEXT NOT NULL DEFAULT '',
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (script_id, version)
);
CREATE INDEX IF NOT EXISTS idx_analyzer_versions_sid ON analyzer_script_versions(script_id, version DESC);
