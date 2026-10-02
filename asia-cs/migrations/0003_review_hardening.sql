-- Review hardening is additive: the original MVP tables remain compatible with
-- local fixtures while production requests use the existing Starting9 identity.
ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_asia_cs_users_external_identity
  ON users (auth_source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition_rankings (
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score_total INTEGER NOT NULL DEFAULT 0,
  games_count INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_rankings_order
  ON competition_rankings (competition_id, rank, user_id);
