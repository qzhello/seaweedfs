-- ============================================================
-- Migration 003 — Configuration Center
-- All runtime-tunable settings live here. config.yaml is only the
-- bootstrap seed; once a key exists in PG, the file is ignored for
-- that key on subsequent restarts.
-- ============================================================

-- Hot vs cold:
--   hot  = picked up by an in-memory snapshot listener within seconds
--   cold = applied only on next controller restart
-- Sensitive flag hides the value in API responses (rendered as "***").
CREATE TABLE IF NOT EXISTS system_config (
    key            TEXT PRIMARY KEY,
    group_name     TEXT NOT NULL,                   -- "scoring" | "scheduler" | "executor" | "ai" | "alerts" | ...
    value          JSONB NOT NULL,
    value_type     TEXT NOT NULL CHECK (value_type IN ('string','int','float','bool','json','duration','cron')),
    is_hot         BOOLEAN NOT NULL DEFAULT TRUE,
    is_sensitive   BOOLEAN NOT NULL DEFAULT FALSE,
    description    TEXT NOT NULL DEFAULT '',
    schema         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- jsonschema for validation
    impact         TEXT NOT NULL DEFAULT '',             -- human-readable impact ("Affects all running tasks")
    updated_by     TEXT NOT NULL DEFAULT 'system',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_config_group ON system_config(group_name);

-- Version history for diff/rollback
CREATE TABLE IF NOT EXISTS config_history (
    id           BIGSERIAL PRIMARY KEY,
    key          TEXT NOT NULL,
    old_value    JSONB,
    new_value    JSONB NOT NULL,
    version      INTEGER NOT NULL,
    changed_by   TEXT NOT NULL,
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_config_history_key ON config_history(key, changed_at DESC);

-- NOTIFY trigger: emits 'config_changed' channel with the key.
-- The controller listens and refreshes its in-memory snapshot on receipt.
CREATE OR REPLACE FUNCTION notify_config_change() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('config_changed', NEW.key);
    INSERT INTO config_history (key, old_value, new_value, version, changed_by, note)
    VALUES (NEW.key,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
            NEW.value, NEW.version, NEW.updated_by, '');
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_config_change ON system_config;
CREATE TRIGGER trg_config_change
AFTER INSERT OR UPDATE ON system_config
FOR EACH ROW EXECUTE FUNCTION notify_config_change();

-- ---------- Seed defaults (idempotent) ----------
INSERT INTO system_config (key, group_name, value, value_type, is_hot, description, impact, schema) VALUES
  -- Scoring weights (hot, no restart)
  ('scoring.weights.last_access_decay', 'scoring', '0.40', 'float', TRUE,
    '最近访问衰减权重 (越大 → 越看重最后访问时间)',
    'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.weights.access_count_30d', 'scoring', '0.25', 'float', TRUE,
    '30 天访问次数权重',
    'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.weights.object_size', 'scoring', '0.10', 'float', TRUE,
    '体积权重',
    'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.weights.is_readonly', 'scoring', '0.15', 'float', TRUE,
    '只读权重',
    'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.weights.quiet_for_days', 'scoring', '0.10', 'float', TRUE,
    '安静天数权重',
    'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),

  ('scoring.thresholds.to_ec', 'scoring', '0.55', 'float', TRUE,
    'EC 编码阈值', 'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.thresholds.to_cloud', 'scoring', '0.75', 'float', TRUE,
    '云冷存阈值', 'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),
  ('scoring.thresholds.to_archive', 'scoring', '0.90', 'float', TRUE,
    '归档阈值', 'New scoring runs only',
    '{"type":"number","minimum":0,"maximum":1}'),

  -- Scheduler (hot for cron change requires re-register)
  ('scheduler.enabled', 'scheduler', 'true', 'bool', TRUE,
    '是否开启调度器', 'Pauses or resumes all auto-scoring/execution', '{"type":"boolean"}'),
  ('scheduler.scoring_cron', 'scheduler', '"0 * * * *"', 'cron', FALSE,
    '评分定时表达式', 'Requires controller restart to re-register', '{"type":"string"}'),
  ('scheduler.execution_cron', 'scheduler', '"*/15 * * * *"', 'cron', FALSE,
    '执行定时表达式', 'Requires controller restart', '{"type":"string"}'),
  ('scheduler.cooldown_days', 'scheduler', '14', 'int', TRUE,
    '同 volume 二次迁移最短间隔(天)', 'Affects new scoring decisions', '{"type":"integer","minimum":0}'),
  ('scheduler.dry_run_global', 'scheduler', 'false', 'bool', TRUE,
    '全局演练模式 (不真正执行)', 'When ON, executor is bypassed', '{"type":"boolean"}'),

  -- Executor
  ('executor.parallel_limit', 'executor', '4', 'int', TRUE,
    '并发执行任务上限', 'Lowering may pause running tasks', '{"type":"integer","minimum":1,"maximum":64}'),
  ('executor.retain_local_dat', 'executor', 'true', 'bool', TRUE,
    'tier.upload 后保留本地 dat 一周(便于回滚)', 'Newly created tasks only', '{"type":"boolean"}'),
  ('executor.bandwidth_mbps', 'executor', '500', 'int', TRUE,
    '迁移带宽上限 (MiB/s, 全局)', 'Token bucket caps egress', '{"type":"integer","minimum":1}'),
  ('executor.start_per_minute', 'executor', '10', 'int', TRUE,
    '每分钟最多启动新任务数', 'Stagger to avoid network spikes', '{"type":"integer","minimum":1}'),

  -- AI provider
  ('ai.provider', 'ai', '"rule"', 'string', FALSE,
    '当前 AI provider (rule|openai|anthropic)', 'Restart required',
    '{"type":"string","enum":["rule","openai","anthropic"]}'),
  ('ai.request_timeout', 'ai', '"30s"', 'duration', TRUE,
    'AI 调用超时', 'Affects new AI calls', '{"type":"string"}'),
  ('ai.max_concurrency', 'ai', '4', 'int', TRUE,
    'AI 并发上限', 'Affects in-flight AI calls', '{"type":"integer","minimum":1}'),

  -- Safety / guards
  ('safety.emergency_stop', 'safety', 'false', 'bool', TRUE,
    '紧急刹车: 全局停止所有迁移', '🔴 IMMEDIATELY pauses all auto migrations',
    '{"type":"boolean"}'),
  ('safety.change_window', 'safety',
    '{"enabled":false,"start_hour":1,"end_hour":6,"weekdays_only":false}',
    'json', TRUE,
    '变更窗口: 仅在指定时段允许执行', 'Tasks queue outside window',
    '{"type":"object"}')
ON CONFLICT (key) DO NOTHING;
