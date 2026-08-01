PRAGMA foreign_keys = ON;

-- 最終スタメン取得期限切れの試合を、採点失敗や中止とは別の集計対象外状態として保持します。
-- ranking_games の既存列と日時を引き継ぎ、予想・ログの削除は行いません。
DROP INDEX IF EXISTS idx_ranking_games_eligible;
DROP INDEX IF EXISTS idx_ranking_games_monthly;
DROP INDEX IF EXISTS idx_ranking_games_publication;

ALTER TABLE ranking_games RENAME TO ranking_games_before_service_unavailable;

CREATE TABLE ranking_games (
  game_id TEXT PRIMARY KEY NOT NULL,
  is_ranking_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (is_ranking_eligible IN (0, 1)),
  ranking_eligible_at TEXT NULL,
  game_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (game_status IN ('pending', 'scored', 'failed', 'cancelled', 'service_unavailable')),
  is_test_game INTEGER NOT NULL DEFAULT 0
    CHECK (is_test_game IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  game_date TEXT NULL
    CHECK (game_date IS NULL OR (length(game_date) = 10 AND date(game_date) = game_date)),
  scored_private_at TEXT NULL,
  published_at TEXT NULL,
  publication_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (publication_status IN ('pending', 'scored_private', 'published'))
);

INSERT INTO ranking_games (
  game_id, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
  created_at, updated_at, game_date, scored_private_at, published_at, publication_status
)
SELECT game_id, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
       created_at, updated_at, game_date, scored_private_at, published_at, publication_status
  FROM ranking_games_before_service_unavailable;

DROP TABLE ranking_games_before_service_unavailable;

CREATE INDEX idx_ranking_games_eligible
  ON ranking_games(is_ranking_eligible, game_status, is_test_game, ranking_eligible_at);
CREATE INDEX idx_ranking_games_monthly
  ON ranking_games(is_ranking_eligible, game_status, is_test_game, game_date);
CREATE INDEX idx_ranking_games_publication
  ON ranking_games(publication_status, published_at, game_date);
