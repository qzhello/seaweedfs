-- Gateway telemetry — high-cardinality per-request event stream the
-- S3 / Filer gateway is expected to write into. Distinct from
-- `tiering.access_log` (which is volume-level) because gateway events
-- carry HTTP-layer dimensions (tenant / bucket / object_key / latency
-- / status) we need for cost-allocation and migration planning.
--
-- The schema is intentionally generous on columns so the gateway can
-- emit a single row per request without later schema migrations. TTL
-- is 180 days; aggregated dailies in `gateway_bucket_daily` retain the
-- full history.

CREATE TABLE IF NOT EXISTS tiering.gateway_events (
    ts            DateTime64(3),
    gateway_id    LowCardinality(String),
    tenant        LowCardinality(String),
    bucket        LowCardinality(String),
    object_key    String,
    collection    LowCardinality(String),
    operation     LowCardinality(String),
    bytes_in      UInt64 DEFAULT 0,
    bytes_out     UInt64 DEFAULT 0,
    latency_ms    UInt32 DEFAULT 0,
    http_status   UInt16 DEFAULT 200,
    backend_used  LowCardinality(String) DEFAULT '',
    region        LowCardinality(String) DEFAULT '',
    source_ip     String DEFAULT '',
    user_agent    String DEFAULT '',
    request_id    String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (ts, bucket, operation)
TTL toDateTime(ts) + INTERVAL 180 DAY;

-- Per-day bucket × tenant × operation rollup. Powers dashboards that
-- need to scan months without touching the raw events table.
CREATE TABLE IF NOT EXISTS tiering.gateway_bucket_daily (
    day            Date,
    bucket         LowCardinality(String),
    tenant         LowCardinality(String),
    operation      LowCardinality(String),
    requests       UInt64,
    bytes_in       UInt64,
    bytes_out      UInt64,
    latency_p50_ms AggregateFunction(quantile(0.5), UInt32),
    latency_p99_ms AggregateFunction(quantile(0.99), UInt32)
)
ENGINE = SummingMergeTree
ORDER BY (day, bucket, tenant, operation);

CREATE MATERIALIZED VIEW IF NOT EXISTS tiering.mv_gateway_bucket_daily
TO tiering.gateway_bucket_daily AS
SELECT
    toDate(ts)                AS day,
    bucket,
    tenant,
    operation,
    count()                    AS requests,
    sum(bytes_in)              AS bytes_in,
    sum(bytes_out)             AS bytes_out,
    quantileState(0.5)(latency_ms) AS latency_p50_ms,
    quantileState(0.99)(latency_ms) AS latency_p99_ms
FROM tiering.gateway_events
GROUP BY day, bucket, tenant, operation;

-- Object-level recency MV — for each (bucket, object_key) track when
-- it was last touched and total read bytes. Lets the AI planner
-- answer "this object hasn't been read in 60 days, archive it".
-- AggregatingMergeTree on the natural key keeps storage bounded
-- even for tens of millions of objects.
CREATE TABLE IF NOT EXISTS tiering.gateway_object_recency (
    bucket          LowCardinality(String),
    object_key      String,
    last_access_at  SimpleAggregateFunction(max, DateTime64(3)),
    last_write_at   SimpleAggregateFunction(max, DateTime64(3)),
    read_count_30d  SimpleAggregateFunction(sum, UInt64),
    bytes_out_30d   SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
ORDER BY (bucket, object_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS tiering.mv_gateway_object_recency
TO tiering.gateway_object_recency AS
SELECT
    bucket,
    object_key,
    max(ts)                                                          AS last_access_at,
    maxIf(ts, operation IN ('PUT', 'COMPLETE'))                       AS last_write_at,
    countIf(operation = 'GET')                                        AS read_count_30d,
    sumIf(bytes_out, operation = 'GET')                               AS bytes_out_30d
FROM tiering.gateway_events
GROUP BY bucket, object_key;
