-- Ops templates are operator-saved sequences of weed shell commands.
-- Lighter than Skills (no review workflow, no risk gating, no autonomy
-- scoring) — meant for ad-hoc playbooks the operator wants to reuse:
-- "create-bucket-then-quota", "drain-and-decommission", etc.
--
-- steps is a JSON array of objects:
--   [{command:"s3.bucket.create", args:"-name=foo", reason:"new tenant",
--     pause_on_error:true}, ...]
-- The shape matches the /shell payload + a couple of orchestration flags.
-- We keep it as jsonb (not a side table) because templates are tiny and
-- always loaded/saved as a unit; per-step querying isn't a real use case.
CREATE TABLE IF NOT EXISTS ops_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'general',
    steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- created_by/updated_by are emails copied off the request principal at
    -- write time. We don't FK to users because templates outlive disabled
    -- accounts and we want the byline preserved for audit.
    created_by  TEXT NOT NULL DEFAULT '',
    updated_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_templates_name_uq ON ops_templates (LOWER(name));
CREATE INDEX IF NOT EXISTS ops_templates_category_idx ON ops_templates (category);
