PRAGMA foreign_keys = ON;

-- Admin-only Web Push registrations.  The endpoint is an opaque browser
-- capability, so it is never exposed by public API responses.
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT NULL,
  last_error_code TEXT NULL,
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subscriptions_admin_active
  ON admin_push_subscriptions(admin_user_id, disabled_at, updated_at DESC);

-- One active incident per dedupe key.  Resolved rows remain as history and
-- allow the same condition to create a fresh incident later.
CREATE TABLE IF NOT EXISTS admin_alert_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  last_notified_at TEXT NULL,
  notification_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NULL,
  UNIQUE (dedupe_key, status)
);

CREATE INDEX IF NOT EXISTS idx_admin_alert_incidents_active_game
  ON admin_alert_incidents(internal_game_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_alert_incidents_recent
  ON admin_alert_incidents(status, last_seen_at DESC);
