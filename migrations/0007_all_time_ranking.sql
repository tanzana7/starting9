PRAGMA foreign_keys = ON;

-- ランキング対象外の開発・テスト予想を、採点データとは分けて扱います。
ALTER TABLE predictions
  ADD COLUMN is_test_prediction INTEGER NOT NULL DEFAULT 0
    CHECK (is_test_prediction IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_predictions_ranking_scores
  ON predictions(game_id, status, is_test_prediction, user_id, scored_at);

-- 予想が存在するかではなく、正式に採点を完了した試合だけをランキング分母にします。
CREATE TABLE IF NOT EXISTS ranking_games (
  game_id TEXT PRIMARY KEY NOT NULL,
  is_ranking_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (is_ranking_eligible IN (0, 1)),
  ranking_eligible_at TEXT NULL,
  game_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (game_status IN ('pending', 'scored', 'failed', 'cancelled')),
  is_test_game INTEGER NOT NULL DEFAULT 0
    CHECK (is_test_game IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ranking_games_eligible
  ON ranking_games(is_ranking_eligible, game_status, is_test_game, ranking_eligible_at);
