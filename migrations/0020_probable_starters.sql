CREATE TABLE IF NOT EXISTS probable_starters (
  game_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('unannounced', 'announced', 'error')),
  home_pitcher_name TEXT,
  away_pitcher_name TEXT,
  fetched_at TEXT,
  announced_at TEXT,
  next_check_at TEXT,
  source_url TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_probable_starters_next_check_at
  ON probable_starters (next_check_at);
CREATE INDEX IF NOT EXISTS idx_probable_starters_status
  ON probable_starters (status);
