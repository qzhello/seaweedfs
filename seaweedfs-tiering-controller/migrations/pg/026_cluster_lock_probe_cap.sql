-- Seed cluster.lock.probe capability so the new /clusters/:id/masters/lock-probe
-- route has a dedicated gate. The probe leases the SeaweedFS admin lock for a
-- single round-trip and releases immediately, so it's a read-shaped check —
-- viewers and auditors can use it too without inheriting any mutating cluster
-- capability.

INSERT INTO capabilities (name, category, label, description) VALUES
  ('cluster.lock.probe', 'cluster', 'Probe cluster admin lock',
   'Lease and immediately release the SeaweedFS admin lock to identify the holder without granting broader write access.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    'cluster.lock.probe'),
  ('operator', 'cluster.lock.probe'),
  ('viewer',   'cluster.lock.probe'),
  ('auditor',  'cluster.lock.probe')
ON CONFLICT DO NOTHING;
