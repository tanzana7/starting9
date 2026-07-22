PRAGMA foreign_keys = ON;

-- 当日公示は1日1行へ保存し、同じ取得枠を複数Cronが処理しないようにします。
CREATE TABLE IF NOT EXISTS game_day_notices (
  notice_date TEXT PRIMARY KEY NOT NULL,
  source_url TEXT NOT NULL,
  content_hash TEXT NULL,
  fetched_at TEXT NULL,
  registered_json TEXT NOT NULL DEFAULT '[]',
  removed_json TEXT NOT NULL DEFAULT '[]',
  rosters_json TEXT NOT NULL DEFAULT '{}',
  registered_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  last_slot_key TEXT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'success', 'error')),
  last_error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_day_notice_games (
  game_id TEXT PRIMARY KEY NOT NULL,
  notice_date TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  notice_status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (notice_status IN ('waiting', 'detected', 'closed_without_notice')),
  registered_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NULL,
  detected_at TEXT NULL,
  roster_fixed_at TEXT NULL,
  after_deadline_notice INTEGER NOT NULL DEFAULT 0
    CHECK (after_deadline_notice IN (0, 1)),
  last_error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_day_notice_games_date
  ON game_day_notice_games(notice_date, notice_status, updated_at);

ALTER TABLE game_pregame_automation ADD COLUMN roster_fixed_at TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (publication_status IN ('pending', 'scored_private', 'published'));
ALTER TABLE game_lineups ADD COLUMN published_at TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN scored_private_at TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN published_at TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (publication_status IN ('pending', 'scored_private', 'published'));

CREATE INDEX IF NOT EXISTS idx_game_lineups_publication
  ON game_lineups(publication_status, published_at, scoring_status);
CREATE INDEX IF NOT EXISTS idx_ranking_games_publication
  ON ranking_games(publication_status, published_at, game_date);
