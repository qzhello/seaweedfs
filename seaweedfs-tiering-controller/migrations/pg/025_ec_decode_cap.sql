-- Add volume.ec.decode capability for the EC rollback path (ec.decode).
-- Encoding and decoding are distinct operations so they get distinct caps,
-- letting admins grant encode without granting the destructive rollback.

INSERT INTO capabilities (name, category, label, description) VALUES
  ('volume.ec.decode',  'volume', 'EC decode (rollback)', 'Convert EC volumes back to normal volumes.'),
  ('volume.ec.balance', 'volume', 'EC balance (apply)',   'Run ec.balance with -apply to move shards across nodes.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

-- Operators get the EC maintenance caps by default — same tier that already
-- has encode + rebuild.
INSERT INTO role_capabilities (role, capability) VALUES
  ('operator', 'volume.ec.decode'),
  ('operator', 'volume.ec.balance')
ON CONFLICT DO NOTHING;
