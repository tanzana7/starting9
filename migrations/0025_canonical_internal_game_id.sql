PRAGMA foreign_keys = ON;

-- Phase 4 keeps the legacy game_id as a compatibility key.  UUID links are
-- nullable so records that cannot be resolved unambiguously remain auditable.
ALTER TABLE predictions ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE probable_starters ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE game_roster_snapshots ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE game_rescore_jobs ADD COLUMN internal_game_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_predictions_internal_game_id
  ON predictions(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_probable_starters_internal_game_id
  ON probable_starters(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_game_roster_snapshots_internal_game_id
  ON game_roster_snapshots(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_game_pregame_automation_internal_game_id
  ON game_pregame_automation(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_game_lineups_internal_game_id
  ON game_lineups(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_ranking_games_internal_game_id
  ON ranking_games(internal_game_id);
CREATE INDEX IF NOT EXISTS idx_game_rescore_jobs_internal_game_id
  ON game_rescore_jobs(internal_game_id);

-- Only link a legacy row when exactly one schedule record has the matching
-- legacy ID and an existing registry UUID.  Ambiguous and non-game scopes stay
-- null for the audit API and later repair work.
UPDATE predictions
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = predictions.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE probable_starters
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = probable_starters.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE game_roster_snapshots
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = game_roster_snapshots.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE game_pregame_automation
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = game_pregame_automation.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE game_lineups
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = game_lineups.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE ranking_games
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = ranking_games.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';

UPDATE game_rescore_jobs
   SET internal_game_id = (
     SELECT schedule.internal_game_id
       FROM detected_game_schedule AS schedule
      WHERE schedule.game_id = game_rescore_jobs.game_id
        AND schedule.internal_game_id IS NOT NULL
        AND schedule.internal_game_id <> ''
      GROUP BY schedule.game_id
     HAVING COUNT(*) = 1
   )
 WHERE internal_game_id IS NULL
   AND game_id NOT LIKE 'day-%';
