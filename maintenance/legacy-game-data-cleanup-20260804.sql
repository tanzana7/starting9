-- Starting9 legacy game-data cleanup plan (2026-08-04 cutoff)
--
-- SAFETY: This file is a review artifact only. It has not been executed.
-- The dry-run section contains SELECT statements only. The DELETE sections are
-- deliberately separate and require an operator to choose Plan A or Plan B.
-- Do not run this file as a single opaque deployment command.
--
-- Target policy:
--   * never include game_date > '2026-08-04';
--   * default candidates are explicitly marked test games, auto-scoring tests,
--     or ranking_games.is_test_game = 1;
--   * production games without a test marker require an explicit review before
--     adding their legacy IDs to the target CTE;
--   * users, sessions, admin accounts, player/team masters, static roster data,
--     configuration, and secrets are never selected or deleted here.

-- ============================================================================
-- DRY RUN: SELECT ONLY
-- ============================================================================

-- 1. Candidate game registry rows and the legacy IDs that identify them.
WITH target_legacy_ids AS (
  SELECT game_id FROM test_games WHERE game_date <= '2026-08-04'
  UNION
  SELECT game_id FROM auto_scoring_tests WHERE game_date <= '2026-08-04'
  UNION
  SELECT game_id FROM ranking_games
   WHERE is_test_game = 1
     AND game_date IS NOT NULL
     AND game_date <= '2026-08-04'
), target_internal_ids AS (
  SELECT g.internal_game_id
    FROM games g
   WHERE g.game_date <= '2026-08-04'
     AND (
       EXISTS (
         SELECT 1 FROM ranking_games rg
          WHERE rg.internal_game_id = g.internal_game_id
            AND rg.is_test_game = 1
       )
       OR EXISTS (
         SELECT 1 FROM detected_game_schedule s
          WHERE s.internal_game_id = g.internal_game_id
            AND s.game_id IN (SELECT game_id FROM target_legacy_ids)
       )
       OR EXISTS (
         SELECT 1 FROM game_workflow_state ws
          WHERE ws.internal_game_id = g.internal_game_id
            AND ws.legacy_game_id IN (SELECT game_id FROM target_legacy_ids)
       )
       OR EXISTS (
         SELECT 1 FROM game_identifiers gi
          WHERE gi.internal_game_id = g.internal_game_id
            AND gi.identifier_value IN (SELECT game_id FROM target_legacy_ids)
       )
     )
), target_games AS (
  SELECT g.internal_game_id,
         g.game_date,
         g.start_time,
         COALESCE(ws.legacy_game_id, s.game_id) AS legacy_game_id,
         g.game_status
    FROM games g
    LEFT JOIN game_workflow_state ws ON ws.internal_game_id = g.internal_game_id
    LEFT JOIN detected_game_schedule s ON s.internal_game_id = g.internal_game_id
   WHERE g.internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
)
SELECT internal_game_id, game_date, start_time, legacy_game_id, game_status
  FROM target_games
 ORDER BY game_date, start_time, internal_game_id;

