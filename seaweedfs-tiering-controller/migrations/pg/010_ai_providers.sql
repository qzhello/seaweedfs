-- Sprint 4-1: real credential management for AI providers.
--
-- The original 001 migration carried only `secret_ref` (env var name). This
-- migration adds AES-GCM encrypted credentials so operators can paste API keys
-- into the Web Console without exporting them as env vars on the host.
--
-- Encryption uses TIER_MASTER_KEY (32-byte hex) loaded by internal/crypto;
-- the same key already protects storage_backends.secret_enc.

ALTER TABLE ai_providers
  -- Drop the old enum and rebuild — supports more vendors now.
  DROP CONSTRAINT IF EXISTS ai_providers_kind_check;

ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_kind_check
  CHECK (kind IN ('openai','anthropic','deepseek','openai_compatible','ollama','rule'));

-- Encrypted API key (AES-256-GCM, nonce||ciphertext blob). NULL means
-- "use secret_ref env var" (backwards compatible with 001).
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS secret_enc BYTEA;

-- Connection test telemetry — surfaced on the /ai-config page.
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS last_test_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_test_ok      BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_test_error   TEXT,
  ADD COLUMN IF NOT EXISTS last_test_latency_ms INT;

-- Track when the provider was last actually called by the controller; used to
-- highlight stale credentials.
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Updated-at for cache invalidation by the runtime resolver.
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Notify on change so the controller can hot-reload provider selection
-- without a restart (mirrors system_config NOTIFY).
CREATE OR REPLACE FUNCTION notify_ai_provider_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('ai_provider_changed', COALESCE(NEW.id::text, OLD.id::text));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_provider_change ON ai_providers;
CREATE TRIGGER trg_ai_provider_change
  AFTER INSERT OR UPDATE OR DELETE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION notify_ai_provider_change();

-- One default at a time. A partial unique index lets us enforce this without
-- forcing every row to participate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_providers_one_default
  ON ai_providers ((1)) WHERE is_default = TRUE;
