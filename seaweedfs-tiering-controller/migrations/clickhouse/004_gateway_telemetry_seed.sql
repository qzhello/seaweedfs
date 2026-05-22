-- Seed sample gateway telemetry so the Costs page and AI planner have
-- realistic input before the real gateway is wired up. Generates 30
-- days of events across a few buckets with contrasting access
-- patterns:
--
--   logs-archive       cold:   rare reads, heavy writes
--   media-thumbnails   hot:    many GETs, small bytes
--   user-uploads-2024  warm:   moderate mixed traffic
--   reports-quarterly  cold:   one read spike per quarter
--   backup-snapshots   frozen: writes only, ~zero reads
--
-- Safe to re-run: the inserts are additive; the MVs will reconcile.
-- For deterministic dashboards in a dev env, TRUNCATE first:
--   TRUNCATE TABLE tiering.gateway_events;

-- ===== media-thumbnails (HOT) =====
-- High request volume, small payloads, mostly GETs.
INSERT INTO tiering.gateway_events
SELECT
    now() - toIntervalSecond(intDiv(rand() % (30*86400*1000), 1) / 1000.0) AS ts,
    'gw-prod-1'                                              AS gateway_id,
    arrayElement(['tenant-app1','tenant-app2','tenant-cdn'], 1 + (rand() % 3)) AS tenant,
    'media-thumbnails'                                       AS bucket,
    concat('thumb/', toString(rand() % 50000), '.jpg')       AS object_key,
    'media'                                                  AS collection,
    arrayElement(['GET','GET','GET','GET','HEAD','PUT'], 1 + (rand() % 6)) AS operation,
    if(operation = 'PUT', 50000 + rand() % 100000, 0)        AS bytes_in,
    if(operation = 'GET', 30000 + rand() % 80000, 0)         AS bytes_out,
    5 + rand() % 60                                          AS latency_ms,
    if(rand() % 100 < 98, 200, 404)                          AS http_status,
    'local-ssd'                                              AS backend_used,
    'us-east-1'                                              AS region,
    concat('10.0.', toString(rand() % 256), '.', toString(rand() % 256)) AS source_ip,
    'aws-sdk-java/2.20'                                      AS user_agent,
    generateUUIDv4()                                         AS request_id
FROM numbers(60000);

-- ===== user-uploads-2024 (WARM) =====
INSERT INTO tiering.gateway_events
SELECT
    now() - toIntervalSecond(intDiv(rand() % (30*86400*1000), 1) / 1000.0) AS ts,
    'gw-prod-1',
    arrayElement(['tenant-mobile','tenant-web'], 1 + (rand() % 2)) AS tenant,
    'user-uploads-2024',
    concat('users/', toString(rand() % 5000), '/', toString(rand() % 200), '.bin'),
    'uploads',
    arrayElement(['GET','GET','PUT','HEAD','DELETE'], 1 + (rand() % 5)) AS operation,
    if(operation = 'PUT', 500000 + rand() % 5000000, 0),
    if(operation = 'GET', 100000 + rand() % 2000000, 0),
    20 + rand() % 200,
    if(rand() % 100 < 95, 200, 403),
    'local-hdd',
    'us-east-1',
    concat('10.1.', toString(rand() % 256), '.', toString(rand() % 256)),
    'curl/8.0',
    generateUUIDv4()
FROM numbers(8000);

-- ===== logs-archive (COLD) =====
-- Heavy writes early in the month, near-zero reads.
INSERT INTO tiering.gateway_events
SELECT
    now() - toIntervalSecond(intDiv(rand() % (30*86400*1000), 1) / 1000.0) AS ts,
    'gw-prod-2',
    'tenant-logs',
    'logs-archive',
    concat('2025/', toString(10 + rand() % 12), '/', toString(rand() % 50000), '.log.gz'),
    'logs',
    arrayElement(['PUT','PUT','PUT','PUT','GET'], 1 + (rand() % 5)) AS operation,
    if(operation = 'PUT', 1000000 + rand() % 10000000, 0),
    if(operation = 'GET', 1000000 + rand() % 5000000, 0),
    50 + rand() % 500,
    200,
    'local-hdd',
    'us-east-1',
    concat('10.2.', toString(rand() % 256), '.', toString(rand() % 256)),
    'fluent-bit/2.1',
    generateUUIDv4()
FROM numbers(4000);

-- ===== reports-quarterly (COLD with spike) =====
INSERT INTO tiering.gateway_events
SELECT
    now() - toIntervalSecond(intDiv(rand() % (30*86400*1000), 1) / 1000.0) AS ts,
    'gw-prod-1',
    'tenant-bi',
    'reports-quarterly',
    concat('q3/', toString(rand() % 200), '/report-', toString(rand() % 50), '.parquet'),
    'analytics',
    arrayElement(['GET','GET','PUT','HEAD'], 1 + (rand() % 4)) AS operation,
    if(operation = 'PUT', 10000000 + rand() % 50000000, 0),
    if(operation = 'GET', 5000000 + rand() % 20000000, 0),
    100 + rand() % 1000,
    200,
    'local-hdd',
    'us-east-1',
    concat('10.3.', toString(rand() % 256), '.', toString(rand() % 256)),
    'python-requests/2.31',
    generateUUIDv4()
FROM numbers(500);

-- ===== backup-snapshots (FROZEN) =====
-- PUT-only, zero reads. Perfect archive candidates.
INSERT INTO tiering.gateway_events
SELECT
    now() - toIntervalSecond(intDiv(rand() % (30*86400*1000), 1) / 1000.0) AS ts,
    'gw-prod-2',
    'tenant-backup',
    'backup-snapshots',
    concat('snap/', toString(rand() % 200), '/', toString(rand() % 30), '.tar'),
    'backup',
    'PUT' AS operation,
    100000000 + rand() % 500000000,
    0,
    1000 + rand() % 5000,
    200,
    'local-hdd',
    'us-east-1',
    concat('10.4.', toString(rand() % 256), '.', toString(rand() % 256)),
    'restic/0.16',
    generateUUIDv4()
FROM numbers(800);
