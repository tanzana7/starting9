-- Migration number: 0004 	 2026-10-02T03:53:31.445Z

-- Keep ranking entries separate from the legacy table so every rebuild has a
-- competition-scoped generation that can be published explicitly.
ALTER TABLE formal_jobs ADD COLUMN artifact_generation INTEGER;

CREATE TABLE IF NOT EXISTS competition_ranking_generations (
  competition_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  target_game_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'built' CHECK (status IN ('built', 'published')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (competition_id, generation),
  FOREIGN KEY (target_game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_competition_ranking_generations_target
  ON competition_ranking_generations (competition_id, target_game_id, generation);

CREATE TABLE IF NOT EXISTS competition_ranking_entries (
  competition_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  score_total INTEGER NOT NULL DEFAULT 0,
  games_count INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, generation, user_id),
  FOREIGN KEY (competition_id, generation)
    REFERENCES competition_ranking_generations(competition_id, generation)
    ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_competition_ranking_entries_order
  ON competition_ranking_entries (competition_id, generation, rank, user_id);

CREATE TABLE IF NOT EXISTS competition_ranking_publications (
  competition_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (competition_id, generation)
    REFERENCES competition_ranking_generations(competition_id, generation)
    ON DELETE CASCADE
);
