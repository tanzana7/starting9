-- Migration number: 0006 	 2026-10-02T08:46:35.642Z
-- Phase 2 adds competition metadata without changing the Phase 1 game, job,
-- ranking, or identity tables.  The default row keeps the existing asia-cs
-- competition usable on a fresh database while allowing the UI to be fully
-- metadata-driven.
CREATE TABLE IF NOT EXISTS competitions (
  id TEXT PRIMARY KEY NOT NULL,
  competition_type TEXT NOT NULL DEFAULT 'ASIA_CS',
  display_name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_competitions_status
  ON competitions (status, start_date, end_date, id);

INSERT OR IGNORE INTO competitions
  (id, competition_type, display_name, short_name, status, created_at, updated_at)
VALUES
  ('asia-cs', 'ASIA_CS', 'Asia CS', 'Asia CS', 'active', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
