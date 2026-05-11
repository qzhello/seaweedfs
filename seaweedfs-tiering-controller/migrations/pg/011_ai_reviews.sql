-- Sprint 4-2: multi-round AI review per task.
--
-- Each task gets up to 3 rounds:
--   1. initial_scan   — quick yes/no on whether the action makes sense.
--   2. deep_analysis  — looks at cohort + cyclical pattern + business context.
--   3. devils_advocate — adversarial pass: list reasons NOT to migrate.
--
-- The aggregate verdict (proceed / abort / needs_human) is computed in Go from
-- the three rounds and recorded on the parent ai_reviews row.

CREATE TABLE IF NOT EXISTS ai_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Aggregate verdict from the orchestrator. NULL while in flight.
  verdict         TEXT CHECK (verdict IN ('proceed','abort','needs_human')),
  confidence      REAL,                          -- 0..1
  -- Provider used for ALL rounds (kept consistent for traceability).
  provider_id     UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  provider_name   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','complete','failed')),
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- One review per task at a time. Re-running after an edit creates a new row.
CREATE INDEX IF NOT EXISTS idx_ai_reviews_task_started
  ON ai_reviews (task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_review_rounds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID NOT NULL REFERENCES ai_reviews(id) ON DELETE CASCADE,
  round_number    INT  NOT NULL CHECK (round_number BETWEEN 1 AND 5),
  round_kind      TEXT NOT NULL CHECK (round_kind IN
                  ('initial_scan','deep_analysis','devils_advocate','custom')),

  -- Structured output the LLM is prompted to return as JSON. The orchestrator
  -- parses {verdict, confidence, reasoning, factors:[{name,weight,note}]}.
  verdict         TEXT CHECK (verdict IN ('proceed','abort','needs_human')),
  confidence      REAL,
  reasoning       TEXT NOT NULL DEFAULT '',
  factors         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Raw prompt + response so operators can audit / debug. Trimmed if huge.
  prompt          TEXT NOT NULL DEFAULT '',
  raw_response    TEXT NOT NULL DEFAULT '',

  duration_ms     INT,
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_round
  ON ai_review_rounds (review_id, round_number);
CREATE INDEX IF NOT EXISTS idx_ai_review_rounds_review
  ON ai_review_rounds (review_id, round_number);
