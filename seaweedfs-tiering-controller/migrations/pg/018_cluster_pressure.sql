-- Cluster pressure signals + scheduling knobs.
--
-- A per-cluster time series of "how busy is this cluster right now". The
-- scheduler uses the latest snapshot to decide whether to admit a fresh
-- task or hold it in 'scheduled' state until pressure drops. The watchdog
-- (Phase C) also reads this to abort in-flight ops that overrun threshold.

CREATE TABLE IF NOT EXISTS cluster_pressure_signals (
  cluster_id     UUID        NOT NULL,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Normalized 0..1 pressure score. Above pressure.threshold means "busy".
  pressure_score DOUBLE PRECISION NOT NULL,
  -- Raw component values (cpu_p95, disk_util_p95, io_wait, custom) for
  -- transparency + UI tooltip.
  components     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (cluster_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_pressure_cluster_at
  ON cluster_pressure_signals(cluster_id, snapshot_at DESC);

-- Trim history so it doesn't bloat: keep last 30 days. Run as a daily cron
-- job from the controller (or rely on operators).
-- DELETE FROM cluster_pressure_signals WHERE snapshot_at < NOW() - INTERVAL '30 days';

-- Knobs surfaced in /settings UI:
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('pressure.threshold', 'pressure', '0.6'::jsonb, 'float', TRUE, FALSE,
   '集群压力上限(0-1)。高于此值的集群暂不接收新执行任务,任务停在 scheduled 状态等待。',
   '{"type":"number","minimum":0,"maximum":1}'::jsonb,
   '影响调度延迟分布;过低易饿死任务,过高失去保护效果。'),
  ('pressure.sample_interval_seconds', 'pressure', '30'::jsonb, 'float', TRUE, FALSE,
   '压力采样间隔(秒)。',
   '{"type":"number","minimum":10,"maximum":600}'::jsonb,
   '过短增加 Prometheus 负载,过长反应迟钝。'),
  ('pressure.weights', 'pressure', '{"cpu_p95":0.4,"disk_util_p95":0.4,"io_wait":0.2}'::jsonb,
   'json', TRUE, FALSE,
   '压力评分权重。键名必须存在于 monitor_targets.name(或 pressure 子串匹配)。',
   '{"type":"object","additionalProperties":{"type":"number","minimum":0,"maximum":1}}'::jsonb,
   '权重决定哪类指标对压力评分贡献更大。'),
  ('pressure.watchdog_enabled', 'pressure', 'true'::jsonb, 'bool', TRUE, FALSE,
   '运行中熔断(Phase C)是否启用。压力持续高于阈值时中断 interruptible=true 的任务。',
   '{"type":"boolean"}'::jsonb,
   '关闭可避免误杀长任务;开启可保护集群免于过载。')
ON CONFLICT (key) DO NOTHING;

-- Allow new 'scheduled' task status (gating between approved and running).
-- The existing tasks table has no CHECK constraint on status, so just
-- document the new state here.
COMMENT ON COLUMN tasks.status IS
  'pending | approved | scheduled | running | succeeded | failed | rolled_back | cancelled. ''scheduled'' = approved but waiting for cluster pressure to drop below pressure.threshold.';
