-- ============================================================
-- 043: ai_usage_events — per-call AI token usage accounting
--
-- One row per LLM round trip (chat, streaming chat, jsonchat).
-- Captured client-side by the provider implementations and
-- persisted via the request-scoped UsageRecorder wired in
-- internal/api/ai_usage.go.
--
-- Zero token counts mean "vendor did not report" (e.g. an error
-- response or a streaming call where include_usage was rejected).
-- The aggregation views in internal/store/ai_usage.go treat zero
-- as unknown for cost rollups but still count the attempt.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_usage_events (
    id            BIGSERIAL PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    -- Coarse-grained operation classifier so we can split chat vs
    -- structured-JSON usage on the dashboard. Free-form to support
    -- future operations (e.g. embedding) without a migration.
    operation     TEXT NOT NULL,
    input_tokens  BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    latency_ms    INTEGER NOT NULL DEFAULT 0,
    -- Empty string = success. Free-form provider-side error string,
    -- truncated to 200 chars by the recorder to keep rows compact.
    error         TEXT NOT NULL DEFAULT '',
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    chat_id       UUID  -- ai_chats / assistant_chats reference, nullable
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_occurred
    ON ai_usage_events(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_model
    ON ai_usage_events(provider, model, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user
    ON ai_usage_events(user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;
