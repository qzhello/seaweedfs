-- ============================================================
-- Migration 002 — multi-cluster, RBAC stub, business tags, holidays
-- ============================================================

-- ---------- Users (RBAC stub; v1 only seeds admin) ----------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer', 'auditor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    display     TEXT NOT NULL DEFAULT '',
    role        user_role NOT NULL DEFAULT 'admin',
    api_token   TEXT NOT NULL UNIQUE,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login  TIMESTAMPTZ
);

INSERT INTO users (email, display, role, api_token)
VALUES ('admin@local', 'Admin', 'admin', 'dev-admin-token-change-me')
ON CONFLICT (email) DO NOTHING;

-- ---------- Clusters ----------
CREATE TABLE IF NOT EXISTS clusters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    master_addr     TEXT NOT NULL,         -- "host:9333"
    filer_addr      TEXT NOT NULL DEFAULT '',
    grpc_tls        BOOLEAN NOT NULL DEFAULT FALSE,
    description     TEXT NOT NULL DEFAULT '',
    business_domain TEXT NOT NULL DEFAULT 'other',  -- 主业务域(快速过滤)
    -- 默认对此集群进行迁移操作的安全护栏
    guard           JSONB NOT NULL DEFAULT '{
      "max_concurrent_migrations": 4,
      "max_daily_bytes": 536870912000,
      "min_free_pct_src": 10,
      "min_free_pct_dst": 20,
      "block_during_holiday": true
    }'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Tag taxonomy ----------
-- Two-level: business_domain (required, drives strategy) and data_type (optional).
DO $$ BEGIN
  CREATE TYPE business_domain AS ENUM
    ('flight','train','hotel','car_rental','attraction','logs','finance','backup','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_type AS ENUM
    ('metadata','media','log','report','compliance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A cluster (or specific bucket/collection) carries 0..N tags.
CREATE TABLE IF NOT EXISTS resource_tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('cluster','collection','bucket')),
    scope_value     TEXT NOT NULL DEFAULT '*',
    business_domain business_domain NOT NULL,
    data_type       data_type,
    holiday_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cluster_id, scope_kind, scope_value, business_domain)
);
CREATE INDEX IF NOT EXISTS idx_tags_cluster ON resource_tags(cluster_id);

-- ---------- Holiday calendar (CN) ----------
CREATE TABLE IF NOT EXISTS holiday_calendar (
    date            DATE PRIMARY KEY,
    name            TEXT NOT NULL,           -- 春节 / 国庆 / 清明 ...
    kind            TEXT NOT NULL CHECK (kind IN ('holiday','workday')), -- 调休
    -- 节前/节后 N 天可作为升温/禁迁移窗口
    pre_window_days  INTEGER NOT NULL DEFAULT 0,
    post_window_days INTEGER NOT NULL DEFAULT 0,
    notes           TEXT NOT NULL DEFAULT ''
);

-- 2026 中国法定节假日(按国务院安排,首次发布版本,后续可经 UI 修订)
INSERT INTO holiday_calendar (date, name, kind, pre_window_days, post_window_days) VALUES
  ('2026-01-01','元旦','holiday',3,1),
  ('2026-02-15','春节','holiday',14,7),
  ('2026-02-16','春节','holiday',14,7),
  ('2026-02-17','春节','holiday',14,7),
  ('2026-02-18','春节','holiday',14,7),
  ('2026-02-19','春节','holiday',14,7),
  ('2026-02-20','春节','holiday',14,7),
  ('2026-02-21','春节','holiday',14,7),
  ('2026-04-04','清明','holiday',5,1),
  ('2026-04-05','清明','holiday',5,1),
  ('2026-04-06','清明','holiday',5,1),
  ('2026-05-01','劳动节','holiday',7,2),
  ('2026-05-02','劳动节','holiday',7,2),
  ('2026-05-03','劳动节','holiday',7,2),
  ('2026-05-04','劳动节','holiday',7,2),
  ('2026-05-05','劳动节','holiday',7,2),
  ('2026-06-19','端午','holiday',5,1),
  ('2026-06-20','端午','holiday',5,1),
  ('2026-06-21','端午','holiday',5,1),
  ('2026-09-25','中秋','holiday',5,1),
  ('2026-09-26','中秋','holiday',5,1),
  ('2026-09-27','中秋','holiday',5,1),
  ('2026-10-01','国庆','holiday',14,3),
  ('2026-10-02','国庆','holiday',14,3),
  ('2026-10-03','国庆','holiday',14,3),
  ('2026-10-04','国庆','holiday',14,3),
  ('2026-10-05','国庆','holiday',14,3),
  ('2026-10-06','国庆','holiday',14,3),
  ('2026-10-07','国庆','holiday',14,3),
  ('2026-10-08','国庆','holiday',14,3)
ON CONFLICT (date) DO NOTHING;

-- ---------- Tasks: link to cluster ----------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES clusters(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS business_domain business_domain;
CREATE INDEX IF NOT EXISTS idx_tasks_cluster_domain ON tasks(cluster_id, business_domain);

-- ---------- Hourly node/disk usage snapshot (for water-level chart) ----------
-- Lightweight; ClickHouse holds the heavy access stats. PG is fine for topology snapshots.
CREATE TABLE IF NOT EXISTS node_usage_snapshot (
    snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cluster_id   UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    data_center  TEXT NOT NULL,
    rack         TEXT NOT NULL,
    node         TEXT NOT NULL,
    disk_type    TEXT NOT NULL,
    capacity     BIGINT NOT NULL,
    used         BIGINT NOT NULL,
    volume_count INTEGER NOT NULL,
    PRIMARY KEY (snapshot_at, cluster_id, node, disk_type)
);
CREATE INDEX IF NOT EXISTS idx_node_usage_cluster ON node_usage_snapshot(cluster_id, snapshot_at DESC);
