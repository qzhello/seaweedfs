-- Sprint 5 hook: controller role placeholder.
--
-- v1 ships as 'single' (one controller). When HA lands (Sprint 5-1), the
-- value is set per-process via env var or config and read here as the
-- authoritative source for /healthz + UI badges.
INSERT INTO system_config (key, group_name, value, value_type, is_hot, is_sensitive, description, schema, impact)
VALUES
  ('controller.role', 'cluster', '"single"'::jsonb, 'string', TRUE, FALSE,
   '当前 controller 角色:single(单实例,默认) / leader / standby / shadow',
   '{"type":"string","enum":["single","leader","standby","shadow"]}'::jsonb,
   '影响 /healthz 输出 + 后续 HA 选举(Sprint 5-1 接入)')
ON CONFLICT (key) DO NOTHING;
