PRAGMA foreign_keys = ON;

-- 管理者が本番フローを確認するための試合定義です。通常の日程同期・Cron対象には含めません。
CREATE TABLE IF NOT EXISTS test_games (
  game_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  game_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  prediction_deadline_at TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  venue TEXT NULL,
  roster_json TEXT NOT NULL DEFAULT '[]' CHECK (length(roster_json) <= 65536),
  probable_starter_json TEXT NULL CHECK (probable_starter_json IS NULL OR length(probable_starter_json) <= 16384),
  memo TEXT NULL CHECK (memo IS NULL OR length(memo) <= 2000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'deleted')),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_test_games_date
  ON test_games(game_date, start_at, status);
