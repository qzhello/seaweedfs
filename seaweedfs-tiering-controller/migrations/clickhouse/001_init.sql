-- ============================================================
-- Tiering Controller — ClickHouse schema
-- Hot path: object access logs → aggregations → scoring features
-- ============================================================

CREATE DATABASE IF NOT EXISTS tiering;

-- Raw S3 / filer access events. Sized for ~100M events/day per shard.
CREATE TABLE IF NOT EXISTS tiering.access_log (
    ts            DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    bucket        LowCardinality(String),
    collection    LowCardinality(String),
    volume_id     UInt32,
    file_id       String,
    path          String,
    operation     LowCardinality(String),     -- GET / PUT / HEAD / DELETE
    object_size   UInt64,
    bytes_sent    UInt64,
    total_time_ms UInt32,
    http_status   UInt16,
    requester     String,
    remote_ip     String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (volume_id, ts)
TTL toDateTime(ts) + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

-- Hourly volume rollups, materialized for fast heatmap and scoring.
CREATE TABLE IF NOT EXISTS tiering.volume_stats_hourly (
    hour          DateTime,
    volume_id     UInt32,
    collection    LowCardinality(String),
    reads         UInt64,
    writes        UInt64,
    bytes_read    UInt64,
    bytes_written UInt64,
    unique_keys   AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (volume_id, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS tiering.mv_volume_stats_hourly
TO tiering.volume_stats_hourly AS
SELECT
    toStartOfHour(ts) AS hour,
    volume_id,
    collection,
    countIf(operation = 'GET')               AS reads,
    countIf(operation IN ('PUT','POST'))     AS writes,
    sumIf(bytes_sent, operation = 'GET')     AS bytes_read,
    sumIf(object_size, operation IN ('PUT','POST')) AS bytes_written,
    uniqState(file_id)                       AS unique_keys
FROM tiering.access_log
GROUP BY hour, volume_id, collection;

-- Per-object profile (sampled / aggregated). Used for object-level decisions later.
CREATE TABLE IF NOT EXISTS tiering.object_profile (
    file_id        String,
    volume_id      UInt32,
    bucket         LowCardinality(String),
    path           String,
    object_size    UInt64,
    last_access    DateTime,
    last_write     DateTime,
    access_7d      UInt32,
    access_30d     UInt32,
    access_90d     UInt32,
    updated_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (volume_id, file_id);

-- Volume-level rollup snapshot consumed by scorer.
CREATE TABLE IF NOT EXISTS tiering.volume_features (
    snapshot_at        DateTime,
    volume_id          UInt32,
    collection         LowCardinality(String),
    size_bytes         UInt64,
    is_readonly        UInt8,
    quiet_for_seconds  UInt64,
    last_access_seconds UInt64,
    reads_7d           UInt64,
    reads_30d          UInt64,
    writes_30d         UInt64,
    unique_keys_30d    UInt64
)
ENGINE = ReplacingMergeTree(snapshot_at)
ORDER BY (volume_id);
