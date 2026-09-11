PRAGMA foreign_keys = ON;

-- 0038 introduced the singleton with an OFF default. This one-time migration
-- promotes that legacy value to the new default. Later admin/API writes are
-- authoritative; no runtime path should repeat this update.
UPDATE ranking_test_global_settings
   SET global_enabled = 1,
       updated_by = 'migration:0040_enable_existing_default',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 1
   AND global_enabled = 0;
