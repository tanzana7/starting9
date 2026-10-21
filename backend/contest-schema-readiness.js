const REQUIRED_MIGRATIONS = Object.freeze([
  "0046_contest_identity_foundation.sql",
  "0047_contest_scoped_predictions_lineups.sql",
  "0048_contest_scoped_results.sql",
  "0049_contest_scoped_formal_jobs.sql"
]);

const REQUIRED_TABLES = Object.freeze([
  "contest_identity_teams",
  "game_contests",
  "contest_identity_backfill_issues",
  "contest_lineup_revisions",
  "contest_scoring_revisions",
  "contest_score_attempts",
  "contest_score_attempt_prediction_rows",
  "contest_score_attempt_test_rows",
  "contest_prediction_score_revisions",
  "contest_ranking_games",
  "contest_ranking_eligibility_history",
  "contest_ranking_reflection_revisions",
  "contest_perfect_achievers",
  "contest_game_rescore_previews",
  "contest_game_rescore_jobs",
  "contest_game_rescore_audits",
  "contest_ranking_test_game_settings",
  "contest_ranking_test_predictions",
  "contest_automation_v3_state",
  "game_jobs_v3"
]);

const REQUIRED_COLUMNS = Object.freeze([
  ["game_contests", "contest_id"],
  ["game_contests", "internal_game_id"],
  ["game_contests", "target_team_key"],
  ["predictions", "contest_id"],
  ["predictions", "internal_game_id"],
  ["game_lineups", "contest_id"],
  ["game_lineups", "internal_game_id"],
  ["contest_lineup_revisions", "contest_id"],
  ["contest_lineup_revisions", "internal_game_id"],
  ["contest_scoring_revisions", "contest_id"],
  ["contest_score_attempts", "contest_id"],
  ["contest_ranking_games", "contest_id"],
  ["contest_ranking_reflection_revisions", "contest_id"],
  ["contest_automation_v3_state", "contest_id"],
  ["game_jobs_v3", "contest_id"],
  ["game_jobs_v3", "internal_game_id"],
  ["game_jobs_v3", "job_type"]
]);

const REQUIRED_INDEXES = Object.freeze([
  "idx_game_contests_id_game",
  "idx_game_jobs_v3_contest_identity",
  "idx_game_jobs_v3_physical_identity",
  "idx_contest_lineup_revisions_contest_revision_id",
  "idx_contest_lineup_revisions_current",
  "idx_contest_scoring_revisions_active",
  "idx_contest_score_attempts_one_committed",
  "idx_predictions_contest_id_game"
]);

const REQUIRED_TRIGGERS = Object.freeze([
  "game_contests_require_participant_insert",
  "game_contests_require_participant_update",
  "predictions_require_contest_insert",
  "predictions_require_contest_update",
  "game_lineups_require_contest_insert",
  "game_lineups_require_contest_update",
  "contest_score_attempt_prediction_scope_insert",
  "contest_score_attempt_prediction_scope_update"
]);

// D1's SQLite build limits the number of compound SELECT terms more tightly
// than the local SQLite test runtime. Keep each read-only metadata probe below
// that platform limit so the production schema gate can resume after migration.
const COLUMN_PROBE_BATCH_SIZE = 8;
const COLUMN_PROBE_SQL = Array.from(
  { length: Math.ceil(REQUIRED_COLUMNS.length / COLUMN_PROBE_BATCH_SIZE) },
  (_, index) => REQUIRED_COLUMNS
    .slice(index * COLUMN_PROBE_BATCH_SIZE, (index + 1) * COLUMN_PROBE_BATCH_SIZE)
    .map(([table, column]) =>
      `SELECT '${table}' AS table_name, name AS column_name FROM pragma_table_info('${table}') WHERE name = '${column}'`
    )
    .join(" UNION ALL ")
);

/**
 * A C-4 Worker can be deployed before the table rebuild only if it refuses all
 * game/business routes and scheduled work until the complete schema is present.
 * The probe is read-only, uncached (so migration completion is observed on the
 * next request/Cron), and fails closed on missing or malformed D1 metadata.
 */
export async function inspectContestSchemaReadiness(db) {
  if (!db || typeof db.prepare !== "function") {
    return { ready: false, reasonCode: "AUTH_DB_UNAVAILABLE" };
  }

  try {
    const ledger = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations' LIMIT 1"
    ).first();
    if (ledger) {
      const placeholders = REQUIRED_MIGRATIONS.map((_, index) => `?${index + 1}`).join(", ");
      const applied = await db.prepare(
        `SELECT name FROM d1_migrations WHERE name IN (${placeholders})`
      ).bind(...REQUIRED_MIGRATIONS).all();
      const appliedNames = new Set((applied?.results || []).map((row) => String(row.name || "")));
      const missingMigrations = REQUIRED_MIGRATIONS.filter((name) => !appliedNames.has(name));
      if (missingMigrations.length) {
        return { ready: false, reasonCode: "CONTEST_MIGRATIONS_INCOMPLETE", missingMigrations };
      }
    }

    const objectsResult = await db.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')"
    ).all();
    const objects = new Map((objectsResult?.results || []).map((row) => [`${row.type}:${row.name}`, row]));
    const missingTables = REQUIRED_TABLES.filter((name) => !objects.has(`table:${name}`));
    const missingIndexes = REQUIRED_INDEXES.filter((name) => !objects.has(`index:${name}`));
    const missingTriggers = REQUIRED_TRIGGERS.filter((name) => !objects.has(`trigger:${name}`));
    const columnProbeResults = await Promise.all(COLUMN_PROBE_SQL.map((sql) => db.prepare(sql).all()));
    const foundColumns = new Set(columnProbeResults.flatMap((result) =>
      (result?.results || []).map((row) => `${row.table_name}:${row.column_name}`)
    ));
    const missingColumns = REQUIRED_COLUMNS
      .filter(([table, column]) => !foundColumns.has(`${table}:${column}`))
      .map(([table, column]) => `${table}.${column}`);
    const jobsSql = String(objects.get("table:game_jobs_v3")?.sql || "").toLowerCase().replace(/\s+/g, " ");
    const jobConstraintsReady = jobsSql.includes("contest_id is not null") && jobsSql.includes("contest_id is null");

    const ready = missingTables.length === 0
      && missingIndexes.length === 0
      && missingTriggers.length === 0
      && missingColumns.length === 0
      && jobConstraintsReady;
    return {
      ready,
      reasonCode: ready ? null : "CONTEST_SCHEMA_CAPABILITY_MISSING",
      missingTables,
      missingIndexes,
      missingTriggers,
      missingColumns,
      jobConstraintsReady
    };
  } catch {
    return { ready: false, reasonCode: "CONTEST_SCHEMA_PROBE_FAILED" };
  }
}
