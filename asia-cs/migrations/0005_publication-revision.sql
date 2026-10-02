-- Migration number: 0005  2026-10-02T00:00:00Z
-- Ranking artifacts are snapshots. The publication revision is the explicit
-- ordering boundary; generation IDs remain opaque and are never ordered.
-- The legacy INTEGER-affinity generation columns intentionally store the new
-- UUID IDs as opaque text; SQLite/D1 accepts that value and application code
-- never coerces or orders it. Existing migrations remain untouched.
ALTER TABLE competition_ranking_generations ADD COLUMN base_publication_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS competition_publication_state (
  competition_id TEXT PRIMARY KEY NOT NULL,
  publication_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  last_publication_generation TEXT
);
