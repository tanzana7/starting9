PRAGMA foreign_keys = ON;

-- 月間ランキングは採点日時ではなく、検証済みgame_idから保存した試合日で集計します。
-- 既存レコードへ日付を推測して補完しないため、NULLの過去レコードは通算のみ対象です。
ALTER TABLE ranking_games
  ADD COLUMN game_date TEXT NULL
    CHECK (game_date IS NULL OR (length(game_date) = 10 AND date(game_date) = game_date));

CREATE INDEX IF NOT EXISTS idx_ranking_games_monthly
  ON ranking_games(is_ranking_eligible, game_status, is_test_game, game_date);
