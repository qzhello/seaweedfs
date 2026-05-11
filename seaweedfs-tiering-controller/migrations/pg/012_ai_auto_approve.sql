-- Sprint 4-3: AI verdict-driven auto-approve.
--
-- Three system_config keys gate the behavior. Defaults are conservative:
-- auto_approve disabled, threshold high, minimum risk_level only.
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('ai_review.auto_approve_enabled', 'ai_review', 'false'::jsonb, 'bool', TRUE, FALSE,
   '是否允许 AI 评审通过后自动 approve 任务',
   '{"type":"boolean"}'::jsonb,
   '影响所有 pending 任务的 approve 路径'),
  ('ai_review.min_confidence', 'ai_review', '0.85'::jsonb, 'float', TRUE, FALSE,
   '自动 approve 的最低聚合置信度 (0..1)',
   '{"type":"number","minimum":0,"maximum":1}'::jsonb,
   '阈值越低,自动 approve 越激进'),
  ('ai_review.max_risk_level', 'ai_review', '"medium"'::jsonb, 'string', TRUE, FALSE,
   '允许自动 approve 的 Skill 最大 risk_level (low/medium;high/critical 始终需要人工)',
   '{"type":"string","enum":["low","medium"]}'::jsonb,
   'high/critical 风险的 Skill 永远要人工 approve'),
  ('ai_review.worker_interval_seconds', 'ai_review', '60'::jsonb, 'int', TRUE, FALSE,
   '后台 worker 扫描 pending 任务的间隔(秒)',
   '{"type":"integer","minimum":10,"maximum":3600}'::jsonb,
   '太短会浪费 AI 调用配额;太长则任务积压'),
  ('ai_review.max_per_tick', 'ai_review', '5'::jsonb, 'int', TRUE, FALSE,
   '单次扫描最多评审多少个 pending 任务,防止积压时一次性 burn AI 配额',
   '{"type":"integer","minimum":1,"maximum":100}'::jsonb,
   '配额防护')
ON CONFLICT (key) DO NOTHING;

-- Reuse existing audit_log to record auto-approve decisions; no new table.
