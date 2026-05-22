-- ============================================================
-- 029: ai_tool_policies — per-tool authorization for the floating
-- assistant. The SSE handler reads this table on every chat turn and
-- only exposes tools where ai_allowed = TRUE to the LLM. Operators
-- can still invoke any tool directly from the controller UI; the
-- policy only constrains what the AI is allowed to choose
-- autonomously.
-- ============================================================
--
-- Why a table instead of code constants:
--   1. Operators want to turn off AI access without redeploying.
--   2. Different deployments have different risk appetites — a sandbox
--      may allow `toggle_skill` while prod denies it.
--   3. Audit: changes to the table are logged so we know who turned
--      what on/off.
--
-- Default policy is conservative: only read tools start enabled.
-- Write/destructive tools must be explicitly turned on per cluster.

CREATE TABLE IF NOT EXISTS ai_tool_policies (
    tool_name    TEXT PRIMARY KEY,
    -- "read" | "write" | "destructive". The runtime classifies each
    -- tool at registration time; this column is a denormalised
    -- snapshot so the admin UI can show it without joining code.
    risk_level   TEXT NOT NULL CHECK (risk_level IN ('read','write','destructive')),
    -- Master switch: does the assistant get this tool in its toolspec
    -- on the next call? FALSE means the LLM literally can't choose it.
    ai_allowed   BOOLEAN NOT NULL DEFAULT FALSE,
    -- Free-form note shown next to the toggle in /ai-config so admins
    -- remember why a particular tool is open or closed.
    note         TEXT NOT NULL DEFAULT '',
    updated_by   TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the catalogue. Read-only tools are pre-enabled so the
-- assistant works out of the box; write/destructive tools default
-- closed and require an explicit toggle. We use ON CONFLICT DO
-- NOTHING so re-running the migration doesn't trample operator
-- toggles.
INSERT INTO ai_tool_policies (tool_name, risk_level, ai_allowed, note) VALUES
    ('list_clusters',  'read', TRUE,  'Read-only: list known clusters.'),
    ('list_volumes',   'read', TRUE,  'Read-only: list volumes in a cluster.'),
    ('get_ec_shards',  'read', TRUE,  'Read-only: EC shard matrix.'),
    ('list_skills',    'read', TRUE,  'Read-only: enumerate SOPs.'),
    ('get_skill',      'read', TRUE,  'Read-only: fetch one SOP body.'),
    ('toggle_skill',   'write', FALSE, 'Enable/disable a SOP. Off by default — flip on if you trust the assistant to manage SOPs.')
ON CONFLICT (tool_name) DO NOTHING;
