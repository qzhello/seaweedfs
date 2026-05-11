-- ============================================================
-- Migration 004 — Remote storage backends (S3 / OSS / OBS / COS / MinIO)
-- Credentials are stored as AES-GCM ciphertext (column `secret_enc`).
-- Master key comes from env TIER_MASTER_KEY (32 bytes hex). If unset,
-- backends with secrets cannot be created — the API will refuse.
-- ============================================================

CREATE TABLE IF NOT EXISTS storage_backends (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL CHECK (kind IN ('s3','oss','obs','cos','minio')),
    endpoint        TEXT NOT NULL,
    region          TEXT NOT NULL DEFAULT '',
    bucket          TEXT NOT NULL,
    path_prefix     TEXT NOT NULL DEFAULT '',
    access_key_id   TEXT NOT NULL DEFAULT '',
    -- AES-GCM(secret_access_key); nil if unset.
    secret_enc      BYTEA,
    encryption      TEXT NOT NULL DEFAULT '' CHECK (encryption IN ('','sse-s3','sse-kms','aes256')),
    force_path_style BOOLEAN NOT NULL DEFAULT FALSE,
    notes           TEXT NOT NULL DEFAULT '',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    -- Last connection-test result, surfaced in the UI.
    last_test_at    TIMESTAMPTZ,
    last_test_ok    BOOLEAN,
    last_test_error TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_backends_kind ON storage_backends(kind);

-- A bucket-quota / TTL per backend, because cold tier costs vary.
CREATE TABLE IF NOT EXISTS backend_limits (
    backend_id      UUID PRIMARY KEY REFERENCES storage_backends(id) ON DELETE CASCADE,
    max_bytes       BIGINT NOT NULL DEFAULT 0,           -- 0 = unlimited
    object_ttl_days INTEGER NOT NULL DEFAULT 0,          -- 0 = never expire
    notes           TEXT NOT NULL DEFAULT ''
);
