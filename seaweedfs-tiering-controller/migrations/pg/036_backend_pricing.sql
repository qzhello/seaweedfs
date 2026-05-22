-- Backend pricing + monthly cost snapshots for the Costs dashboard.
--
-- Pricing rows are keyed by a `name` string that matches what the
-- topology calls each backend:
--   - Cloud-tiered volumes: the `RemoteStorageName` from `weed shell`.
--   - Local volumes:        "local-<disk_type>" (e.g. "local-hdd"),
--                            or just "local" when disk_type is empty.
--
-- Exactly one row should be flagged is_hot_reference=true; that row's
-- $/TB price is the basis for the counterfactual ("if every byte were
-- on this tier with 3 replicas, what would it cost?"). The dashboard
-- subtracts the actual cost from the counterfactual to surface the
-- ROI delivered by EC + tiering.

CREATE TABLE IF NOT EXISTS backend_pricing (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                          TEXT NOT NULL UNIQUE,
    display_name                  TEXT NOT NULL,
    kind                          TEXT NOT NULL DEFAULT 'warm',
    currency                      TEXT NOT NULL DEFAULT 'USD',
    storage_price_per_tb_month    NUMERIC(14,4) NOT NULL DEFAULT 0,
    egress_price_per_tb           NUMERIC(14,4) NOT NULL DEFAULT 0,
    request_price_per_million     NUMERIC(14,4) NOT NULL DEFAULT 0,
    min_billable_bytes            BIGINT        NOT NULL DEFAULT 0,
    -- replication_factor lets us model cloud-side redundancy that
    -- isn't visible in our topology (e.g. S3 already keeps 3 copies,
    -- so 1B on S3 = 1B billed; SeaweedFS local with replication=011
    -- already shows up 2x in the topology so this stays 1.0).
    replication_factor            NUMERIC(6,2)  NOT NULL DEFAULT 1.0,
    is_hot_reference              BOOLEAN       NOT NULL DEFAULT false,
    notes                         TEXT          NOT NULL DEFAULT '',
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Only one row may be the hot reference; partial unique index is the
-- cheapest enforcement and keeps inserts of non-reference rows fast.
CREATE UNIQUE INDEX IF NOT EXISTS backend_pricing_one_hot
    ON backend_pricing ((1)) WHERE is_hot_reference;

-- cost_snapshots is the time-series backing the 12-month chart. One
-- row per (cluster, backend, year_month). Updated by the snapshotter
-- (manual button + planned daily cron); idempotent on
-- (cluster_id, backend_name, year_month).
CREATE TABLE IF NOT EXISTS cost_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id          UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    backend_name        TEXT NOT NULL,
    year_month          DATE NOT NULL,           -- first-of-month for the bucket
    physical_bytes      BIGINT NOT NULL DEFAULT 0,
    logical_bytes       BIGINT NOT NULL DEFAULT 0,
    cost_estimate       NUMERIC(16,4) NOT NULL DEFAULT 0,
    counterfactual_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'USD',
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, backend_name, year_month)
);

CREATE INDEX IF NOT EXISTS cost_snapshots_chart_idx
    ON cost_snapshots(cluster_id, year_month DESC);

-- Seed a sensible starter set so the Costs page renders something
-- on first visit. Operators are expected to overwrite the numbers,
-- but the names + kinds make the dashboard immediately useful.
INSERT INTO backend_pricing
    (name, display_name, kind, currency, storage_price_per_tb_month, is_hot_reference, notes)
VALUES
    ('local-ssd',  'Local SSD',  'hot',     'USD', 80, true,
        'Default hot reference. Overwrite with your real $/TB amortised cost (server + disk + power + rack).'),
    ('local-hdd',  'Local HDD',  'warm',    'USD', 20, false,
        'Local spinning disk amortised cost. Lower than SSD; tiering targets often live here.'),
    ('local',      'Local (unspecified disk)', 'warm', 'USD', 25, false,
        'Catch-all for volumes whose disk_type is empty.')
ON CONFLICT (name) DO NOTHING;

-- Capability seed for the new endpoints. cost.read is broad (anyone
-- can see the dashboard); cost.write gates editing the prices and
-- triggering manual snapshots.
INSERT INTO capabilities (name, category, label, description)
VALUES
    ('cost.read',  'cost', 'View costs',
        'View per-backend cost estimates and savings reports.'),
    ('cost.write', 'cost', 'Manage pricing',
        'Edit backend pricing rows and trigger cost snapshots.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_capabilities (role, capability) VALUES
    ('admin',    'cost.read'),
    ('admin',    'cost.write'),
    ('operator', 'cost.read'),
    ('operator', 'cost.write'),
    ('viewer',   'cost.read')
ON CONFLICT DO NOTHING;
