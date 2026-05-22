-- Per-template toggle for the pre-execution AI safety advisor.
-- When TRUE, the interactive runner asks the LLM to comment on each
-- mutating step (risk / watch_out / rollback) before the operator
-- approves. Pure advisory — never blocks. Operators can also trigger
-- the same check manually from the approval card even when the
-- template-level toggle is off.
--
-- Defaults to TRUE: safer to nag than to silently skip advice on
-- destructive runs.
ALTER TABLE ops_templates
    ADD COLUMN IF NOT EXISTS ai_precheck BOOLEAN NOT NULL DEFAULT TRUE;
