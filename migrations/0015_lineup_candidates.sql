-- NPB公式からの取得結果を、本承認前の候補として試合単位に保存します。
-- 正式な採点対象は既存のgame_lineupsだけで管理し、この表は候補と検証状態の観測用です。
CREATE TABLE IF NOT EXISTS game_lineup_candidates (
  game_id TEXT PRIMARY KEY NOT NULL,
  actual_lineup_json TEXT NULL CHECK (actual_lineup_json IS NULL OR length(actual_lineup_json) <= 16384),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_error TEXT NULL,
  source_url TEXT NULL,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_lineup_candidates_fetched
  ON game_lineup_candidates(fetched_at);
