-- ============================================================
-- Migration 032 — Ops template per-flow alert routing
--
-- Two additions:
--   1. ops_templates.alerts JSONB — per-template channel routing config:
--        {
--          "channel_ids": ["<uuid>", ...],
--          "alert_template_id": "<uuid>" | null,
--          "on_start": false,
--          "on_success": true,
--          "on_failure": true,
--          "on_await_confirm": true,
--          "severity": "warning"        // overrides default per-event sev
--        }
--      NULL = no per-template routing (legacy behaviour).
--
--   2. alert_templates — reusable message templates with Go text/template
--      syntax. Variables exposed at render time:
--        .Template (name), .Cluster, .Status (start|success|failure|await),
--        .RunID, .StepID, .StepIndex, .Error, .When (RFC3339)
-- ============================================================

ALTER TABLE ops_templates
    ADD COLUMN IF NOT EXISTS alerts JSONB DEFAULT NULL;

CREATE TABLE IF NOT EXISTS alert_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    -- Go text/template; rendered with the variable bag described above.
    -- Both fields support markdown — channel adapters strip what they
    -- don't understand. Empty title_tmpl falls back to a synthesised
    -- "[<STATUS>] <Template>" line.
    title_tmpl  TEXT NOT NULL DEFAULT '',
    body_tmpl   TEXT NOT NULL DEFAULT '',
    -- Default severity when the template is used. The ops-template
    -- routing config may override per status (e.g. failures → critical).
    severity    TEXT NOT NULL DEFAULT 'warning'
                CHECK (severity IN ('info','warning','critical')),
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A couple of opinionated defaults so the UI is never blank-screen
-- on first install. Operators can edit or delete freely.
INSERT INTO alert_templates (name, description, title_tmpl, body_tmpl, severity)
VALUES
  ('flow.failure.default',
   'Default body when a flow run fails',
   '[Flow Failed] {{.Template}}',
   E'Cluster: `{{.Cluster}}`\nRun: `{{.RunID}}`\nStep: `{{.StepID}}` (#{{.StepIndex}})\n\nError:\n```\n{{.Error}}\n```',
   'critical'),
  ('flow.success.default',
   'Default body when a flow run succeeds',
   '[Flow OK] {{.Template}}',
   E'Cluster: `{{.Cluster}}`\nRun: `{{.RunID}}`\nFinished at {{.When}}',
   'info'),
  ('flow.await.default',
   'Default body when a flow pauses for human approval',
   '[Awaiting Approval] {{.Template}}',
   E'Cluster: `{{.Cluster}}`\nStep: `{{.StepID}}` (#{{.StepIndex}})\nRun ID: {{.RunID}}\n\nVisit the console to approve or cancel.',
   'warning')
ON CONFLICT (name) DO NOTHING;
