-- Per-deployment LLM response language for AI safety review.
-- Affects only the natural-language fields (`reasoning`, factor `note`); the
-- JSON keys + verdict values stay English so the parser/UI stay locale-stable.
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('aireview.lang', 'aireview', '"zh"'::jsonb, 'string', TRUE, FALSE,
   'AI 评审 reasoning/note 输出语言:zh(简体中文) / en(English)。键名与 verdict 始终为英文。',
   '{"type":"string","enum":["zh","en"]}'::jsonb,
   '影响多轮评审中模型自由文本字段的语言;不影响投票/聚合逻辑。')
ON CONFLICT (key) DO NOTHING;
