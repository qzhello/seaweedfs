-- Bucket governance — controller-side per-bucket metadata.
--
-- Two things SeaweedFS itself doesn't track:
--   1. Ownership: who is the responsible person for a bucket (a human,
--      for accountability and notifications) plus their user key (UK) —
--      distinct from the S3 IAM owner identity.
--   2. Data lifecycle: a retention period. The lifecycle scan walks the
--      bucket and caches how much data is older than retention_days
--      ("expired but not yet deleted"). Deletion stays manual — this
--      table is the monitoring surface, not an auto-deleter.
--
-- One row per (cluster, bucket). Scan columns are refreshed by the
-- on-demand lifecycle scan; owner/retention by the operator.

CREATE TABLE IF NOT EXISTS bucket_governance (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    bucket_name     TEXT NOT NULL,
    owner_name      TEXT NOT NULL DEFAULT '',   -- responsible person (name or email)
    owner_user_key  TEXT NOT NULL DEFAULT '',   -- user key / employee id / S3 identity
    retention_days  INTEGER,                    -- NULL = no retention rule
    notes           TEXT NOT NULL DEFAULT '',
    last_scan_at    TIMESTAMPTZ,                -- NULL until first lifecycle scan
    expired_objects BIGINT NOT NULL DEFAULT 0,  -- files older than retention_days at last scan
    expired_bytes   BIGINT NOT NULL DEFAULT 0,
    scan_truncated  BOOLEAN NOT NULL DEFAULT FALSE, -- walk hit the entry/depth cap
    expired_sample  JSONB,                      -- sample of expired file paths
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cluster_id, bucket_name)
);

CREATE INDEX IF NOT EXISTS idx_bucket_governance_cluster
    ON bucket_governance (cluster_id);
