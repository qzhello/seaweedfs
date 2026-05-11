-- Sprint 3-4: cyclical-pattern fingerprints + cohort baselines.
--
-- We don't compute these in CH; they're computed in Go (autocorrelation +
-- z-score) and written back here as the source of truth for the Web UI's
-- volume-profile page and for the scorer's cohort feature lookup.

CREATE TABLE IF NOT EXISTS tiering.volume_pattern (
    snapshot_at        DateTime,
    volume_id          UInt32,
    business_domain    LowCardinality(String),  -- denormalized from PG resource_tags

    -- Daily / weekly autocorrelation in [-1, 1]. >0.5 ⇒ cyclical.
    acf_24h            Float32,
    acf_168h           Float32,

    -- Quick classification cache so UI doesn't recompute.
    cycle_kind         LowCardinality(String),  -- 'daily' | 'weekly' | 'flat' | 'spiky' | 'unknown'

    -- Activity level used for cohort comparison.
    reads_7d           UInt64,
    reads_per_byte_7d  Float64,                 -- normalized for size bias

    -- Cohort z-score within (business_domain): how unusual is this volume's
    -- read intensity vs same-domain peers? |z| > 3 → anomaly trigger.
    cohort_z_reads     Float32,

    -- Hourly sparkline (last 168h, oldest→newest). Stored as Array for the
    -- volume-profile UI to render without re-querying access_log.
    sparkline_168h     Array(UInt32)
)
ENGINE = ReplacingMergeTree(snapshot_at)
ORDER BY (volume_id);

-- Domain-level baseline updated at the same cadence — surfaces "this domain
-- normally does X reads/byte" on the dashboard.
CREATE TABLE IF NOT EXISTS tiering.cohort_baseline (
    snapshot_at        DateTime,
    business_domain    LowCardinality(String),
    volume_count       UInt32,
    mean_reads_per_byte Float64,
    stddev_reads_per_byte Float64,
    p50_reads          UInt64,
    p95_reads          UInt64
)
ENGINE = ReplacingMergeTree(snapshot_at)
ORDER BY (business_domain);
