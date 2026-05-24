-- AI S3 circuit-breaker limit proposals — counterfactual learning surface
-- for the `recommend_s3_limits` endpoint.
--
-- Parallel to ai_s3_proposals (migration 040) but with a different
-- payload shape: instead of (actions, buckets) tuples the proposal is
-- a single (type, value) pair plus the AI's reasoning. We keep the
-- tables separate rather than overload ai_s3_proposals because:
--   1. The schemas genuinely differ (no actions array, no bucket list).
--   2. The Learning panel renders distinct cards for each kind and
--      benefits from clean per-table aggregation.
--   3. Future S3 proposal kinds (lifecycle, retention) can pick the
--      same per-table pattern instead of accumulating optional columns.

CREATE TABLE IF NOT EXISTS ai_s3_limit_proposals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id         UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by         TEXT NOT NULL DEFAULT '',
    provider_name      TEXT NOT NULL DEFAULT '',

    -- Snapshot the AI saw at decision time. Stored verbatim so future
    -- audits can replay why this proposal was made.
    snapshot           JSONB NOT NULL,           -- current limits + trigger counts + cluster shape

    proposal_type      TEXT NOT NULL,            -- Count | MB
    proposal_value     BIGINT NOT NULL,          -- the suggested numeric threshold
    proposal_risk      TEXT NOT NULL,            -- low | medium | high
    proposal_explain   TEXT NOT NULL DEFAULT '',

    decision           TEXT,                     -- approved | discarded | edited
    decided_at         TIMESTAMPTZ,
    decided_by         TEXT,
    applied_type       TEXT,                     -- what was actually applied (may differ)
    applied_value      BIGINT,

    CHECK (proposal_type IN ('Count','MB')),
    CHECK (applied_type IS NULL OR applied_type IN ('Count','MB')),
    CHECK (proposal_risk IN ('low','medium','high')),
    CHECK (decision IS NULL OR decision IN ('approved','discarded','edited'))
);

CREATE INDEX IF NOT EXISTS idx_ai_s3_limit_proposals_cluster_created
    ON ai_s3_limit_proposals (cluster_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_s3_limit_proposals_decided
    ON ai_s3_limit_proposals (decided_at DESC) WHERE decided_at IS NOT NULL;
