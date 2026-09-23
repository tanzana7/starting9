import { V3_JOB_TYPES, createV3Error, normalizeV3InternalGameId } from "./constants.js";
import { assertV3Transition, getV3GameEffectiveStartAt, getV3NpbIdentityState } from "./domain.js";
import { evaluateCanonicalArtifactsFromDb } from "./canonical-artifact-evaluator.js";

// D1 persistence boundary for V3 games, states, identity hydration, and jobs.
// Normal Cron discovery intentionally retains only a short historical window.
// Older corrections remain discoverable through the explicit manual-action or
// canonical-recovery predicates below, but a stale ranked game must not keep
// re-entering the hot path indefinitely when its publication artifact is bad.
const V3_AUTOMATION_HISTORICAL_LOOKBACK_DAYS = 2;

export async function getV3SchemaState(db) {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'game_jobs_v3', 'game_automation_v3_state')").all();
  const names = new Set((rows.results || []).map((row) => row.name));
  return {
    games: names.has("games"),
    jobs: names.has("game_jobs_v3"),
    state: names.has("game_automation_v3_state"),
    ready: names.has("games") && names.has("game_jobs_v3") && names.has("game_automation_v3_state")
  };
}

export async function listV3Games(db, now = new Date(), options = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const date = new Date(current.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const scopedInternalGameId = String(options?.internalGameId || "").trim().slice(0, 128);
  const requestedLimit = Number(options?.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(50, requestedLimit)
    : null;
  const recentFirst = options?.recentFirst === true;
  const includeRecentHistory = options?.includeRecentHistory === true;
  const prioritizeDue = options?.prioritizeDue === true;
  let columns = new Set();
  try {
    const schema = await db.prepare("PRAGMA table_info(games)").all();
    columns = new Set((schema.results || []).map((row) => String(row.name || "")));
  } catch {
    // Older adapters do not expose PRAGMA; the base V3 projection remains valid.
  }
  const optionalColumns = ["created_at", "npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"]
    .filter((column) => columns.has(column));

  const gameColumns = `games.internal_game_id, games.game_date, games.start_time, games.home_team, games.away_team,
            games.npb_game_code${optionalColumns.length ? `, ${optionalColumns.map((column) => `games.${column}`).join(", ")}` : ""},
            games.game_status, games.is_active, games.deleted_at`;
  const excludedGameStatusSql = "'cancelled', 'canceled', 'postponed', 'no_game', 'service_unavailable', 'excluded'";
  const unfinishedWorkflowStateSql = "'scheduled', 'probable_starter_ready', 'roster_ready', 'prediction_closed', 'lineup_ready', 'scored'";
  const excludedWorkflowStateSql = "'cancelled', 'canceled', 'postponed', 'no_game', 'service_unavailable', 'excluded'";
  const adminHistoryExcludedWorkflowStateSql = "'cancelled', 'canceled', 'postponed', 'no_game', 'service_unavailable', 'excluded'";
  const fightersGameSql = `(LOWER(COALESCE(games.home_team, '')) IN ('f', 'fighters')
             OR LOWER(COALESCE(games.away_team, '')) IN ('f', 'fighters'))`;
  let hasGameJobsTable = false;
  try {
    const jobTable = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_jobs_v3' LIMIT 1"
    ).first();
    hasGameJobsTable = Boolean(jobTable?.name);
  } catch {
    hasGameJobsTable = false;
  }
  const correctionPendingSql = hasGameJobsTable
    ? `EXISTS (
        SELECT 1 FROM game_jobs_v3 AS correction_job
         WHERE correction_job.internal_game_id = games.internal_game_id
           AND correction_job.job_type = 'score'
           AND correction_job.status IN ('pending', 'claimed', 'retry_wait')
      )`
    : "0";
  let hasCanonicalLineups = false;
  if (hasGameJobsTable) {
    try {
      const row = await db.prepare("PRAGMA table_info(game_lineups)").all();
      hasCanonicalLineups = (row.results || []).some((column) => column.name === "final_lineup_revision_id");
    } catch { /* Legacy adapters retain open-job discovery. */ }
  }
  let hasScoringRevisions = false;
  if (hasGameJobsTable) {
    try {
      const row = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_scoring_revisions' LIMIT 1"
      ).first();
      hasScoringRevisions = Boolean(row?.name);
    } catch { /* Legacy adapters retain open-job discovery. */ }
  }
  // A finalized historical correction can outlive a failed/missing score job.
  // This is only a candidate signal; canonical validity and current scoring
  // lineage are checked by the shared evaluator before returning the game.
  const correctionRecoverySql = hasCanonicalLineups && hasScoringRevisions
    ? `EXISTS (SELECT 1 FROM game_lineups AS corrected
                 WHERE corrected.internal_game_id = games.internal_game_id
                   AND corrected.final_lineup_revision_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM game_jobs_v3 AS previous_score
                    WHERE previous_score.internal_game_id = games.internal_game_id
                      AND previous_score.job_type = 'score' AND previous_score.status = 'completed')
       AND NOT EXISTS (
         SELECT 1 FROM game_scoring_revisions AS active_score
          JOIN game_lineups AS current_lineup
            ON current_lineup.internal_game_id = games.internal_game_id
           AND current_lineup.final_lineup_revision_id = active_score.lineup_revision_id
         WHERE active_score.internal_game_id = games.internal_game_id
           AND active_score.is_active = 1
           AND active_score.status = 'completed')`
    : "0";
  const enrichedParams = includeRecentHistory ? [] : [date];
  // The scheduled runner uses a bounded, deadline-first window.  Keep the
  // priority values as bound parameters so the general-purpose admin query
  // remains safe and the current-day comparison uses JST rather than the
  // worker's UTC clock.
  const priorityDateParam = prioritizeDue ? enrichedParams.push(date) : null;
  const priorityDeadlineParam = prioritizeDue
    ? enrichedParams.push(new Date(current.getTime() + 60 * 60 * 1000).toISOString())
    : null;
  const scopedConditions = [];
  if (scopedInternalGameId) {
    enrichedParams.push(scopedInternalGameId);
    scopedConditions.push(`games.internal_game_id = ?${enrichedParams.length}`);
  }
  const scopedFilterSql = scopedConditions.length ? ` AND ${scopedConditions.join(" AND ")}` : "";
  const orderSql = prioritizeDue
    ? `CASE
         WHEN games.game_date = ?${priorityDateParam} AND games.start_time <= ?${priorityDeadlineParam} THEN 0
         WHEN games.game_date = ?${priorityDateParam} THEN 1
         WHEN games.start_time <= ?${priorityDeadlineParam} THEN 2
         ELSE 3
       END,
       ${recentFirst ? "games.start_time DESC, games.internal_game_id DESC" : "games.start_time, games.internal_game_id"}`
    : recentFirst
      ? "games.start_time DESC, games.internal_game_id DESC"
      : "games.start_time, games.internal_game_id";
  const publicationStatus = "CASE WHEN lineup.publication_status = 'published' OR ranking.publication_status = 'published' THEN 'published' ELSE COALESCE(lineup.publication_status, ranking.publication_status, '') END";
  const publishedAt = "COALESCE(lineup.published_at, ranking.published_at)";
  const enrichedLimitSql = limit
    ? ` LIMIT ?${enrichedParams.push(limit)}`
    : "";
  const publicationFilterSql = includeRecentHistory
    ? ""
    : `AND (${publishedAt} IS NULL
             AND LOWER(COALESCE(${publicationStatus}, '')) <> 'published'
           OR (${correctionRecoverySql}))`;
  const discoveryFilterSql = includeRecentHistory
    ? `AND ${fightersGameSql}
           AND LOWER(COALESCE(workflow.state, '')) NOT IN (${adminHistoryExcludedWorkflowStateSql})`
    : `AND (
             games.game_date >= date(?1)
             OR (
               games.game_date >= date(?1, '-${V3_AUTOMATION_HISTORICAL_LOOKBACK_DAYS} day')
               AND LOWER(COALESCE(workflow.state, '')) IN (${unfinishedWorkflowStateSql}, 'ranked')
             )
             OR (
                LOWER(COALESCE(workflow.state, '')) = 'manual_action_required'
               AND (${correctionPendingSql} OR (${correctionRecoverySql}))
             )
             OR (${correctionRecoverySql})
           )
           AND LOWER(COALESCE(workflow.state, '')) NOT IN (${excludedWorkflowStateSql})`;
  let result;
  try {
    // Keep unfinished games discoverable after startAt. The current-day arm
    // preserves future scheduling, while the state/publication arm retains a
    // delayed run until it is actually published.
    result = await db.prepare(
      `SELECT ${gameColumns}, workflow.state AS workflow_state,
              ${correctionPendingSql} AS correction_job_open,
              (${correctionRecoverySql}) AS correction_recovery_candidate,
              ${publicationStatus} AS publication_status, ${publishedAt} AS published_at
         FROM games
         LEFT JOIN game_automation_v3_state AS workflow
           ON workflow.internal_game_id = games.internal_game_id
         LEFT JOIN game_lineups AS lineup
           ON lineup.internal_game_id = games.internal_game_id
         LEFT JOIN ranking_games AS ranking
           ON ranking.internal_game_id = games.internal_game_id
        WHERE games.internal_game_id IS NOT NULL AND games.internal_game_id <> ''
           AND games.is_active = 1
           AND games.deleted_at IS NULL
           AND LOWER(COALESCE(games.game_status, '')) NOT IN (${excludedGameStatusSql})
           ${publicationFilterSql}
           ${discoveryFilterSql}
           ${scopedFilterSql}
         ORDER BY ${orderSql}${enrichedLimitSql}`
    ).bind(...enrichedParams).all();
  } catch (error) {
    // Older adapters/databases may not expose the publication joins. Keep
    // unfinished workflow states discoverable in the fallback as well; a
    // delayed score/ranking/publication must not disappear just because the
    // richer artifact query is temporarily unavailable.
    console.warn(`[V3_DISCOVERY_FALLBACK] ${JSON.stringify({
      mode: "workflow_state_fallback",
      asOfDateJst: date,
      historicalUnpublishedRetention: true,
      reason: String(error?.message || "enriched_query_failed").slice(0, 200)
    })}`);
    const fallbackParams = includeRecentHistory ? [] : [date];
    if (prioritizeDue) {
      fallbackParams.push(date, new Date(current.getTime() + 60 * 60 * 1000).toISOString());
    }
    const fallbackConditions = [];
    if (scopedInternalGameId) {
      fallbackParams.push(scopedInternalGameId);
      fallbackConditions.push(`games.internal_game_id = ?${fallbackParams.length}`);
    }
    const fallbackFilterSql = fallbackConditions.length ? ` AND ${fallbackConditions.join(" AND ")}` : "";
    const fallbackLimitSql = limit
      ? ` LIMIT ?${fallbackParams.push(limit)}`
      : "";
    try {
      result = await db.prepare(
        `SELECT ${gameColumns}, workflow.state AS workflow_state,
                ${correctionPendingSql} AS correction_job_open,
                (${correctionRecoverySql}) AS correction_recovery_candidate
           FROM games
           LEFT JOIN game_automation_v3_state AS workflow
             ON workflow.internal_game_id = games.internal_game_id
          WHERE games.internal_game_id IS NOT NULL AND games.internal_game_id <> ''
             AND games.is_active = 1
             AND games.deleted_at IS NULL
             AND LOWER(COALESCE(games.game_status, '')) NOT IN (${excludedGameStatusSql})
             ${discoveryFilterSql}
             ${fallbackFilterSql}
          ORDER BY ${orderSql}${fallbackLimitSql}`
      ).bind(...fallbackParams).all();
    } catch (fallbackError) {
      // Very old adapters may not have the V3 state table at all. Preserve
      // their legacy current-day contract rather than failing discovery; the
      // state-aware fallback above is used whenever the table exists.
      if (!/no such table.*game_automation_v3_state/i.test(String(fallbackError?.message || ""))) throw fallbackError;
      const legacyFallbackParams = includeRecentHistory ? [] : [date];
      if (prioritizeDue) {
        legacyFallbackParams.push(date, new Date(current.getTime() + 60 * 60 * 1000).toISOString());
      }
      const legacyFallbackFilter = includeRecentHistory
        ? `AND ${fightersGameSql.replaceAll("games.", "")}`
        : "AND games.game_date >= date(?1)";
      result = await db.prepare(
        `SELECT ${gameColumns}
           FROM games
          WHERE games.internal_game_id IS NOT NULL AND games.internal_game_id <> ''
             AND games.is_active = 1
             AND games.deleted_at IS NULL
             AND LOWER(COALESCE(games.game_status, '')) NOT IN (${excludedGameStatusSql})
             ${legacyFallbackFilter}
             ${scopedFilterSql}
          ORDER BY ${orderSql}${limit ? ` LIMIT ?${legacyFallbackParams.push(limit)}` : ""}`
      ).bind(...legacyFallbackParams).all();
    }
  }
  const eligibleRows = [];
  for (const row of result.results || []) {
    const historicalManual = !includeRecentHistory && row.game_date < date
      && String(row.workflow_state || "").toLowerCase() === "manual_action_required";
    if (historicalManual) {
      const canonical = await evaluateCanonicalArtifactsFromDb(db, row.internal_game_id);
      if (canonical.available === true && (canonical.aggregate.lineupReady !== true
        || canonical.aggregate.fullyPublished === true)) continue;
      if (!row.correction_job_open && (canonical.available !== true
        || canonical.aggregate.scoringReady === true)) continue;
    }
    eligibleRows.push(row);
  }
  const baseGames = eligibleRows.map((row) => ({
    internalGameId: row.internal_game_id,
    gameDate: row.game_date,
    startAt: row.start_time,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    npbGameCode: row.npb_game_code || null,
    npbGameUrl: row.npb_game_url || null,
    sourceScheduleKey: row.source_schedule_key || null,
    npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
    npbIdentityResolvedAt: row.npb_identity_resolved_at || null,
    npbIdentitySource: row.npb_identity_source || null,
    npbIdentityState: getV3NpbIdentityState({
      npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
      startAt: row.start_time
    }, current),
    createdAt: row.created_at || null,
    workflowState: row.workflow_state || null,
    correctionRecoveryCandidate: Number(row.correction_recovery_candidate || 0) === 1,
    publicationStatus: row.publication_status || "",
    publishedAt: row.published_at || null,
    isPublished: row.publication_status === "published" || Boolean(row.published_at),
    gameStatus: row.game_status,
    isActive: row.is_active,
    deletedAt: row.deleted_at
  }));
  const hydratedGames = await Promise.all(baseGames.map((game) => hydrateV3GameIdentityFromIdentifiers(db, game)));
  return hydratedGames.map((game) => ({
    ...game,
    npbIdentityState: getV3NpbIdentityState(game, current)
  }));
}

