-- Sprint 4-4: post-hoc labeling of AI reviews.
--
-- After a task finishes, we wait observation_hours and ask the access log
-- whether the verdict turned out to be correct. The labeler writes one row
-- per (review, observation window). Multiple windows can coexist (e.g. 24h
-- vs 7d) so trend dashboards can pick the right horizon per question.

CREATE TABLE IF NOT EXISTS ai_review_outcomes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id          UUID NOT NULL REFERENCES ai_reviews(id) ON DELETE CASCADE,
  task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

  -- Window in hours after the task's *finished_at*. NULL execution timestamps
  -- mean the labeler waits — never compute on an in-flight task.
  observation_hours  INT NOT NULL,

  -- Verdict at decision time (denormalized from ai_reviews for query speed).
  verdict            TEXT NOT NULL CHECK (verdict IN ('proceed','abort','needs_human')),
  confidence         REAL,

  -- Was the verdict correct given what we observed afterwards?
  was_correct        BOOLEAN NOT NULL,

  -- Why we labeled this way (human-readable, surfaced in the UI).
  evidence           TEXT NOT NULL DEFAULT '',

  -- Measurable metrics — operators can re-derive `was_correct` if they
  -- decide on a different rule later.
  reads_after        BIGINT,
  bytes_after        BIGINT,
  re_warmed          BOOLEAN,    -- migration target was tier-down → cold but reads spiked
  abort_was_safe     BOOLEAN,    -- abort verdict + volume stayed cold ⇒ safe abort

  business_domain    TEXT,
  provider_name      TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_outcomes
  ON ai_review_outcomes (review_id, observation_hours);
CREATE INDEX IF NOT EXISTS idx_ai_review_outcomes_recent
  ON ai_review_outcomes (created_at DESC);

-- Labeler config keys.
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('ai_review.labeler_enabled', 'ai_review', 'true'::jsonb, 'bool', TRUE, FALSE,
   '是否运行反事实标注后台任务',
   '{"type":"boolean"}'::jsonb,
   '关闭则 AI 准确率指标会停止更新'),
  ('ai_review.labeler_window_hours', 'ai_review', '24'::jsonb, 'int', TRUE, FALSE,
   '执行后等多少小时再回看实际访问量',
   '{"type":"integer","minimum":1,"maximum":720}'::jsonb,
   '太短结论不准;太长冷迁误判会被忽略'),
  ('ai_review.labeler_interval_minutes', 'ai_review', '30'::jsonb, 'int', TRUE, FALSE,
   '反事实标注扫描间隔(分钟)',
   '{"type":"integer","minimum":5,"maximum":1440}'::jsonb,
   ''),
  ('ai_review.rewarm_threshold_reads', 'ai_review', '100'::jsonb, 'int', TRUE, FALSE,
   '观测窗口内读取超过此数视为"被重新加热"(标记 verdict 错误)',
   '{"type":"integer","minimum":1,"maximum":1000000}'::jsonb,
   '阈值越低判错越严格')
ON CONFLICT (key) DO NOTHING;
