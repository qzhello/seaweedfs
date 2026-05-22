-- Convert tiering.volume_features from a "latest snapshot only"
-- ReplacingMergeTree(ORDER BY volume_id) into a time-series MergeTree
-- so the scheduler keeps history. This unlocks:
--   - true policy time-machine (sim against a past snapshot)
--   - postmortem trend visualisation (before vs after migration)
--   - AI prompt enrichment ("reads_30d has dropped 6w in a row")
--
-- The legacy table has no writer in the codebase, so dropping it is
-- safe: nothing depends on its contents.
DROP TABLE IF EXISTS tiering.volume_features;

CREATE TABLE IF NOT EXISTS tiering.volume_features (
    snapshot_at         DateTime CODEC(DoubleDelta, ZSTD(1)),
    volume_id           UInt32,
    collection          LowCardinality(String),
    size_bytes          UInt64,
    is_readonly         UInt8,
    quiet_for_seconds   UInt64,
    last_access_seconds UInt64,
    reads_7d            UInt64,
    reads_30d           UInt64,
    writes_30d          UInt64,
    unique_keys_30d     UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(snapshot_at)
ORDER BY (volume_id, snapshot_at)
TTL toDateTime(snapshot_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
