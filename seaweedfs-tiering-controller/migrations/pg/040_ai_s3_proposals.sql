-- AI S3 policy proposals — counterfactual learning surface for the
-- NL → IAM generator (POST /clusters/:id/s3/nl-policy).
--
-- The existing ai_review_outcomes table is task-bound (each row joins
-- ai_reviews → tasks → executions). S3 IAM proposals don't go through
-- the task pipeline — the operator types a sentence, the AI proposes
-- an action set, and the operator approves or discards. So we get a
-- parallel, lighter table: one row per proposal, mutated on decision.
--
-- Accuracy = approved / (approved + discarded). Decision rows where
-- the operator edited the action set are flagged as 'edited' rather
-- than 'approved' so we can measure proposal precision separately
-- from acceptance.
--
-- Rows are immutable on the original prompt + proposal fields after
-- insert; only the decision_* columns are updated.

CREATE TABLE IF NOT EXISTS ai_s3_proposals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id         UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by         TEXT NOT NULL DEFAULT '',  -- requester email
    provider_name      TEXT NOT NULL DEFAULT '',  -- which AI provider produced this
    prompt             TEXT NOT NULL,             -- operator's natural-language goal
    scope_hint         TEXT NOT NULL DEFAULT '',  -- optional bucket-prefix hint
    proposal_actions   JSONB NOT NULL,            -- AI proposed actions, e.g. ["Read","List"]
    proposal_buckets   JSONB NOT NULL,            -- AI proposed bucket patterns
    proposal_risk      TEXT NOT NULL,             -- low|medium|high
    proposal_explain   TEXT NOT NULL DEFAULT '',

    -- Decision (NULL until operator acts on the proposal). 'edited'
    -- means approved but with at least one diff vs the proposal.
    decision           TEXT,                      -- approved|discarded|edited
    decided_at         TIMESTAMPTZ,
    decided_by         TEXT,                      -- approver email
    applied_actions    JSONB,                     -- actually applied (may differ from proposal)
    applied_buckets    JSONB,
    applied_user       TEXT,                      -- IAM user the proposal was applied to

    CHECK (proposal_risk IN ('low','medium','high')),
    CHECK (decision IS NULL OR decision IN ('approved','discarded','edited'))
);

CREATE INDEX IF NOT EXISTS idx_ai_s3_proposals_cluster_created
    ON ai_s3_proposals (cluster_id, created_at DESC);

-- For the learning summary aggregates (filtered to recent N hours).
CREATE INDEX IF NOT EXISTS idx_ai_s3_proposals_decided
    ON ai_s3_proposals (decided_at DESC) WHERE decided_at IS NOT NULL;