-- 2. Per-table counts, IDs, oldest/newest timestamps, and retained rows.
WITH target_legacy_ids AS (
  SELECT game_id FROM test_games WHERE game_date <= '2026-08-04'
  UNION
  SELECT game_id FROM auto_scoring_tests WHERE game_date <= '2026-08-04'
  UNION
  SELECT game_id FROM ranking_games
   WHERE is_test_game = 1
     AND game_date IS NOT NULL
     AND game_date <= '2026-08-04'
), target_internal_ids AS (
  SELECT g.internal_game_id
    FROM games g
   WHERE g.game_date <= '2026-08-04'
     AND (
       EXISTS (SELECT 1 FROM ranking_games rg WHERE rg.internal_game_id = g.internal_game_id AND rg.is_test_game = 1)
       OR EXISTS (SELECT 1 FROM detected_game_schedule s WHERE s.internal_game_id = g.internal_game_id AND s.game_id IN (SELECT game_id FROM target_legacy_ids))
       OR EXISTS (SELECT 1 FROM game_workflow_state ws WHERE ws.internal_game_id = g.internal_game_id AND ws.legacy_game_id IN (SELECT game_id FROM target_legacy_ids))
       OR EXISTS (SELECT 1 FROM game_identifiers gi WHERE gi.internal_game_id = g.internal_game_id AND gi.identifier_value IN (SELECT game_id FROM target_legacy_ids))
     )
), target_legacy_game_ids AS (
  SELECT game_id FROM target_legacy_ids
  UNION
  SELECT game_id FROM detected_game_schedule WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
  UNION
  SELECT legacy_game_id FROM game_workflow_state WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
), counts AS (
  SELECT 'game_workflow_state' AS table_name, COUNT(*) AS target_count, MIN(updated_at) AS oldest_at, MAX(updated_at) AS newest_at,
         group_concat(DISTINCT internal_game_id) AS internal_game_ids, group_concat(DISTINCT legacy_game_id) AS legacy_game_ids,
         (SELECT COUNT(*) FROM game_workflow_state) - COUNT(*) AS retained_count
    FROM game_workflow_state WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
  UNION ALL SELECT 'game_job_runs', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), NULL,
         (SELECT COUNT(*) FROM game_job_runs) - COUNT(*) FROM game_job_runs WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
  UNION ALL SELECT 'game_lineups', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_lineups) - COUNT(*) FROM game_lineups WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'game_pregame_automation', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_pregame_automation) - COUNT(*) FROM game_pregame_automation WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'game_roster_snapshots', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_roster_snapshots) - COUNT(*) FROM game_roster_snapshots WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'probable_starters', COUNT(*), MIN(updated_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM probable_starters) - COUNT(*) FROM probable_starters WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'detected_game_schedule', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM detected_game_schedule) - COUNT(*) FROM detected_game_schedule WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'game_identifiers', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), NULL,
         (SELECT COUNT(*) FROM game_identifiers) - COUNT(*) FROM game_identifiers WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
  UNION ALL SELECT 'game_workflow_controls', COUNT(*), MIN(updated_at), MAX(updated_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_workflow_controls) - COUNT(*) FROM game_workflow_controls WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'game_day_notice_games', COUNT(*), MIN(created_at), MAX(updated_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_day_notice_games) - COUNT(*) FROM game_day_notice_games WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'game_workflow_logs', COUNT(*), MIN(occurred_at), MAX(occurred_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM game_workflow_logs) - COUNT(*) FROM game_workflow_logs WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'test_games', COUNT(*), MIN(created_at), MAX(updated_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM test_games) - COUNT(*) FROM test_games WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'auto_scoring_tests', COUNT(*), MIN(created_at), MAX(updated_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM auto_scoring_tests) - COUNT(*) FROM auto_scoring_tests WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'predictions', COUNT(*), MIN(submitted_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM predictions) - COUNT(*) FROM predictions WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'ranking_games', COUNT(*), MIN(created_at), MAX(updated_at), group_concat(DISTINCT internal_game_id), group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM ranking_games) - COUNT(*) FROM ranking_games WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids) OR game_id IN (SELECT game_id FROM target_legacy_game_ids)
  UNION ALL SELECT 'perfect_achievers', COUNT(*), MIN(created_at), MAX(created_at), NULL, group_concat(DISTINCT game_id),
         (SELECT COUNT(*) FROM perfect_achievers) - COUNT(*) FROM perfect_achievers WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids)
)
SELECT * FROM counts ORDER BY table_name;

-- 3. Orphan verification before deletion. The result must be recorded with the
-- dry-run report; no row is changed by this query.
SELECT 'orphan_game_job_runs' AS check_name, COUNT(*) AS count
  FROM game_job_runs jobs
  LEFT JOIN games ON games.internal_game_id = jobs.internal_game_id
 WHERE games.internal_game_id IS NULL
UNION ALL
SELECT 'orphan_identifiers', COUNT(*)
  FROM game_identifiers identifiers
  LEFT JOIN games ON games.internal_game_id = identifiers.internal_game_id
 WHERE games.internal_game_id IS NULL
UNION ALL
SELECT 'orphan_schedule_internal_ids', COUNT(*)
  FROM detected_game_schedule schedule
  LEFT JOIN games ON games.internal_game_id = schedule.internal_game_id
 WHERE schedule.internal_game_id IS NOT NULL AND games.internal_game_id IS NULL;

-- 4. Plan A/Plan B impact summary. Plan A preserves predictions, scores,
-- ranking rows, and publication results. Plan B removes those additional rows.
SELECT 'PLAN_A_OPERATIONAL_ONLY' AS plan_name,
       'predictions, game_lineups, ranking_games, perfect_achievers and users are retained' AS policy
