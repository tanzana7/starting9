const RELEASE_CUTOFF_ISO = "2026-09-18T09:00:00.000Z";
const RELEASE_CUTOFF_DATE = "2026-09-18";
const PLAN_VERSION = "pre-beta-2026-09-18-v1";
const CONFIRMATION = "DELETE PRE-BETA DATA 2026-09-18";
const IDENTIFIER_CHUNK_SIZE = 80;

// This is deliberately a fixed allowlist.  Roster/player master, schedule,
// account/session, and audit tables are not part of the release reset.
export const PRE_BETA_PURGE_TABLES = Object.freeze([
  "score_attempt_prediction_rows",
  "score_attempt_test_rows",
  "score_attempts",
  "prediction_score_revisions",
  "game_rescore_previews",
  "game_rescore_jobs",
  "game_rescore_audits",
  "ranking_reflection_revisions",
  "ranking_eligibility_history",
  "game_scoring_revisions",
  "perfect_achievers",
  "predictions",
  "game_lineup_revisions",
  "game_lineups",
  "ranking_test_predictions",
  "ranking_test_game_settings",
  "ranking_games",
  "game_jobs_v3",
  "game_job_runs",
  "game_automation_v3_state",
  "game_workflow_state",
  "user_achievements"
]);

const GAME_SCOPED_TABLES = new Set(PRE_BETA_PURGE_TABLES.filter((table) => table !== "user_achievements"));

function rowsOf(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function integer(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function placeholders(values, startAt = 1) {
  return values.map((_, index) => `?${startAt + index}`).join(", ");
}

function scopedPredicate(table, gameIds, internalGameIds) {
  const clauses = [];
  const bindings = [];
  if (gameIds.length && [
    "prediction_score_revisions", "game_rescore_previews", "game_rescore_jobs",
    "game_rescore_audits", "ranking_eligibility_history", "perfect_achievers",
    "predictions", "game_lineup_revisions", "game_lineups", "ranking_games"
  ].includes(table)) {
    clauses.push(`game_id IN (${placeholders(gameIds)})`);
    bindings.push(...gameIds);
  }
  if (internalGameIds.length && [
    "score_attempts", "game_scoring_revisions", "ranking_reflection_revisions",
    "predictions", "ranking_test_predictions", "ranking_test_game_settings",
    "game_jobs_v3", "game_job_runs", "game_automation_v3_state", "game_workflow_state"
  ].includes(table)) {
    const offset = bindings.length + 1;
    clauses.push(`internal_game_id IN (${placeholders(internalGameIds, offset)})`);
    bindings.push(...internalGameIds);
  }
  if (["score_attempt_prediction_rows", "score_attempt_test_rows"].includes(table) && internalGameIds.length) {
    const offset = bindings.length + 1;
    clauses.push(`attempt_id IN (SELECT attempt_id FROM score_attempts WHERE internal_game_id IN (${placeholders(internalGameIds, offset)}))`);
    bindings.push(...internalGameIds);
  }
  if (table === "user_achievements") {
    clauses.push("(created_at < ?1 OR earned_at < ?1)");
    bindings.push(RELEASE_CUTOFF_ISO);
  }
  if (!clauses.length) {
    // An empty pre-beta target is a valid no-op after the release boundary has
    // already been cleared.  Keep every game-scoped count explicitly empty;
    // never turn a missing target into an unbounded predicate.
    if (GAME_SCOPED_TABLES.has(table) && !gameIds.length && !internalGameIds.length) {
      return { where: "1 = 0", bindings: [] };
    }
    throw new Error(`PRE_BETA_PURGE_TARGET_IDS_UNAVAILABLE:${table}`);
  }
  return { where: clauses.join(" OR "), bindings };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveTargetGames(db) {
  const result = await db.prepare(
    `SELECT internal_game_id AS internal_game_id, internal_game_id AS game_id, game_date, start_time, 'completed_game' AS source
       FROM games
      WHERE game_status = 'completed' AND datetime(start_time) < datetime(?1)
      UNION
     SELECT ranking_games.internal_game_id, ranking_games.game_id, ranking_games.game_date,
            games.start_time, 'scored_ranking_game' AS source
       FROM ranking_games
       LEFT JOIN games ON games.internal_game_id = ranking_games.internal_game_id
      WHERE ranking_games.game_status = 'scored'
        AND (games.internal_game_id IS NULL OR games.game_status = 'completed')
        AND (
          (games.start_time IS NOT NULL AND datetime(games.start_time) < datetime(?1))
          OR (games.start_time IS NULL AND ranking_games.game_date < ?2)
        )
      ORDER BY game_date ASC, start_time ASC, game_id ASC`
  ).bind(RELEASE_CUTOFF_ISO, RELEASE_CUTOFF_DATE).all();
  const rows = rowsOf(result).filter((row) => row?.game_id || row?.internal_game_id);
  const gameIds = uniqueStrings(rows.map((row) => row.game_id));
  const internalGameIds = uniqueStrings(rows.map((row) => row.internal_game_id));

  if (internalGameIds.length) {
    const identifiers = await db.prepare(
      `SELECT identifier_value FROM game_identifiers
        WHERE internal_game_id IN (${placeholders(internalGameIds)})`
    ).bind(...internalGameIds).all();
    gameIds.push(...rowsOf(identifiers).map((row) => row.identifier_value));
  }
  return {
    rows,
    gameIds: uniqueStrings(gameIds),
    internalGameIds: uniqueStrings(internalGameIds)
  };
}

async function getActiveJobCount(db, internalGameIds) {
  if (!internalGameIds.length) return { gameJobs: 0, gameJobRuns: 0 };
  const ids = placeholders(internalGameIds);
  const [gameJobs, gameJobRuns] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id IN (${ids}) AND status IN ('pending', 'claimed', 'retry_wait')`).bind(...internalGameIds).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM game_job_runs WHERE internal_game_id IN (${ids}) AND status IN ('pending', 'claimed', 'running', 'retry_wait')`).bind(...internalGameIds).first()
  ]);
  return { gameJobs: integer(gameJobs?.count), gameJobRuns: integer(gameJobRuns?.count) };
}

