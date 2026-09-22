-- Migration number: 0001 	 2026-09-22T07:26:46.581Z
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_sessions_token ON sessions(token_hash, expires_at);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  game_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  prediction_deadline_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'lineup_confirmed', 'scored', 'published')),
  publication_status TEXT NOT NULL DEFAULT 'pending' CHECK (publication_status IN ('pending', 'published')),
  current_lineup_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_games_deadline ON games(prediction_deadline_at, status);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uniform_number TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game_id, name),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_players_game ON players(game_id, active, name);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'scored', 'invalid')),
  score INTEGER,
  max_score INTEGER,
  scored_revision INTEGER,
  actual_lineup_json TEXT,
  scored_at TEXT,
  is_test_prediction INTEGER NOT NULL DEFAULT 0 CHECK (is_test_prediction IN (0, 1)),
  UNIQUE (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_predictions_game_score ON predictions(game_id, status, is_test_prediction, score, submitted_at);

CREATE TABLE IF NOT EXISTS lineup_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  lineup_json TEXT NOT NULL CHECK (length(lineup_json) <= 16384),
  fingerprint TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, revision_number),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (confirmed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_lineup_revisions_current ON lineup_revisions(game_id, is_current, revision_number);

CREATE TABLE IF NOT EXISTS scoring_runs (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'rescore')),
  processed_count INTEGER NOT NULL DEFAULT 0,
  score_changed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_by TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_scoring_runs_game ON scoring_runs(game_id, revision_number, completed_at);