// The auxiliary list is intentionally bounded for CPU safety. This targeted
// lookup guarantees that the next Fighters game is considered even when
// unrelated games fill that bounded list; it never calls an external source.
export async function findV3ProbableStarterStartCheckGame(db, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(current);
  let columns = new Set();
  try {
    const schema = await db.prepare("PRAGMA table_info(games)").all();
    columns = new Set((schema.results || []).map((row) => String(row.name || "")));
  } catch {
    // The scheduled timestamp remains authoritative on older adapters.
  }
  const actualColumn = ["actual_start_at", "started_at", "game_started_at", "first_pitch_at"]
    .find((column) => columns.has(column));
  const actualSelect = actualColumn ? `, games.${actualColumn} AS actual_start_at` : ", NULL AS actual_start_at";
  const excluded = "'cancelled', 'canceled', 'postponed', 'no_game', 'service_unavailable', 'excluded'";
  const result = await db.prepare(
    `SELECT games.internal_game_id, games.game_date, games.start_time,
            games.home_team, games.away_team, games.game_status,
            games.is_active, games.deleted_at${actualSelect}
       FROM games
      WHERE games.internal_game_id IS NOT NULL
        AND games.internal_game_id <> ''
        AND games.game_date >= ?1
        AND games.is_active = 1
        AND games.deleted_at IS NULL
        AND LOWER(COALESCE(games.game_status, '')) NOT IN (${excluded})
        AND (LOWER(COALESCE(games.home_team, '')) IN ('f', 'fighters')
          OR LOWER(COALESCE(games.away_team, '')) IN ('f', 'fighters'))
      ORDER BY games.game_date, games.start_time, games.internal_game_id
      LIMIT 24`
  ).bind(today).all();
  const candidates = (result.results || []).map((row) => ({
    internalGameId: row.internal_game_id,
    gameDate: row.game_date,
    startAt: row.start_time,
    actualStartAt: row.actual_start_at || null,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    gameStatus: row.game_status,
    isActive: row.is_active,
    deletedAt: row.deleted_at
  })).sort((left, right) => {
    const leftAt = getV3GameEffectiveStartAt(left)?.getTime() || Number.MAX_SAFE_INTEGER;
    const rightAt = getV3GameEffectiveStartAt(right)?.getTime() || Number.MAX_SAFE_INTEGER;
    return leftAt - rightAt || String(left.internalGameId).localeCompare(String(right.internalGameId));
  });
  const todayStarted = candidates
    .filter((game) => String(game.gameDate || "").slice(0, 10) === today)
    .map((game) => ({ game, startAt: getV3GameEffectiveStartAt(game) }))
    .filter(({ startAt }) => startAt && startAt.getTime() <= current.getTime())
    .sort((left, right) => right.startAt.getTime() - left.startAt.getTime());
  const currentGame = todayStarted[0];
  if (!currentGame) return null;
  const nextGame = candidates
    .map((game) => ({ game, startAt: getV3GameEffectiveStartAt(game) }))
    .filter(({ startAt }) => startAt && startAt.getTime() > currentGame.startAt.getTime())
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())[0];
  if (!nextGame) return null;
  return {
    ...nextGame.game,
    probableStarterStartCheckAt: currentGame.startAt.toISOString()
  };
}

