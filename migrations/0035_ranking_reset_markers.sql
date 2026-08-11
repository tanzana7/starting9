-- Ranking resets are non-destructive. A marker changes aggregation boundaries;
-- predictions, ranking_games, users, and published results remain untouched.
CREATE TABLE IF NOT EXISTS ranking_reset_markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL CHECK (period_type IN ('yearly', 'monthly')),
  period_key TEXT NOT NULL,
  reset_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranking_reset_markers_active
  ON ranking_reset_markers(period_type, period_key)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_ranking_reset_markers_period
  ON ranking_reset_markers(period_type, period_key, created_at DESC);
