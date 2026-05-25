-- ============================================================
-- 044: ai_model_pricing — per-model token pricing for the AI
-- Usage panel's cost columns.
--
-- We keep this lookup table tiny and operator-managed rather
-- than scraped from vendor APIs:
--   - vendor pricing changes infrequently and never inside a hot path
--   - many of our model labels are gateway aliases (oneapi, openrouter)
--     where the vendor SDK can't price them anyway
--   - operators in some regions pay a different rate than the public
--     list, and want to override it cleanly
--
-- The dashboard joins this table against ai_usage_events rollups
-- *in Go*, not SQL — see internal/store/ai_usage.go. Unknown
-- (provider, model) pairs simply contribute zero cost; the panel
-- surfaces them as "unpriced" so the operator notices.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_model_pricing (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider                  TEXT NOT NULL,
    model                     TEXT NOT NULL,
    -- USD (or whatever currency the operator chooses) per 1 million tokens.
    -- 1M is the unit every major vendor publishes today; switching to
    -- per-1k would just push float imprecision into the rollup math.
    input_price_per_1m_tokens NUMERIC(12,4) NOT NULL DEFAULT 0,
    output_price_per_1m_tokens NUMERIC(12,4) NOT NULL DEFAULT 0,
    currency                  TEXT NOT NULL DEFAULT 'USD',
    notes                     TEXT NOT NULL DEFAULT '',
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, model)
);

-- Seed a handful of well-known list prices so the panel has
-- something to show before the operator opens the editor. These
-- are USD/1M tokens as published on each vendor's pricing page
-- at migration time; operators can override any row in the UI.
-- Lower-cost / smaller models are seeded preferentially since
-- they're what most controllers actually hit.
INSERT INTO ai_model_pricing
    (provider, model, input_price_per_1m_tokens, output_price_per_1m_tokens, notes)
VALUES
    ('openai',    'gpt-4o-mini',          0.15,  0.60,  'seed'),
    ('openai',    'gpt-4o',               2.50,  10.00, 'seed'),
    ('anthropic', 'claude-haiku-4-5',     1.00,  5.00,  'seed'),
    ('anthropic', 'claude-sonnet-4-6',    3.00,  15.00, 'seed'),
    ('deepseek',  'deepseek-chat',        0.27,  1.10,  'seed')
ON CONFLICT (provider, model) DO NOTHING;