// Cancellation reconciliation must not reuse the normal automation discovery
// query. That query intentionally excludes terminal game statuses and joins
// publication/correction artifacts for formal planning, so using it here
// both misses official cancellations and performs unnecessary work every
// Cron tick. The frequent pass is limited to the nearby JST schedule window;
// the caller can request the historical pass at a low-frequency maintenance
// boundary to preserve detection of late official corrections.
export async function listOfficialCancellationCandidates(db, now = new Date(), {
  includeHistorical = false,
  lookbackDays = 2,
  lookaheadDays = 2,
  limit = 50
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return [];
  const date = new Date(current.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const params = [];
  const dateFilter = includeHistorical
    ? ""
    : "AND games.game_date BETWEEN date(?1, ?2) AND date(?1, ?3)";
  if (!includeHistorical) {
    params.push(
      date,
      `-${Math.max(0, Number(lookbackDays) || 0)} day`,
      `+${Math.max(0, Number(lookaheadDays) || 0)} day`
    );
  }
  const limitSql = includeHistorical ? "" : ` LIMIT ?${params.push(boundedLimit)}`;
  const result = await db.prepare(
    `SELECT games.internal_game_id, games.game_date, games.start_time,
            games.home_team, games.away_team, games.npb_game_code,
            games.game_status, games.is_active, games.deleted_at,
            workflow.state AS workflow_state
       FROM games
       LEFT JOIN game_automation_v3_state AS workflow
         ON workflow.internal_game_id = games.internal_game_id
      WHERE games.internal_game_id IS NOT NULL
        AND games.internal_game_id <> ''
        AND games.is_active = 1
        AND games.deleted_at IS NULL
        AND LOWER(COALESCE(games.game_status, '')) IN
          ('cancelled', 'canceled', 'postponed', 'service_unavailable')
        ${dateFilter}
      ORDER BY games.game_date DESC, games.start_time DESC, games.internal_game_id
      ${limitSql}`
  ).bind(...params).all();
  return (result.results || []).map((row) => ({
    internalGameId: row.internal_game_id,
    gameDate: row.game_date,
    startAt: row.start_time,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    npbGameCode: row.npb_game_code || null,
    gameStatus: row.game_status,
    workflowState: row.workflow_state || null,
    isActive: row.is_active,
    deletedAt: row.deleted_at
  }));
}

function normalizeV3NpbGameCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(code) ? code : "";
}

function buildV3NpbGameUrl(gameDate, gameCode) {
  const date = String(gameDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const code = normalizeV3NpbGameCode(gameCode);
  if (!date || !code) return null;
  return `https://npb.jp/scores/${date[1]}/${date[2]}${date[3]}/${code}/`;
}

// Schedule sync registers NPB identity in game_identifiers before all consumers
// have necessarily copied it into games. Read that canonical registry value for
// V3 planning and lineup execution without mutating historical schedule rows.
export async function hydrateV3GameIdentityFromIdentifiers(db, game = {}) {
  const existingStatus = String(game.npbIdentityStatus || game.npb_identity_status || "").trim();
  if (existingStatus === "manually_overridden") return game;

  const internalGameId = String(game.internalGameId || game.internal_game_id || "").trim();
  if (!internalGameId) return game;
  let result;
  try {
    result = await db.prepare(
      `SELECT provider, identifier_type, identifier_value, updated_at
         FROM game_identifiers
        WHERE internal_game_id = ?1
          AND ((provider = 'npb' AND identifier_type = 'npb_game_code')
            OR (provider = 'schedule_worker' AND identifier_type = 'source_game_key'))
        ORDER BY updated_at DESC, id DESC`
    ).bind(internalGameId).all();
  } catch {
    // Older test adapters or partially migrated databases should retain the
    // normal unresolved behavior rather than blocking the V3 runner.
    return game;
  }
  const identifiers = result?.results || [];
  const codes = [...new Set(identifiers
    .filter((row) => row.provider === "npb" && row.identifier_type === "npb_game_code")
    .map((row) => normalizeV3NpbGameCode(row.identifier_value))
    .filter(Boolean))];
  if (codes.length === 0) return game;
  if (codes.length > 1) {
    return { ...game, npbIdentityStatus: "conflict", npbIdentitySource: "game_identifiers" };
  }
  const code = codes[0];
  const sourceKey = identifiers.find((row) => row.provider === "schedule_worker" && row.identifier_type === "source_game_key")?.identifier_value || null;
  const updatedAt = identifiers.find((row) => row.provider === "npb" && row.identifier_type === "npb_game_code")?.updated_at || null;
  return {
    ...game,
    npbGameCode: code,
    npbGameUrl: buildV3NpbGameUrl(game.gameDate || game.game_date, code),
    sourceScheduleKey: game.sourceScheduleKey || game.source_schedule_key || sourceKey,
    npbIdentityStatus: "resolved",
    npbIdentityResolvedAt: game.npbIdentityResolvedAt || game.npb_identity_resolved_at || updatedAt,
    npbIdentitySource: "game_identifiers"
  };
}

export async function ensureV3State(db, internalGameId, now = new Date()) {
  const id = normalizeV3InternalGameId(internalGameId);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await db.prepare(
    `INSERT INTO game_automation_v3_state
       (internal_game_id, state, version, created_at, updated_at)
     VALUES (?1, 'scheduled', 0, ?2, ?2)
     ON CONFLICT(internal_game_id) DO NOTHING`
  ).bind(id, timestamp).run();
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function transitionV3State(db, { internalGameId, from, to, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  assertV3Transition(from, to);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `UPDATE game_automation_v3_state
        SET state = ?1, version = version + 1, failure_code = ?2,
            failure_message = ?3,
            prediction_closed_at = CASE WHEN ?1 = 'prediction_closed' THEN COALESCE(prediction_closed_at, ?4) ELSE prediction_closed_at END,
            lineup_finalized_at = CASE WHEN ?1 = 'lineup_ready' THEN COALESCE(lineup_finalized_at, ?4) ELSE lineup_finalized_at END,
            ranked_at = CASE WHEN ?1 = 'ranked' THEN COALESCE(ranked_at, ?4) ELSE ranked_at END,
            published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?4) ELSE published_at END,
            excluded_at = CASE WHEN ?1 = 'excluded' THEN COALESCE(excluded_at, ?4) ELSE excluded_at END,
            updated_at = ?4
      WHERE internal_game_id = ?5 AND state = ?6`
  ).bind(to, failureCode, failureMessage, timestamp, id, from).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw createV3Error("V3_STATE_VERSION_CONFLICT", "V3状態が別の実行で更新されました。");
  }
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function createV3Job(db, { internalGameId, jobType, scheduledSlotAt, scheduledAt = scheduledSlotAt, maxAttempts = 12, source = "cron" } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  if (!V3_JOB_TYPES.includes(jobType)) throw createV3Error("V3_JOB_TYPE_INVALID", "V3ジョブ種別が不正です。");
  const slot = scheduledSlotAt instanceof Date ? scheduledSlotAt : new Date(scheduledSlotAt);
  const due = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(slot.getTime()) || Number.isNaN(due.getTime())) {
    throw createV3Error("V3_JOB_TIME_INVALID", "V3ジョブの実行時刻が不正です。");
  }
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO game_jobs_v3
       (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?6)`
  ).bind(id, jobType, due.toISOString(), slot.toISOString(), maxAttempts, timestamp).run();
  const row = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2 AND scheduled_slot_at = ?3 LIMIT 1`
  ).bind(id, jobType, slot.toISOString()).first();
  return { created: Number(result?.meta?.changes || 0) === 1, job: row, source };
}

export function monotonicV3JobTimestamp(requestedAt, ...minimumValues) {
  const requested = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  const values = [requested.getTime(), ...minimumValues.map((value) => new Date(value || "").getTime())]
    .filter((value) => Number.isFinite(value));
  return new Date(Math.max(...values)).toISOString();
}

export async function claimV3Job(db, { jobId, now = new Date(), leaseMilliseconds = 5 * 60 * 1000 } = {}) {
  const current = await db.prepare("SELECT created_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at);
  const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseMilliseconds).toISOString();
  const claimToken = `${timestamp}:${Math.random().toString(36).slice(2)}`;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'claimed', attempt_count = attempt_count + 1,
            claimed_at = ?1, lease_expires_at = ?2, claim_token = ?3, updated_at = ?1
      WHERE id = ?4 AND (
        status IN ('pending', 'retry_wait')
        OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
      )
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
        AND attempt_count < max_attempts`
  ).bind(timestamp, leaseExpiresAt, claimToken, Number(jobId)).run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  return db.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
}

export async function completeV3Job(db, { jobId, claimToken, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?2, failure_message = ?3, updated_at = ?1
      WHERE id = ?4 AND status = 'claimed' AND claim_token = ?5`
  ).bind(timestamp, failureCode, failureMessage, Number(jobId), claimToken).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function retryV3Job(db, { jobId, claimToken, attemptCount, maxAttempts, now = new Date(), errorCode, errorMessage, retryAt } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const terminal = Number(attemptCount) >= Number(maxAttempts);
  const retry = retryAt ? new Date(retryAt).toISOString() : null;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = ?1, next_retry_at = ?2, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?3, failure_message = ?4, updated_at = ?5
      WHERE id = ?6 AND status = 'claimed' AND claim_token = ?7`
  ).bind(terminal ? "failed" : "retry_wait", terminal ? null : retry, errorCode || null, errorMessage || null, timestamp, Number(jobId), claimToken).run();
  return { updated: Number(result?.meta?.changes || 0) === 1, status: terminal ? "failed" : "retry_wait" };
}

export async function listDueV3Jobs(db, now = new Date(), limit = 50, cursor = null) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const cursorScheduledAt = String(cursor?.scheduledAt || cursor?.scheduled_at || "");
  const cursorId = Number(cursor?.id);
  const hasCursor = Boolean(cursorScheduledAt) && Number.isFinite(cursorId);
  const cursorClause = hasCursor
    ? "AND (scheduled_at > ?3 OR (scheduled_at = ?3 AND id > ?4))"
    : "";
  const params = hasCursor
    ? [timestamp, boundedLimit, cursorScheduledAt, cursorId]
    : [timestamp, boundedLimit];
  const result = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE (status IN ('pending', 'retry_wait')
         OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1))
        AND scheduled_at <= ?1
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
        ${cursorClause}
      ORDER BY scheduled_at,
        CASE job_type
          WHEN 'prediction_close' THEN 0
          WHEN 'score' THEN 1
          WHEN 'ranking_rebuild' THEN 2
          WHEN 'publish' THEN 3
          ELSE 4
        END,
        id LIMIT ?2`
  ).bind(...params).all();
  return result.results || [];
}