UNION ALL
SELECT 'PLAN_B_OPERATIONAL_AND_RESULTS',
       'Plan A plus predictions, game_lineups, revisions, rescore records, ranking_games and perfect_achievers';

-- ============================================================================
-- PLAN A: operational/workflow/log data only
-- ============================================================================
-- Not executed. Re-run the dry-run above immediately before applying.
-- Use the same target CTEs from the dry-run section and execute in dependency
-- order. D1 production execution is intentionally out of scope for this PR.
-- For an approved execution, materialize reviewed target IDs into temporary
-- tables first; these statements are intentionally commented out here:
-- CREATE TEMP TABLE target_internal_ids AS SELECT internal_game_id FROM ...;
-- CREATE TEMP TABLE target_legacy_game_ids AS SELECT game_id FROM ...;
-- The DELETE statements below assume those temporary tables contain only the
-- IDs approved from the preceding SELECT output.

-- DELETE FROM game_job_runs
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids);
-- DELETE FROM game_workflow_state
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids);
-- DELETE FROM game_workflow_controls
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_lineup_revisions ...; -- reserved for Plan B because it is result history
-- DELETE FROM game_pregame_automation
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_roster_snapshots
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM probable_starters
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_day_notice_games
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_workflow_logs
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM detected_game_schedule
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_identifiers
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids);
-- DELETE FROM test_games
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM auto_scoring_tests
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
--
-- Plan A deliberately does not delete games when predictions/results remain.
-- Any registry row that is proven to have no remaining child rows may be
-- deleted last after the verification query below.
-- DELETE FROM games
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--    AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.internal_game_id = games.internal_game_id OR p.game_id IN (SELECT game_id FROM target_legacy_game_ids))
--    AND NOT EXISTS (SELECT 1 FROM game_lineups l WHERE l.internal_game_id = games.internal_game_id OR l.game_id IN (SELECT game_id FROM target_legacy_game_ids))
--    AND NOT EXISTS (SELECT 1 FROM ranking_games r WHERE r.internal_game_id = games.internal_game_id OR r.game_id IN (SELECT game_id FROM target_legacy_game_ids));

-- ============================================================================
-- PLAN B: Plan A plus predictions, scoring, ranking and publication data
-- ============================================================================
-- Not executed. Do not choose this plan without a separate user-approved
-- decision. Delete child/result rows before games because games is referenced
-- by workflow/job foreign keys and game_identifiers.

-- DELETE FROM game_rescore_previews
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_rescore_jobs
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_rescore_audits
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_lineup_revisions
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM perfect_achievers
--  WHERE game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM ranking_games
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM game_lineups
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
-- DELETE FROM predictions
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids)
--     OR game_id IN (SELECT game_id FROM target_legacy_game_ids);
--
-- Execute the Plan A operational deletes after the result deletes, then:
-- DELETE FROM games
--  WHERE internal_game_id IN (SELECT internal_game_id FROM target_internal_ids);

-- ============================================================================
-- POST-DELETE VERIFICATION (SELECT ONLY)
-- ============================================================================
-- Re-run the dry-run count query and require all selected target counts to be 0.
SELECT 'remaining_target_internal_games' AS check_name, COUNT(*) AS count
  FROM games
 WHERE game_date <= '2026-08-04'
   AND internal_game_id IN (
     SELECT internal_game_id FROM game_workflow_state
     UNION SELECT internal_game_id FROM game_job_runs
     UNION SELECT internal_game_id FROM detected_game_schedule WHERE internal_game_id IS NOT NULL
   )
UNION ALL
SELECT 'remaining_orphan_identifiers', COUNT(*)
  FROM game_identifiers identifiers
  LEFT JOIN games ON games.internal_game_id = identifiers.internal_game_id
 WHERE games.internal_game_id IS NULL
UNION ALL
SELECT 'future_games_touched', COUNT(*)
  FROM games
 WHERE game_date > '2026-08-04'
   AND internal_game_id IN (SELECT internal_game_id FROM game_workflow_state);

-- Transaction/rollback guidance:
-- D1 does not provide a general-purpose cross-request rollback. If an
-- operator-approved execution is ever requested, export the dry-run target
-- rows and use one D1 batch/transaction per plan, followed by the verification
-- SELECTs. Rollback requires restoring those exported rows; this file does not
-- issue rollback SQL and no rollback has been executed.
