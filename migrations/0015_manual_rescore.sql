-- 正式スタメンの手動修正は既存のgame_lineupsを直接失わず、試合単位で版管理します。
CREATE TABLE IF NOT EXISTS game_lineup_revisions (
  game_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  actual_lineup_json TEXT NOT NULL CHECK (length(actual_lineup_json) <= 16384),
  lineup_fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('npb-auto', 'manual', 'manual-revision', 'restore')),
  created_at TEXT NOT NULL,
  created_by INTEGER NULL,
  reason TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  superseded_at TEXT NULL,
  PRIMARY KEY (game_id, version),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_lineup_revisions_current
  ON game_lineup_revisions(game_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_game_lineup_revisions_history
  ON game_lineup_revisions(game_id, version DESC);

CREATE TABLE IF NOT EXISTS game_rescore_previews (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  lineup_version INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (length(summary_json) <= 16384),
  expected_prediction_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, lineup_version) REFERENCES game_lineup_revisions(game_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_rescore_previews_expiry
  ON game_rescore_previews(expires_at);

CREATE TABLE IF NOT EXISTS game_rescore_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  lineup_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'running', 'completed', 'failed')),
  error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_rescore_jobs_game
  ON game_rescore_jobs(game_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS game_rescore_audits (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  game_date TEXT NOT NULL,
  previous_version INTEGER NULL,
  lineup_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  executed_by INTEGER NOT NULL,
  executed_at TEXT NOT NULL,
  prediction_count INTEGER NOT NULL DEFAULT 0,
  changed_score_count INTEGER NOT NULL DEFAULT 0,
  perfect_count_delta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'running', 'completed', 'failed')),
  error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (executed_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_game_rescore_audits_game
  ON game_rescore_audits(game_id, executed_at DESC);
