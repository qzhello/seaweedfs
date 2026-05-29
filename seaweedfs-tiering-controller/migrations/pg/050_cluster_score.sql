-- Per-cluster durability score history (time series).
--
-- Populated by the durability sampler every durability.sample_interval_seconds
-- (default 300 s). The frontend reads /clusters/score/history to render a
-- sparkline showing durability trends over the last 1d / 7d / 30d.

CREATE TABLE IF NOT EXISTS cluster_score_signals (
  cluster_id   UUID             NOT NULL,
  snapshot_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  -- 0..100 durability score. 100 = all volumes perfectly replicated.
  score        DOUBLE PRECISION NOT NULL,
  -- Raw counts that contributed to the score (sole_copies, under_replicated,
  -- ec_potentially_short_shards, over_replicated, total_volumes, …) stored
  -- for transparency + UI tooltip.
  components   JSONB            NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (cluster_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_score_cluster_at
  ON cluster_score_signals(cluster_id, snapshot_at DESC);

-- Sampling interval knob, surfaced in /settings:
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('durability.sample_interval_seconds', 'durability', '300'::jsonb, 'float', TRUE, FALSE,
   '耐久性分数采样间隔(秒)。',
   '{"type":"number","minimum":30,"maximum":3600}'::jsonb,
   '过短增加拓扑遍历负载,过长趋势迟钝。')
ON CONFLICT (key) DO NOTHING;
