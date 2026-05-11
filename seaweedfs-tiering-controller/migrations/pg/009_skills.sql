-- Sprint 3-1: Skill registry.
--
-- A "Skill" is a versioned, declarative recipe for one operation against
-- SeaweedFS (or against the controller itself). Built-in skills ship with
-- the binary as scope='system' and are upserted on startup. Operator-defined
-- SOPs are scope='custom' and are edited from the Web Console.
--
-- definition JSONB schema is enforced at the application layer (see
-- internal/skill/schema.go). Roughly:
--   {
--     "summary":    "Move volume to remote tier",
--     "params":     [ { "name": "...", "type": "...", "required": true } ],
--     "preconditions": [ {...} ],
--     "steps":         [ {...} ],
--     "postchecks":    [ {...} ],
--     "rollback":      [ {...} ]
--   }

CREATE TABLE IF NOT EXISTS skills (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier, e.g. "volume.tier_upload". Lowercase, dotted.
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- 'system' (built-in, immutable except by upgrade) or 'custom' (operator).
  scope        TEXT NOT NULL CHECK (scope IN ('system','custom')),
  -- Coarse risk classification used to gate UI confirmations and alerts.
  risk_level   TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  -- Human-readable category, e.g. "tiering","ec","topology","maintenance".
  category     TEXT NOT NULL DEFAULT 'general',
  version      INT  NOT NULL DEFAULT 1,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Validated against skill.schema by the controller before insert/update.
  definition   JSONB NOT NULL,
  -- Operator note used in audit trail when a SOP is edited.
  change_note  TEXT,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active row per (key, version). Older versions are kept for audit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_key_version
  ON skills (key, version);

-- Look up "current" version of a skill quickly.
CREATE INDEX IF NOT EXISTS idx_skills_key_enabled
  ON skills (key) WHERE enabled = TRUE;

-- Append-only history for diff/rollback in the Web UI.
CREATE TABLE IF NOT EXISTS skill_history (
  id         BIGSERIAL PRIMARY KEY,
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  version    INT  NOT NULL,
  definition JSONB NOT NULL,
  change_note TEXT,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_history_key
  ON skill_history (key, changed_at DESC);

-- Per-execution record so the Skill store page can show "last 7d success rate"
-- without scanning the full executions table.
CREATE TABLE IF NOT EXISTS skill_executions (
  id           BIGSERIAL PRIMARY KEY,
  skill_id     UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_key    TEXT NOT NULL,
  skill_version INT NOT NULL,
  task_id      UUID,
  cluster_id   UUID,
  volume_id    INT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','rolled_back','dry_run')),
  duration_ms  INT,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_executions_key_time
  ON skill_executions (skill_key, started_at DESC);
