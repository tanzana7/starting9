PRAGMA foreign_keys = ON;

-- 管理者専用の自動採点テスト。通常試合・ランキング・本番Cronとは分離します。
CREATE TABLE IF NOT EXISTS auto_scoring_tests (
  game_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 160),
  game_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  prediction_deadline_at TEXT NOT NULL,
  home_team TEXT NOT NULL DEFAULT 'f',
  away_team TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '' CHECK (length(venue) <= 160),
  roster_json TEXT NOT NULL CHECK (length(roster_json) <= 16384),
  answer_lineup_json TEXT NULL CHECK (answer_lineup_json IS NULL OR length(answer_lineup_json) <= 16384),
  mode TEXT NOT NULL DEFAULT 'auto_scoring'
    CHECK (mode = 'auto_scoring'),
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'scoring', 'scored', 'published', 'failed', 'deleted')),
  last_auto_run_at TEXT NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL CHECK (last_error_message IS NULL OR length(last_error_message) <= 240),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_auto_scoring_tests_due
  ON auto_scoring_tests(status, prediction_deadline_at, start_at);
