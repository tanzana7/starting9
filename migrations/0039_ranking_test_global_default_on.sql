PRAGMA foreign_keys = ON;

-- Seed the new default only when the singleton has never been written.
-- An existing row, including an explicit admin OFF, is authoritative.
INSERT INTO ranking_test_global_settings
  (id, global_enabled, slot_names_json, updated_by, created_at, updated_at)
VALUES (
  1,
  1,
  '{}',
  'migration:0039_default_on',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(id) DO NOTHING;
