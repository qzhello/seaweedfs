-- AI failure postmortem.
--
-- When an execution fails, the controller asks the configured LLM to
-- diagnose the log + task context and produce a structured verdict so
-- operators can apply (or override) the recommendation in one click.
--
-- Schema of ai_postmortem JSON:
--   { "verdict":"transient_retry|permanent_abort|needs_human|adjust_and_retry",
--     "confidence":0..1,
--     "root_cause":"<=300 chars",
--     "recommended_action":"<=300 chars",
--     "retry_safe":true|false,
--     "produced_at":"<rfc3339>",
--     "provider":"<provider name>" }
ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS ai_postmortem JSONB;
