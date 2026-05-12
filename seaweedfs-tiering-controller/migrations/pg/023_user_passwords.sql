-- ============================================================
-- Migration 023 — email + password auth
--
-- Replaces the "paste an API token" login flow with standard
-- email/password. Tokens remain valid for API clients (SDKs, CI),
-- but humans go through /auth/login to trade credentials for one.
--
-- The seed admin keeps a well-known default password ("admin") and
-- is forced to rotate it on first login via must_reset_password.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at      TIMESTAMPTZ;

-- The seed admin's password_hash stays NULL after this migration.
-- The controller's startup hook generates a bcrypt hash for the
-- well-known default ("admin") whenever it sees admin@local with a
-- NULL hash — this keeps the password truly default-on-first-boot
-- without pinning a bcrypt salt that's hard to verify by hand.
-- must_reset_password defaults to TRUE so the operator is forced to
-- rotate before doing anything else.
