PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS perfect_achievers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score > 0),
  achieved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_perfect_achievers_game_id
  ON perfect_achievers(game_id);

CREATE INDEX IF NOT EXISTS idx_perfect_achievers_game_created
  ON perfect_achievers(game_id, created_at, achieved_at);
