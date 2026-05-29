-- Seed cluster.raft.transfer capability for the new
-- /clusters/:id/masters/transfer-leader route. This is a MUTATING raft
-- operation (it triggers a brief leader re-election), so only admin and
-- operator get it — viewers and auditors do not.

INSERT INTO capabilities (name, category, label, description) VALUES
  ('cluster.raft.transfer', 'cluster', 'Transfer raft leadership',
   'Gracefully transfer SeaweedFS master raft leadership to another master (auto or a chosen target), typically before maintaining the current leader.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    'cluster.raft.transfer'),
  ('operator', 'cluster.raft.transfer')
ON CONFLICT DO NOTHING;