async function getCounts(db, target) {
  const counts = {};
  for (const table of PRE_BETA_PURGE_TABLES) {
    const scope = scopedPredicate(table, target.gameIds, target.internalGameIds);
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${scope.where}`).bind(...scope.bindings).first();
    counts[table] = integer(row?.count);
  }
  return counts;
}

function planPayload(target) {
  return JSON.stringify({
    version: PLAN_VERSION,
    cutoff: RELEASE_CUTOFF_ISO,
    gameIds: target.gameIds,
    internalGameIds: target.internalGameIds
  });
}

async function buildPlan(db) {
  const target = await resolveTargetGames(db);
  if (target.rows.some((row) => !String(row?.game_id || "").trim() || !String(row?.internal_game_id || "").trim())) {
    throw new Error("PRE_BETA_PURGE_TARGET_IDS_UNAVAILABLE");
  }
  const counts = await getCounts(db, target);
  const activeJobs = await getActiveJobCount(db, target.internalGameIds);
  return {
    version: PLAN_VERSION,
    cutoff: RELEASE_CUTOFF_ISO,
    cutoffDate: RELEASE_CUTOFF_DATE,
    targetGames: target.rows,
    gameIds: target.gameIds,
    internalGameIds: target.internalGameIds,
    counts,
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    activeJobs,
    planHash: await sha256Hex(planPayload(target))
  };
}

export async function previewPreBetaPurge(db) {
  return buildPlan(db);
}

function chunk(values) {
  const result = [];
  for (let index = 0; index < values.length; index += IDENTIFIER_CHUNK_SIZE) {
    result.push(values.slice(index, index + IDENTIFIER_CHUNK_SIZE));
  }
  return result;
}

async function deleteScopedTable(db, table, target) {
  if (!GAME_SCOPED_TABLES.has(table)) {
    const scope = scopedPredicate(table, target.gameIds, target.internalGameIds);
    const result = await db.prepare(`DELETE FROM ${table} WHERE ${scope.where}`).bind(...scope.bindings).run();
    return integer(result?.meta?.changes);
  }
  let deleted = 0;
  const idChunks = target.gameIds.length ? chunk(target.gameIds) : [[]];
  const internalChunks = target.internalGameIds.length ? chunk(target.internalGameIds) : [[]];
  const chunkCount = Math.max(idChunks.length, internalChunks.length);
  for (let index = 0; index < chunkCount; index += 1) {
    const gameIds = idChunks[index] || [];
    const internalGameIds = internalChunks[index] || [];
    if (!gameIds.length && !internalGameIds.length) continue;
    const scope = scopedPredicate(table, gameIds, internalGameIds);
    const result = await db.prepare(`DELETE FROM ${table} WHERE ${scope.where}`).bind(...scope.bindings).run();
    deleted += integer(result?.meta?.changes);
  }
  return deleted;
}

export async function executePreBetaPurge(db, { planHash, confirmation } = {}) {
  if (String(confirmation || "") !== CONFIRMATION) {
    throw new Error("PRE_BETA_PURGE_CONFIRMATION_REQUIRED");
  }
  const plan = await buildPlan(db);
  if (String(planHash || "") !== plan.planHash) {
    throw new Error("PRE_BETA_PURGE_PLAN_CHANGED");
  }
  if (plan.activeJobs.gameJobs || plan.activeJobs.gameJobRuns) {
    throw new Error("PRE_BETA_PURGE_ACTIVE_JOBS");
  }

  // Delete children before parents. Each D1 statement is idempotent; if a
  // request is interrupted, retrying the same immutable target plan resumes
  // without touching newly-created or future-game records.
  const deleted = {};
  for (const table of PRE_BETA_PURGE_TABLES) {
    deleted[table] = await deleteScopedTable(db, table, plan);
  }
  const after = await buildPlan(db);
  return {
    ...plan,
    deleted,
    deletedTotal: Object.values(deleted).reduce((sum, count) => sum + count, 0),
    remaining: after.counts,
    remainingTotal: after.totalRows,
    completedAt: new Date().toISOString()
  };
}

export const PRE_BETA_PURGE_CUTOFF = RELEASE_CUTOFF_ISO;
export const PRE_BETA_PURGE_CONFIRMATION = CONFIRMATION;
export const PRE_BETA_PURGE_PLAN_VERSION = PLAN_VERSION;
