-- DESIGN DRAFT ONLY.
-- Do not copy this file into migrations/ or apply it to production D1.
-- Before any apply: run the read-only duplicate checks in
-- docs/v3-manual-game-registration.md and obtain an explicit approval.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS manual_schedule_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schedule_identity_key TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('add_game')),
  internal_game_id TEXT NULL,
  game_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_sequence INTEGER NOT NULL CHECK (game_sequence > 0),
  venue TEXT NULL,
  npb_game_code TEXT NULL,
  ranking_eligible INTEGER NOT NULL DEFAULT 1 CHECK (ranking_eligible IN (0, 1)),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'initializing', 'ready', 'failed', 'cancelled')),
  is_public_candidate INTEGER NOT NULL DEFAULT 0 CHECK (is_public_candidate IN (0, 1)),
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin-v3',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_manual_schedule_operations_status
  ON manual_schedule_operations(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS schedule_identity_locks (
  schedule_identity_key TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NULL,
  game_date TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_sequence INTEGER NOT NULL CHECK (game_sequence > 0),
  start_time TEXT NOT NULL,
  npb_game_code TEXT NULL,
  lock_status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (lock_status IN ('reserved', 'linked', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_identity_locks_npb_code
  ON schedule_identity_locks(npb_game_code)
 WHERE npb_game_code IS NOT NULL AND trim(npb_game_code) <> '';

-- These nullable columns preserve existing canonical games. Existing rows must
-- be backfilled only after duplicate inspection and explicit approval.
ALTER TABLE games ADD COLUMN schedule_identity_key TEXT NULL;
ALTER TABLE games ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'canonical'
  CHECK (registration_status IN ('canonical', 'pending', 'initializing', 'ready', 'failed', 'cancelled'));
ALTER TABLE games ADD COLUMN is_public_candidate INTEGER NOT NULL DEFAULT 1
  CHECK (is_public_candidate IN (0, 1));
ALTER TABLE games ADD COLUMN schedule_source TEXT NULL;
ALTER TABLE games ADD COLUMN manual_operation_id TEXT NULL;
ALTER TABLE games ADD COLUMN ranking_eligible INTEGER NULL
  CHECK (ranking_eligible IS NULL OR ranking_eligible IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_games_registration_status
  ON games(registration_status, is_public_candidate, game_date, start_time);
CREATE INDEX IF NOT EXISTS idx_games_schedule_identity_key
  ON games(schedule_identity_key);
CREATE INDEX IF NOT EXISTS idx_games_manual_operation_id
  ON games(manual_operation_id);

-- Do not add a unique index to games.schedule_identity_key in this draft.
-- Existing duplicate rows must be inspected and resolved by an approved,
-- versioned migration before that constraint can be introduced.
