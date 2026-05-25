-- ============================================================
-- 045: ai_budgets — monthly spend limits with warn/critical
-- thresholds, evaluated against ai_usage_events × ai_model_pricing.
--
-- Scope can target:
--   - "global": one row that caps total fleet spend
--   - "provider": per-provider cap (e.g. anthropic-only)
--   - "user":     per-user cap (UUID stored as scope_value)
--
-- We deliberately *do not* enforce a hard cutoff at the LLM call
-- site — operators want notification and dashboard surfacing, not
-- a kill switch that breaks the assistant mid-conversation. The
-- evaluator fires one alert per (budget, calendar-month, tier),
-- de-duped via ai_budget_alert_history.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_budgets (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     TEXT NOT NULL,
    scope_type               TEXT NOT NULL CHECK (scope_type IN ('global','provider','user')),
    -- "" for global; provider name (e.g. "openai") for provider scope;
    -- user UUID string for user scope. We keep this as text rather than
    -- a polymorphic FK to make joins / displays simpler — the price of
    -- a stale row pointing at a deleted user is one orphaned budget the
    -- editor can clean up, not a crash.
    scope_value              TEXT NOT NULL DEFAULT '',
    monthly_limit            NUMERIC(12,2) NOT NULL,
    currency                 TEXT NOT NULL DEFAULT 'USD',
    -- Percent thresholds at which the evaluator opens an alert.
    -- 80 / 100 are the operator defaults — generous head-room and
    -- the actual breach. Schema permits any 1–999 so a budget can
    -- raise the floor (e.g. "warn at 50%") when needed.
    threshold_warn_pct       INTEGER NOT NULL DEFAULT 80
        CHECK (threshold_warn_pct BETWEEN 1 AND 999),
    threshold_critical_pct   INTEGER NOT NULL DEFAULT 100
        CHECK (threshold_critical_pct BETWEEN 1 AND 999),
    active                   BOOLEAN NOT NULL DEFAULT TRUE,
    notes                    TEXT NOT NULL DEFAULT '',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One budget per (scope_type, scope_value) so the evaluator
    -- doesn't compound multiple caps for the same target.
    UNIQUE (scope_type, scope_value)
);

CREATE INDEX IF NOT EXISTS idx_ai_budgets_active
    ON ai_budgets(active) WHERE active = TRUE;

-- Dedupe history: one row per (budget, month, tier) the evaluator
-- has already fired for. Prevents alert spam when the evaluator
-- runs every minute and the spend stays above 80% for the rest of
-- the month.
CREATE TABLE IF NOT EXISTS ai_budget_alert_history (
    budget_id      UUID NOT NULL REFERENCES ai_budgets(id) ON DELETE CASCADE,
    calendar_month DATE NOT NULL,  -- date_trunc('month', now())
    tier           TEXT NOT NULL CHECK (tier IN ('warn','critical')),
    fired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (budget_id, calendar_month, tier)
);
