PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK (
    length(code) BETWEEN 3 AND 64
    AND substr(code, 1, 1) GLOB '[a-z]'
    AND code NOT GLOB '*[^a-z0-9_]*'
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon_key TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'limited')),
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('system', 'admin', 'development', 'migration')),
  metadata_json TEXT NULL CHECK (metadata_json IS NULL OR length(metadata_json) <= 4096),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, achievement_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user_earned
  ON user_achievements(user_id, earned_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_achievements_achievement
  ON user_achievements(achievement_id);

INSERT OR IGNORE INTO achievements
  (id, code, name, description, icon_key, rarity, is_hidden, created_at, updated_at)
VALUES
  ('achievement_beta_predictor', 'beta_predictor', 'ベータテスター', 'Starting9のベータ期間中に予想へ参加した証', 'beta', 'limited', 0, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'),
  ('achievement_first_prediction', 'first_prediction', '初予想', '初めてスタメン予想を保存した', 'first_prediction', 'common', 0, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'),
  ('achievement_perfect_prediction', 'perfect_prediction', 'パーフェクト', 'スタメン予想で満点を達成した', 'perfect', 'rare', 0, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
