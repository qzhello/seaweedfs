-- ============================================================
-- Migration 022 — capability-based RBAC
--
-- Replaces the coarse 4-role gate with a flat capability string
-- model. Each feature/page declares a capability name; roles are
-- mapped to capabilities through `role_capabilities`. The wildcard
-- "*" capability grants everything (admin default).
-- ============================================================

CREATE TABLE IF NOT EXISTS capabilities (
    name        TEXT PRIMARY KEY,                 -- e.g. "volume.balance"
    category    TEXT NOT NULL DEFAULT 'misc',     -- "volume" | "cluster" | "s3" | "ops" | "ai" | "system"
    label       TEXT NOT NULL DEFAULT '',         -- short human label
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_capabilities (
    role       user_role NOT NULL,
    capability TEXT      NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
    PRIMARY KEY (role, capability)
);

-- ---------- Seed the curated capability catalog ----------
-- IMPORTANT: capability names are stable identifiers. Renaming
-- requires a data migration; prefer adding new caps and deprecating
-- old ones (drop role_capabilities row, then drop the cap).

INSERT INTO capabilities (name, category, label, description) VALUES
  -- Wildcard
  ('*',                          'system',  'All capabilities',         'Grants every capability. Reserved for admin.'),

  -- Volume operations
  ('volume.read',                'volume',  'View volumes',             'Read volume list, distribution, and metadata.'),
  ('volume.balance',             'volume',  'Run volume balance',       'Rebalance volume placement across nodes.'),
  ('volume.grow',                'volume',  'Grow volumes',             'Pre-allocate new volumes for a collection.'),
  ('volume.delete-empty',        'volume',  'Delete empty volumes',     'Remove size=0 volumes.'),
  ('volume.shrink',              'volume',  'Shrink volumes',           'Reclaim unused pre-allocated space.'),
  ('volume.move',                'volume',  'Move volume replicas',     'Migrate a single replica between nodes.'),
  ('volume.mark',                'volume',  'Mark volume readonly/writable', 'Toggle volume read-only state.'),
  ('volume.fix-replication',     'volume',  'Fix replication',          'Restore replicas to the configured count.'),
  ('volume.vacuum',              'volume',  'Vacuum volumes',           'Reclaim soft-deleted needle space.'),
  ('volume.check-disk',          'volume',  'Per-volume disk check',    'Run on-disk integrity scan for a volume.'),
  ('volume.fsck',                'volume',  'Full fsck',                'Run cluster-wide volume fsck.'),
  ('volume.ec.encode',           'volume',  'EC encode',                'Convert warm volumes to EC shards.'),
  ('volume.ec.rebuild',          'volume',  'EC rebuild',               'Rebuild missing EC shards.'),

  -- Cluster operations
  ('cluster.read',               'cluster', 'View clusters',            'Read cluster list, topology, and health.'),
  ('cluster.write',              'cluster', 'Manage clusters',          'Create/update/delete cluster records.'),
  ('cluster.replication.configure','cluster','Configure replication',   'Change replication strategy for a cluster.'),
  ('cluster.volume-server.leave','cluster', 'Drain a volume server',    'Mark a volume server for graceful leave.'),
  ('cluster.check',              'cluster', 'Cluster health check',     'Reachability checks against masters/volume servers/filers.'),

  -- S3
  ('s3.read',                    's3',      'View S3 resources',        'List buckets and their settings.'),
  ('s3.configure',               's3',      'Configure S3',             'Edit global S3 configuration (CORS, policies, anonymous, domain).'),
  ('s3.bucket.create',           's3',      'Create bucket',            'Create a new S3 bucket.'),
  ('s3.bucket.delete',           's3',      'Delete bucket',            'Delete a bucket and its objects.'),
  ('s3.bucket.owner',            's3',      'Change bucket owner',      'Reassign bucket ownership.'),
  ('s3.bucket.quota',            's3',      'Set bucket quota',         'Read or modify a bucket''s storage quota.'),
  ('s3.bucket.quota.enforce',    's3',      'Toggle quota enforcement', 'Enable/disable hard enforcement of bucket quotas.'),
  ('s3.circuit-breaker',         's3',      'Configure circuit breaker','Edit S3 circuit-breaker thresholds.'),
  ('s3.clean-uploads',           's3',      'Clean multipart uploads',  'Abort stale incomplete multipart uploads.'),

  -- Ops console / templates
  ('ops.shell.read',             'ops',     'Read-only shell commands', 'Run weed shell commands marked read-only.'),
  ('ops.shell.mutate',           'ops',     'Mutating shell commands',  'Run weed shell commands that modify state.'),
  ('ops.shell.destructive',      'ops',     'Destructive shell commands','Run weed shell commands marked destructive.'),
  ('ops.templates.read',         'ops',     'View ops templates',       'Browse and run saved ops templates.'),
  ('ops.templates.write',        'ops',     'Manage ops templates',     'Create/edit/delete ops templates.'),

  -- AI
  ('ai.config',                  'ai',      'AI config',                'View and edit AI provider settings.'),
  ('ai.learning',                'ai',      'AI learning',              'View AI learning insights.'),

  -- Settings / system
  ('settings.read',              'system',  'View settings',            'Read system settings.'),
  ('settings.write',             'system',  'Edit settings',            'Edit system settings.'),
  ('permissions.write',          'system',  'Manage permissions',       'Assign capabilities to roles.'),
  ('audit.read',                 'system',  'Read audit log',           'View audit entries.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

-- ---------- Default role → capability mapping ----------
-- admin: wildcard
-- operator: everything except destructive S3 and permissions admin
-- viewer: read-only
-- auditor: read-only + audit log
INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    '*'),

  ('operator', 'volume.read'),
  ('operator', 'volume.balance'),
  ('operator', 'volume.grow'),
  ('operator', 'volume.delete-empty'),
  ('operator', 'volume.shrink'),
  ('operator', 'volume.move'),
  ('operator', 'volume.mark'),
  ('operator', 'volume.fix-replication'),
  ('operator', 'volume.vacuum'),
  ('operator', 'volume.check-disk'),
  ('operator', 'volume.fsck'),
  ('operator', 'volume.ec.encode'),
  ('operator', 'volume.ec.rebuild'),
  ('operator', 'cluster.read'),
  ('operator', 'cluster.check'),
  ('operator', 'cluster.replication.configure'),
  ('operator', 'cluster.volume-server.leave'),
  ('operator', 's3.read'),
  ('operator', 's3.bucket.create'),
  ('operator', 's3.bucket.quota'),
  ('operator', 's3.bucket.quota.enforce'),
  ('operator', 's3.circuit-breaker'),
  ('operator', 's3.clean-uploads'),
  ('operator', 'ops.shell.read'),
  ('operator', 'ops.shell.mutate'),
  ('operator', 'ops.templates.read'),
  ('operator', 'ops.templates.write'),
  ('operator', 'settings.read'),

  ('viewer',   'volume.read'),
  ('viewer',   'cluster.read'),
  ('viewer',   's3.read'),
  ('viewer',   'ops.shell.read'),
  ('viewer',   'ops.templates.read'),
  ('viewer',   'settings.read'),

  ('auditor',  'volume.read'),
  ('auditor',  'cluster.read'),
  ('auditor',  's3.read'),
  ('auditor',  'ops.shell.read'),
  ('auditor',  'ops.templates.read'),
  ('auditor',  'settings.read'),
  ('auditor',  'audit.read')
ON CONFLICT (role, capability) DO NOTHING;
