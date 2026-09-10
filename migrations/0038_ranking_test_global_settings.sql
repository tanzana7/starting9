PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ranking_test_global_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
  slot_names_json TEXT NOT NULL DEFAULT '{}' CHECK (length(slot_names_json) <= 8192),
  updated_by TEXT NOT NULL CHECK (length(updated_by) <= 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
