-- AI bucket-level cost proposals — counterfactual learning surface
-- for the per-bucket cost-plan endpoint. Extends the existing
-- collection-level /costs/ai-plan with bucket granularity.
--
-- Why a new table instead of folding into the existing migration tasks
-- table:
--   1. The action set is bucket-shaped (set_quota, cleanup_uploads,
--      review_for_deletion, investigate_tiering), not volume-shaped
--      (tier.move).
--   2. We want operator approve/discard signal for the AI Learning
--      panel, same as ai_s3_proposals (040) and ai_s3_limit_proposals
--      (041). Hard-rule task workflow doesn't separate "ignored" from
--      "open" cleanly.
--   3. Many proposals are advisory (investigate_tiering) and shouldn't
--      live in the tasks table at all.

CREATE TABLE IF NOT EXISTS ai_bucket_cost_proposals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id         UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by         TEXT NOT NULL DEFAULT '',
    provider_name      TEXT NOT NULL DEFAULT '',

    -- Snapshot of the bucket telemetry the AI saw. Stored verbatim so
    -- future audits can replay why a proposal was made.
    snapshot           JSONB NOT NULL,

    bucket             TEXT NOT NULL,
    proposal_action    TEXT NOT NULL,            -- set_quota | cleanup_uploads | review_for_deletion | investigate_tiering
    proposal_value     JSONB NOT NULL DEFAULT '{}'::jsonb, -- action-specific payload (e.g. {"quota_mb": 50000})
    proposal_risk      TEXT NOT NULL,            -- low | medium | high
    proposal_explain   TEXT NOT NULL DEFAULT '',
    est_monthly_saving NUMERIC(14,2) NOT NULL DEFAULT 0,
    currency           TEXT NOT NULL DEFAULT 'USD',

    decision           TEXT,                     -- approved | discarded | edited
    decided_at         TIMESTAMPTZ,
    decided_by         TEXT,
    applied_value      JSONB,                    -- what was actually applied (may differ for "edited")

    CHECK (proposal_action IN
        ('set_quota','cleanup_uploads','review_for_deletion','investigate_tiering')),
    CHECK (proposal_risk IN ('low','medium','high')),
    CHECK (decision IS NULL OR decision IN ('approved','discarded','edited'))
);

CREATE INDEX IF NOT EXISTS idx_ai_bucket_cost_proposals_cluster_created
    ON ai_bucket_cost_proposals (cluster_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_bucket_cost_proposals_decided
    ON ai_bucket_cost_proposals (decided_at DESC) WHERE decided_at IS NOT NULL;
