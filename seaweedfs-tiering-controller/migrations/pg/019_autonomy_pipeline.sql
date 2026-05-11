-- Autonomy pipeline + per-task score.
--
-- The pipeline runner (internal/autonomy) executes a configurable sequence
-- of decision stages for every task, and records one row per stage so the
-- operator can audit "why did AI auto-run this?" or "why did it stall?".
--
-- autonomy_score JSON on tasks:
--   {
--     "total": 0.83,
--     "threshold": 0.75,
--     "verdict": "auto_proceed" | "needs_human" | "blocked",
--     "factors": {
--       "risk_level":     {"raw":"low",   "value":1.0, "weight":0.30, "weighted":0.30},
--       "blast_radius":   {"raw":83886080,"value":0.98,"weight":0.20, "weighted":0.196},
--       "cluster_pressure":{"raw":0.15,   "value":0.85,"weight":0.20, "weighted":0.17},
--       "change_window":  {"raw":"off_peak","value":1.0,"weight":0.10,"weighted":0.10},
--       "ai_consensus":   {"raw":"proceed×3", "value":0.92,"weight":0.20,"weighted":0.184}
--     },
--     "computed_at": "<rfc3339>"
--   }

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS autonomy_score JSONB;

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id UUID,                                  -- nullable; filled once execute stage runs
  stage        TEXT        NOT NULL,                  -- compute_autonomy | auto_gate | human_review | pressure_wait | pre_execute_check | execute | post_review
  decision     TEXT        NOT NULL,                  -- pass | fail | skip | defer | needs_human | error
  evidence     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason       TEXT        NOT NULL DEFAULT '',
  duration_ms INT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task     ON pipeline_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_exec     ON pipeline_runs(execution_id) WHERE execution_id IS NOT NULL;

-- Knobs ----------------------------------------------------------------------

INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('autonomy.enabled', 'autonomy', 'true'::jsonb, 'bool', TRUE, FALSE,
   'AI 自治流程是否启用。关闭后所有任务退化为人工 approve。',
   '{"type":"boolean"}'::jsonb,
   '关闭可临时禁用 AI 自动执行,所有任务需要人工 approve。'),

  ('autonomy.threshold', 'autonomy', '0.75'::jsonb, 'float', TRUE, FALSE,
   '自治分阈值,>= 该值的任务自动 approve。',
   '{"type":"number","minimum":0,"maximum":1}'::jsonb,
   '越高越保守(更多任务转人工),越低越激进。'),

  ('autonomy.weights', 'autonomy',
   '{"risk_level":0.30,"blast_radius":0.20,"cluster_pressure":0.20,"change_window":0.10,"ai_consensus":0.20}'::jsonb,
   'json', TRUE, FALSE,
   '5 因子加权:risk_level + blast_radius + cluster_pressure + change_window + ai_consensus。和应≈1。',
   '{"type":"object","additionalProperties":{"type":"number","minimum":0,"maximum":1}}'::jsonb,
   '调权重可让某因子更/不重要;某因子置 0 等于忽略。'),

  ('autonomy.pre_execute_check', 'autonomy', 'true'::jsonb, 'bool', TRUE, FALSE,
   '执行前再让 AI 看一眼最新上下文(压力 / 健康 / 集群状态),拒绝则任务转 needs_human。',
   '{"type":"boolean"}'::jsonb,
   '默认开启;额外一次 AI 调用,可拦下因环境变化不再适合执行的任务。'),

  ('autonomy.high_risk_skills', 'autonomy',
   '["ec_encode","collection_move","delete_replica"]'::jsonb,
   'json', TRUE, FALSE,
   '强制人工 approve 的高风险 skill 列表。即使 autonomy_score 过线也不自动跑。',
   '{"type":"array","items":{"type":"string"}}'::jsonb,
   '兜底安全闸,防止 AI 在高破坏性操作上失误。'),

  ('autonomy.blast_radius_bytes_full', 'autonomy', '107374182400'::jsonb, 'int', TRUE, FALSE,
   '影响数据量达到此值视为「满影响」(blast_radius 因子=0)。默认 100 GiB。',
   '{"type":"integer","minimum":1048576}'::jsonb,
   '小集群应调低(如 10 GiB),大集群可调高。')
ON CONFLICT (key) DO NOTHING;
