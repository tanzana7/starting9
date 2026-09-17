const RELEASE_CUTOFF_ISO = "2026-09-18T09:00:00.000Z";
const RELEASE_CUTOFF_DATE = "2026-09-18";
const PLAN_VERSION = "pre-beta-2026-09-18-v2";
const CONFIRMATION = "DELETE PRE-BETA DATA 2026-09-18";
const MAX_D1_BINDINGS = 100;
const IDENTIFIER_CHUNK_SIZE = 80;
const TARGET_SOURCE_PRIORITY = Object.freeze({
  pre_beta_prediction: 1,
  completed_game: 2,
  scored_ranking_game: 3
});

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
const GAME_ID_SCOPED_TABLES = new Set([
  "prediction_score_revisions", "game_rescore_previews", "game_rescore_jobs",
  "game_rescore_audits", "ranking_eligibility_history", "perfect_achievers",
  "predictions", "game_lineup_revisions", "game_lineups", "ranking_games",
  "score_attempts", "game_scoring_revisions"
]);
const INTERNAL_GAME_ID_SCOPED_TABLES = new Set([
  "score_attempts", "game_scoring_revisions", "ranking_reflection_revisions",
  "predictions", "ranking_test_predictions", "ranking_test_game_settings",
  "game_jobs_v3", "game_job_runs", "game_automation_v3_state", "game_workflow_state"
]);
const LEGACY_GAME_ID_SCOPED_TABLES = new Set(["game_workflow_state"]);
const ATTEMPT_ROW_TABLES = new Set(["score_attempt_prediction_rows", "score_attempt_test_rows"]);

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

function targetRowKey(row) {
  return String(row?.internal_game_id || row?.game_id || "").trim();
}

function uniqueTargetRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = targetRowKey(row);
    if (!key) continue;
    const existing = byKey.get(key);
    const currentPriority = TARGET_SOURCE_PRIORITY[row.source] || 0;
    const existingPriority = TARGET_SOURCE_PRIORITY[existing?.source] || 0;
    if (!existing || currentPriority > existingPriority) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.game_date || "").localeCompare(String(right.game_date || ""))
      || String(left.start_time || "").localeCompare(String(right.start_time || ""))
      || String(left.game_id || left.internal_game_id || "").localeCompare(String(right.game_id || right.internal_game_id || ""))
  );
}

