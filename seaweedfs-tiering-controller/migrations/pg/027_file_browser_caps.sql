-- Seed file.read / file.write capabilities for the new File Browser page.
-- file.read covers list + download (read-only against the filer);
-- file.write covers upload + mkdir + delete (mutating).
-- Operators get both; viewers and auditors get read-only.

INSERT INTO capabilities (name, category, label, description) VALUES
  ('file.read',  'file', 'Browse files',
   'List directories and download files via the cluster file browser.'),
  ('file.write', 'file', 'Modify files',
   'Upload, delete, and create folders via the cluster file browser.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    'file.read'),
  ('admin',    'file.write'),
  ('operator', 'file.read'),
  ('operator', 'file.write'),
  ('viewer',   'file.read'),
  ('auditor',  'file.read')
ON CONFLICT DO NOTHING;