function scopedPredicate(table, gameIds, internalGameIds) {
  const clauses = [];
  const bindings = [];
  if (gameIds.length && GAME_ID_SCOPED_TABLES.has(table)) {
    clauses.push(`game_id IN (${placeholders(gameIds)})`);
    bindings.push(...gameIds);
  }
  if (gameIds.length && LEGACY_GAME_ID_SCOPED_TABLES.has(table)) {
    const offset = bindings.length + 1;
    clauses.push(`legacy_game_id IN (${placeholders(gameIds, offset)})`);
    bindings.push(...gameIds);
  }
  if (internalGameIds.length && INTERNAL_GAME_ID_SCOPED_TABLES.has(table)) {
    const offset = bindings.length + 1;
    clauses.push(`internal_game_id IN (${placeholders(internalGameIds, offset)})`);
    bindings.push(...internalGameIds);
  }
  if (ATTEMPT_ROW_TABLES.has(table) && (gameIds.length || internalGameIds.length)) {
    const attemptClauses = [];
    if (internalGameIds.length) {
      const offset = bindings.length + 1;
      attemptClauses.push(`internal_game_id IN (${placeholders(internalGameIds, offset)})`);
      bindings.push(...internalGameIds);
    }
    if (gameIds.length) {
      const offset = bindings.length + 1;
      attemptClauses.push(`game_id IN (${placeholders(gameIds, offset)})`);
      bindings.push(...gameIds);
    }
    clauses.push(`attempt_id IN (SELECT attempt_id FROM score_attempts WHERE ${attemptClauses.join(" OR ")})`);
  }
  if (table === "user_achievements") {
    clauses.push("(created_at < ?1 OR earned_at < ?1)");
    bindings.push(RELEASE_CUTOFF_ISO);
  }
  if (!clauses.length) {
    // An empty pre-beta target is a valid no-op after the release boundary has
    // already been cleared.  Keep every game-scoped count explicitly empty;
    // never turn a missing target into an unbounded predicate.
    if (GAME_SCOPED_TABLES.has(table) && (!gameIds.length && !internalGameIds.length || INTERNAL_GAME_ID_SCOPED_TABLES.has(table) && !internalGameIds.length)) {
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
      WHERE game_date < ?2
         OR (game_date = ?2 AND datetime(start_time) < datetime(?1))
      UNION ALL
      SELECT ranking_games.internal_game_id, ranking_games.game_id, ranking_games.game_date,
            games.start_time, 'scored_ranking_game' AS source
       FROM ranking_games
      LEFT JOIN games ON games.internal_game_id = ranking_games.internal_game_id
      WHERE COALESCE(games.game_date, ranking_games.game_date) < ?2
         OR (COALESCE(games.game_date, ranking_games.game_date) = ?2
             AND datetime(COALESCE(games.start_time, ranking_games.updated_at, ranking_games.created_at)) < datetime(?1))
      UNION ALL
      SELECT predictions.internal_game_id, predictions.game_id, predictions.game_date,
             NULL AS start_time, 'pre_beta_prediction' AS source
        FROM predictions
        LEFT JOIN games ON games.internal_game_id = predictions.internal_game_id
       WHERE COALESCE(games.game_date, predictions.game_date) < ?2
          OR (COALESCE(games.game_date, predictions.game_date) = ?2
              AND datetime(COALESCE(games.start_time, predictions.updated_at, predictions.submitted_at)) < datetime(?1))`
  ).bind(RELEASE_CUTOFF_ISO, RELEASE_CUTOFF_DATE).all();
  const rawRows = rowsOf(result);
  if (rawRows.some((row) => !String(row?.game_id || row?.internal_game_id || "").trim())) {
    throw new Error("PRE_BETA_PURGE_TARGET_IDS_UNAVAILABLE");
  }
  const rows = uniqueTargetRows(rawRows);
  const gameIds = uniqueStrings(rawRows.map((row) => row.game_id));
  const internalGameIds = uniqueStrings(rawRows.map((row) => row.internal_game_id));

  if (internalGameIds.length) {
    for (const internalIds of chunk(internalGameIds)) {
      const identifiers = await db.prepare(
        `SELECT identifier_value FROM game_identifiers
          WHERE internal_game_id IN (${placeholders(internalIds)})`
      ).bind(...internalIds).all();
      gameIds.push(...rowsOf(identifiers).map((row) => row.identifier_value));
    }
  }
  return {
    rows,
    gameIds: uniqueStrings(gameIds),
    internalGameIds: uniqueStrings(internalGameIds)
  };
}

function isStaleJob(row, now = Date.now()) {
  const status = String(row?.status || "");
  if (status === "claimed") {
    const leaseExpiresAt = Date.parse(String(row?.lease_expires_at || ""));
    return Number.isFinite(leaseExpiresAt) && leaseExpiresAt < now;
  }
  if (status === "pending") {
    const scheduledAt = Date.parse(String(row?.scheduled_at || row?.scheduled_slot_at || ""));
    return Number.isFinite(scheduledAt) && scheduledAt < now;
  }
  if (status === "retry_wait") {
    const retryAt = Date.parse(String(row?.next_retry_at || row?.next_attempt_at || ""));
    return Number.isFinite(retryAt) && retryAt < now;
  }
  return false;
}

function summarizeActiveJobs(rows, targetInternalGameIds, now = Date.now()) {
  const targetIds = new Set(targetInternalGameIds);
  const target = rows.filter((row) => targetIds.has(String(row?.internal_game_id || "")));
  const nonTarget = rows.filter((row) => !targetIds.has(String(row?.internal_game_id || "")));
  return {
    total: rows.length,
    staleTarget: target.filter((row) => isStaleJob(row, now)).length,
    blockingTarget: target.filter((row) => !isStaleJob(row, now)).length,
    nonTarget: nonTarget.length
  };
}

async function getActiveJobCount(db, internalGameIds) {
  const [gameJobResult, gameJobRunResult] = await Promise.all([
    db.prepare("SELECT id, internal_game_id, status, scheduled_at, next_retry_at, lease_expires_at FROM game_jobs_v3 WHERE status IN ('pending', 'claimed', 'retry_wait')").bind().all(),
    db.prepare("SELECT id, internal_game_id, status, scheduled_slot_at, next_attempt_at, lease_expires_at FROM game_job_runs WHERE status IN ('pending', 'claimed', 'running', 'retry_wait')").bind().all()
  ]);
  const now = Date.now();
  const gameJobs = summarizeActiveJobs(rowsOf(gameJobResult), internalGameIds, now);
  const gameJobRuns = summarizeActiveJobs(rowsOf(gameJobRunResult), internalGameIds, now);
  return {
    gameJobs: gameJobs.total - gameJobs.nonTarget,
    gameJobRuns: gameJobRuns.total - gameJobRuns.nonTarget,
    staleGameJobs: gameJobs.staleTarget,
    staleGameJobRuns: gameJobRuns.staleTarget,
    blockingGameJobs: gameJobs.blockingTarget,
    blockingGameJobRuns: gameJobRuns.blockingTarget,
    nonTargetGameJobs: gameJobs.nonTarget,
    nonTargetGameJobRuns: gameJobRuns.nonTarget
  };
}

async function countScopedTable(db, table, target) {
  const scopes = [];
  if (GAME_ID_SCOPED_TABLES.has(table) || LEGACY_GAME_ID_SCOPED_TABLES.has(table) || ATTEMPT_ROW_TABLES.has(table)) {
    for (const gameIds of chunk(target.gameIds)) scopes.push(scopedPredicate(table, gameIds, []));
  }
  if (INTERNAL_GAME_ID_SCOPED_TABLES.has(table) || ATTEMPT_ROW_TABLES.has(table)) {
    for (const internalGameIds of chunk(target.internalGameIds)) scopes.push(scopedPredicate(table, [], internalGameIds));
  }
  if (!scopes.length) scopes.push(scopedPredicate(table, [], []));

  // Several allowlisted tables can match through both legacy and internal IDs.
  // Read only rowids from each bounded query and deduplicate in memory so the
  // dry-run COUNT remains equivalent to the single OR predicate without ever
  // exceeding D1's 100-bind limit.
  const rowIds = new Set();
  for (const scope of scopes) {
    if (scope.bindings.length > MAX_D1_BINDINGS) {
      throw new Error(`PRE_BETA_PURGE_BINDINGS_LIMIT:${table}`);
    }
    const result = await db.prepare(`SELECT rowid AS __purge_rowid FROM ${table} WHERE ${scope.where}`).bind(...scope.bindings).all();
    for (const row of rowsOf(result)) rowIds.add(String(row.__purge_rowid));
  }
  return rowIds.size;
}

async function getCounts(db, target) {
  const counts = {};
  for (const table of PRE_BETA_PURGE_TABLES) {
    counts[table] = await countScopedTable(db, table, target);
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
  const scopes = [];
  if (GAME_ID_SCOPED_TABLES.has(table) || LEGACY_GAME_ID_SCOPED_TABLES.has(table) || ATTEMPT_ROW_TABLES.has(table)) {
    for (const gameIds of chunk(target.gameIds)) scopes.push([gameIds, []]);
  }
  if (INTERNAL_GAME_ID_SCOPED_TABLES.has(table) || ATTEMPT_ROW_TABLES.has(table)) {
    for (const internalGameIds of chunk(target.internalGameIds)) scopes.push([[], internalGameIds]);
  }
  if (!scopes.length) scopes.push([[], []]);
  let deleted = 0;
  for (const [gameIds, internalGameIds] of scopes) {
    const scope = scopedPredicate(table, gameIds, internalGameIds);
    const result = await db.prepare(`DELETE FROM ${table} WHERE ${scope.where}`).bind(...scope.bindings).run();
    deleted += integer(result?.meta?.changes);
  }
  return deleted;
}

export async function executePreBetaPurge(db, { planHash, confirmation, maintenanceWindowConfirmed } = {}) {
  if (String(confirmation || "") !== CONFIRMATION) {
    throw new Error("PRE_BETA_PURGE_CONFIRMATION_REQUIRED");
  }
  const plan = await buildPlan(db);
  if (String(planHash || "") !== plan.planHash) {
    // Orphan legacy evidence can disappear together with the first run's
    // scoped rows, so it is not always possible to reconstruct an identical
    // target plan on a retry.  A changed hash is still rejected whenever any
    // purgeable rows or active jobs remain; only an already-empty scope is a
    // harmless idempotent no-op.
    if (plan.totalRows === 0
      && !plan.activeJobs.gameJobs && !plan.activeJobs.gameJobRuns
      && !plan.activeJobs.nonTargetGameJobs && !plan.activeJobs.nonTargetGameJobRuns) {
      return {
        ...plan,
        deleted: Object.fromEntries(PRE_BETA_PURGE_TABLES.map((table) => [table, 0])),
        deletedTotal: 0,
        remaining: plan.counts,
        remainingTotal: 0,
        completedAt: new Date().toISOString()
      };
    }
    throw new Error("PRE_BETA_PURGE_PLAN_CHANGED");
  }
  if (plan.activeJobs.blockingGameJobs || plan.activeJobs.blockingGameJobRuns
    || plan.activeJobs.nonTargetGameJobs || plan.activeJobs.nonTargetGameJobRuns) {
    throw new Error("PRE_BETA_PURGE_ACTIVE_JOBS");
  }
  if ((plan.activeJobs.staleGameJobs || plan.activeJobs.staleGameJobRuns) && maintenanceWindowConfirmed !== true) {
    throw new Error("PRE_BETA_PURGE_MAINTENANCE_WINDOW_REQUIRED");
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
