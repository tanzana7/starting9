import authWorker, { executeGameAutomationV3Job } from "../../auth-worker.js";
import { planMainWorkflowJobs, runGameAutomationV3 } from "../../game-automation-v3.js";
import { transitionV3State } from "../../backend/automation-v3/repository.js";
import { createContestId } from "../../backend/contest-identity.js";
import { V3_TIMING } from "../../backend/automation-v3/constants.js";
import {
  isAuthorizedFightersRehearsalResetEnvironment,
  isIsolatedTestEnvironment,
  validatePublishedScenario
} from "./isolation.js";
import { verifyS9SimuRunToken } from "./github-oidc.js";
import { assertDistinctTestTeamIdentity, testTeamFixture, TEST_TEAMS, TEST_TEAM_KEYS, TEST_TEAM_GROUPS } from "./teams.js";
import { simulatorGameDate } from "./simu-npb/source.js";

// Every request receives a separate fixture scope. No module-level mutable target can leak
// from one team's asynchronous request into another team's game, roster, or pipeline.
export function createTestTeamWorker(teamKey = "fighters", { rosterPlayers = null, internalGameId = "" } = {}) {
assertDistinctTestTeamIdentity();
const { team: targetTeam, internalGameId: fixtureGameId, playerPrefix, homeTeam, awayTeam } = testTeamFixture(teamKey);
const INTERNAL_GAME_ID = internalGameId || fixtureGameId;
const LEGACY_GAME_ID = INTERNAL_GAME_ID;
const CONTEST_ID = createContestId(INTERNAL_GAME_ID, targetTeam.key);
const E2E_ADMIN_USERNAME_PREFIX = "e2e-";
const POSITIONS = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
const CLEANUP_ORDER = Object.freeze([
  "contest_score_attempt_prediction_rows", "contest_score_attempt_test_rows",
  "contest_prediction_score_revisions", "contest_score_attempts", "contest_ranking_reflection_revisions",
  "contest_game_rescore_previews", "contest_game_rescore_jobs", "contest_game_rescore_audits",
  "contest_perfect_achievers", "contest_ranking_eligibility_history", "contest_ranking_test_predictions",
  "contest_ranking_test_game_settings", "contest_ranking_games", "contest_scoring_revisions",
  "score_attempt_prediction_rows", "score_attempt_test_rows", "score_attempts",
  "prediction_score_revisions", "ranking_reflection_revisions", "game_scoring_revisions",
  "ranking_eligibility_history", "game_rescore_audits", "game_rescore_previews", "game_rescore_jobs",
  "game_lineups", "contest_lineup_revisions", "game_lineup_revisions",
  "game_automation_v3_audit", "game_jobs_v3", "game_workflow_logs", "predictions", "ranking_games",
  "contest_automation_v3_state", "game_automation_v3_state", "game_pregame_automation", "game_roster_snapshots",
  "probable_starters", "game_identifiers", "game_schedule_change_history", "detected_game_schedule", "contest_identity_backfill_issues",
  "game_contests", "games"
]);
// The one-shot Fighters rehearsal must not use deleteScenarioRows(): that
// helper intentionally removes a whole physical-game fixture. These tables
// are contest-owned in the C-4 schema and are the only rows this reset may
// remove. Game-level schedule, identity, roster, workflow-log, and audit rows
// are deliberately excluded because they cannot be proven Fighters-only.
const REHEARSAL_CONTEST_RESET_TABLES = Object.freeze([
  "contest_score_attempt_prediction_rows", "contest_score_attempts",
  "contest_prediction_score_revisions", "contest_ranking_reflection_revisions",
  "contest_game_rescore_audits", "contest_game_rescore_jobs", "contest_game_rescore_previews",
  "contest_perfect_achievers", "contest_ranking_eligibility_history",
  "contest_ranking_test_predictions", "contest_ranking_test_game_settings",
  "contest_ranking_games", "contest_scoring_revisions", "game_lineups",
  "contest_lineup_revisions", "predictions", "game_jobs_v3", "contest_automation_v3_state"
]);
const REHEARSAL_CONTEST_SNAPSHOT_TABLES = Object.freeze([
  ...REHEARSAL_CONTEST_RESET_TABLES,
  "contest_score_attempt_test_rows"
]);

const TEST_PLAYERS = Object.freeze(Array.from({ length: 15 }, (_, index) => Object.freeze({
  playerId: `npb:${playerPrefix}${String(index + 1).padStart(4, "0")}`,
  name: `TEST ${targetTeam.shortName} Player ${String(index + 1).padStart(2, "0")}`,
  number: String(index + 1),
  uniformNumber: String(index + 1),
  position: index % 3 === 0 ? "捕手" : index % 3 === 1 ? "内野手" : "外野手",
  teamCode: targetTeam.key,
  teamId: targetTeam.playerTeamId
})));
const teamRoster = Array.isArray(rosterPlayers) ? Object.freeze(rosterPlayers.map((player) => {
  const suppliedTeamCode = String(player?.teamCode || "").trim();
  const suppliedTeamId = String(player?.teamId || "").trim();
  if ((suppliedTeamCode && suppliedTeamCode !== targetTeam.key)
      || (suppliedTeamId && suppliedTeamId !== targetTeam.playerTeamId)) {
    throw new Error("Test Site roster identity does not match the selected team");
  }
  return Object.freeze({
    playerId: String(player?.playerId || ""),
    name: String(player?.name || player?.playerName || "").trim(),
    number: String(player?.number ?? player?.uniformNumber ?? "").trim(),
    uniformNumber: String(player?.number ?? player?.uniformNumber ?? "").trim(),
    position: String(player?.position || "").trim(),
    teamCode: targetTeam.key,
    teamId: targetTeam.playerTeamId
  });
})) : TEST_PLAYERS;
if (teamRoster.length < 15 || teamRoster.some((player) => !player.playerId || !player.name
    || !/^\d{1,3}$/.test(player.uniformNumber) || !player.position
    || player.teamCode !== targetTeam.key || player.teamId !== targetTeam.playerTeamId)
    || new Set(teamRoster.map((player) => player.playerId)).size !== teamRoster.length
    || new Set(teamRoster.map((player) => player.uniformNumber)).size !== teamRoster.length) {
  throw new Error("Test Site roster must be complete, uniquely identified, and scoped to the selected team");
}

const TEST_SITE_ORIGINS = new Set(["https://s9simu.pages.dev", "https://starting9-test.pages.dev"]);

function jsonResponse(body, status = 200, origin = "") {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (TEST_SITE_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function currentTimes(offsetMinutes) {
  const now = new Date();
  const startAt = new Date(now.getTime() + offsetMinutes * 60_000);
  const deadlineAt = new Date(startAt.getTime() - 60 * 60_000);
  const gameDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(startAt);
  return { now: now.toISOString(), startAt: startAt.toISOString(), deadlineAt: deadlineAt.toISOString(), gameDate };
}

function createProductEnvironment(env, { automaticOfficialLineup = false, predictionClockNow = null } = {}) {
  if (!isIsolatedTestEnvironment(env)) return env;
  return {
    ...env,
    TARGET_TEAM_CONTEXT: targetTeam,
    S9SIMU_ENABLED: String(env.S9SIMU_ENABLED || "false"),
    // The legacy in-memory fixture has no simulator HTTP round trip. Expose
    // its one team-scoped roster through the same read boundary used by
    // prediction validation and admin lineup validation, so official-looking
    // temporary IDs are trusted consistently without weakening product rules.
    ...(env.S9SIMU_ENABLED === "true" ? {} : {
      TARGET_ROSTER_SOURCE: async (game) => String(game?.internalGameId || game?.internal_game_id || "") === INTERNAL_GAME_ID
        ? { ok: true, internalGameId: INTERNAL_GAME_ID, gameDate: game?.gameDate || game?.game_date || "",
            status: "captured", rosterStatus: "captured", displayRosterSource: "test_fixture",
            sourceOfTruth: "verified_snapshot", rosterUse: "verified_snapshot", freshness: "verified",
            verified: true, stale: false, playerCount: teamRoster.length, players: teamRoster }
        : { ok: false, code: "ROSTER_NOT_FOUND", players: [] }
    }),
    NPB_SOURCE: "simulator",
    S9SIMU_BASE_URL: String(env.S9SIMU_BASE_URL || "https://s9simu.pages.dev"),
    NPB_FETCH_DISABLED: "false",
    ENABLE_AUTO_ROSTER_FETCH: "true",
    ENABLE_AUTO_LINEUP_FETCH: "true",
    ...(predictionClockNow ? { TEST_CLOCK_NOW: predictionClockNow } : {}),
    // Preserve the existing Test site's semi-auto mode outside simulator E2E.
    // That E2E explicitly selects the automatic official-lineup path it tests.
    ...(automaticOfficialLineup ? { ENABLE_SEMI_AUTO_LINEUP: "false" } : {})
  };
}

async function deleteScenarioRows(db, internalGameId = INTERNAL_GAME_ID) {
  const scopedInternalGameId = String(internalGameId || "").trim();
  if (!scopedInternalGameId) throw new Error("Test cleanup requires an internal game identity");
  const [contestResult, scheduleResult] = await Promise.all([
    db.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ?1").bind(scopedInternalGameId).all(),
    db.prepare("SELECT game_id FROM detected_game_schedule WHERE internal_game_id = ?1").bind(scopedInternalGameId).all()
  ]);
  const contestIds = [...new Set((contestResult.results || []).map((row) => String(row.contest_id || "").trim()).filter(Boolean))];
  const gameIds = [...new Set([scopedInternalGameId,
    ...(scheduleResult.results || []).map((row) => String(row.game_id || "").trim())
  ].filter(Boolean))];
  const statements = [];
  for (const table of CLEANUP_ORDER) {
    // Score attempt test rows are keyed only by attempt_id. Delete them through
    // their exact game/contest-owned parent before removing that parent.
    if (table === "contest_score_attempt_test_rows" && contestIds.length) {
      const placeholders = contestIds.map((_, index) => `?${index + 2}`).join(",");
      statements.push(db.prepare(`DELETE FROM ${table} WHERE attempt_id IN (
        SELECT attempt_id FROM contest_score_attempts
         WHERE internal_game_id = ?1 OR contest_id IN (${placeholders})
      )`).bind(scopedInternalGameId, ...contestIds));
      continue;
    }
    if (table === "score_attempt_test_rows") {
      statements.push(db.prepare(`DELETE FROM ${table} WHERE attempt_id IN (
        SELECT attempt_id FROM score_attempts WHERE internal_game_id = ?1
      )`).bind(scopedInternalGameId));
      continue;
    }
    const columnsResult = await db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = new Set((columnsResult.results || []).map((row) => String(row.name)));
    if (!columns.size) continue;
    const predicates = [];
    const values = [];
    if (columns.has("internal_game_id")) {
      predicates.push(`internal_game_id = ?${values.length + 1}`);
      values.push(scopedInternalGameId);
    }
    if (columns.has("game_id") && gameIds.length) {
      const first = values.length + 1;
      predicates.push(`game_id IN (${gameIds.map((_, index) => `?${first + index}`).join(",")})`);
      values.push(...gameIds);
    }
    if (columns.has("contest_id") && contestIds.length) {
      const first = values.length + 1;
      predicates.push(`contest_id IN (${contestIds.map((_, index) => `?${first + index}`).join(",")})`);
      values.push(...contestIds);
    }
    if (!predicates.length) continue;
    statements.push(db.prepare(`DELETE FROM ${table} WHERE ${predicates.join(" OR ")}`).bind(...values));
  }
  if (statements.length) await db.batch(statements);
  return { contestIds, gameIds };
}

async function deleteScenarioAuditRows(db, { internalGameId = INTERNAL_GAME_ID, contestIds = [] } = {}) {
  // Test resets must not leave synthetic E2E audit entries carrying the
  // temporary operator identity after the corresponding game is re-seeded.
  const columnsResult = await db.prepare("PRAGMA table_info(game_automation_v3_audit)").all();
  const columns = new Set((columnsResult.results || []).map((row) => String(row.name)));
  const predicates = [];
  const values = [];
  if (columns.has("internal_game_id")) {
    predicates.push(`internal_game_id = ?${values.length + 1}`);
    values.push(String(internalGameId || "").trim());
  }
  if (columns.has("contest_id") && contestIds.length) {
    const first = values.length + 1;
    predicates.push(`contest_id IN (${contestIds.map((_, index) => `?${first + index}`).join(",")})`);
    values.push(...contestIds);
  }
  if (predicates.length) {
    await db.prepare(`DELETE FROM game_automation_v3_audit WHERE ${predicates.join(" OR ")}`).bind(...values).run();
  }
}

async function seedScenarioGame(db, offsetMinutes) {
  const { now, startAt, deadlineAt, gameDate } = currentTimes(offsetMinutes);
  const roster = JSON.stringify(teamRoster);
  const participantTeams = [homeTeam, awayTeam].map((teamKey) => TEST_TEAMS[teamKey]);
  const participantContests = participantTeams.map((team) => ({
    teamKey: team.key,
    contestId: createContestId(INTERNAL_GAME_ID, team.key)
  }));
  await db.batch([
    ...participantTeams.map((team) => db.prepare("INSERT OR IGNORE INTO contest_identity_teams (team_key) VALUES (?1)").bind(team.key)),
    db.prepare(`INSERT OR IGNORE INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?5, ?6, 'scheduled', ?4, ?4)`)
      .bind(INTERNAL_GAME_ID, gameDate, startAt, now, homeTeam, awayTeam),
    ...participantContests.map(({ contestId, teamKey }) => db.prepare(`INSERT OR IGNORE INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES (?1,?2,?3,?4)`).bind(contestId, INTERNAL_GAME_ID, teamKey, now)),
    ...participantContests.map(({ contestId }) => db.prepare(`INSERT OR IGNORE INTO contest_automation_v3_state
      (contest_id,internal_game_id,state,created_at,updated_at) VALUES (?1,?2,'scheduled',?3,?3)`)
      .bind(contestId, INTERNAL_GAME_ID, now)),
    db.prepare(`INSERT OR IGNORE INTO detected_game_schedule
      (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue,
       game_status, detected_at, schedule_checked_at, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, ?7, ?8, 'TEST-ONLY', 'TEST ONLY', 'scheduled', ?5, ?5, ?5, ?5, ?6)`)
      .bind(LEGACY_GAME_ID, `test-only:${INTERNAL_GAME_ID}`, gameDate, startAt, now, INTERNAL_GAME_ID, homeTeam, awayTeam),
    db.prepare(`INSERT OR IGNORE INTO game_automation_v3_state (internal_game_id, state, created_at, updated_at)
      VALUES (?1, 'scheduled', ?2, ?2)`)
      .bind(INTERNAL_GAME_ID, now),
    db.prepare(`INSERT OR IGNORE INTO game_roster_snapshots
      (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, 'npb-roster', 15, 'captured', ?3, ?3, ?5)`)
      .bind(LEGACY_GAME_ID, gameDate, now, roster, INTERNAL_GAME_ID),
    db.prepare(`INSERT OR IGNORE INTO game_pregame_automation
      (game_id, game_date, start_at, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, ?4, ?5)`)
      .bind(LEGACY_GAME_ID, gameDate, startAt, now, INTERNAL_GAME_ID),
    db.prepare(`INSERT OR IGNORE INTO probable_starters
      (game_id, internal_game_id, status, fetched_at, next_check_at, updated_at)
      VALUES (?1, ?2, 'unannounced', ?3, ?4, ?3)`)
      .bind(LEGACY_GAME_ID, INTERNAL_GAME_ID, now, now),
    db.prepare(`INSERT OR IGNORE INTO ranking_games
      (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at,
       game_status, is_test_game, publication_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, 'pending', 0, 'pending', ?4, ?4)`)
      .bind(LEGACY_GAME_ID, INTERNAL_GAME_ID, gameDate, now)
  ]);
  return { gameId: LEGACY_GAME_ID, internalGameId: INTERNAL_GAME_ID, gameDate, startAt, deadlineAt };
}

async function currentScenarioGame(db) {
  return db.prepare(`SELECT games.internal_game_id, games.game_date, games.start_time, games.home_team,
      games.away_team, COALESCE(contest_state.state,state.state) AS state, lineup.scoring_status, ranking.publication_status
    FROM games
    LEFT JOIN game_automation_v3_state AS state USING (internal_game_id)
    LEFT JOIN game_contests AS contest ON contest.internal_game_id = games.internal_game_id
      AND contest.target_team_key = ?2
    LEFT JOIN contest_automation_v3_state AS contest_state ON contest_state.internal_game_id = games.internal_game_id
      AND contest_state.contest_id = contest.contest_id
    LEFT JOIN game_lineups AS lineup ON lineup.internal_game_id = games.internal_game_id
      AND lineup.contest_id = contest.contest_id
    LEFT JOIN contest_ranking_games AS ranking ON ranking.internal_game_id = games.internal_game_id
      AND ranking.contest_id = contest.contest_id
    WHERE games.internal_game_id = ?1 LIMIT 1`).bind(INTERNAL_GAME_ID, targetTeam.key).first();
}

async function readRehearsalContestSnapshot(db, { internalGameId, contestId }) {
  const rowsByTable = {};
  for (const table of REHEARSAL_CONTEST_SNAPSHOT_TABLES) {
    const rows = table === "contest_score_attempt_test_rows"
      ? await db.prepare(`SELECT child.* FROM contest_score_attempt_test_rows AS child
          JOIN contest_score_attempts AS attempt ON attempt.attempt_id = child.attempt_id
         WHERE attempt.contest_id = ?1`).bind(contestId).all()
      : await db.prepare(`SELECT * FROM ${table} WHERE contest_id = ?1`).bind(contestId).all();
    rowsByTable[table] = (rows.results || []).map((row) => ({ ...row }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  const state = rowsByTable.contest_automation_v3_state[0]?.state || "scheduled";
  const publication = rowsByTable.contest_ranking_games[0]?.publication_status || null;
  const fingerprintInput = JSON.stringify({ internalGameId, contestId, rowsByTable });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    internalGameId,
    contestId,
    state,
    stateRowCount: rowsByTable.contest_automation_v3_state.length,
    publicationStatus: publication,
    predictionCount: rowsByTable.predictions.length,
    lineupCount: rowsByTable.game_lineups.length + rowsByTable.contest_lineup_revisions.length,
    scoringCount: rowsByTable.contest_scoring_revisions.length
      + rowsByTable.contest_score_attempts.length + rowsByTable.contest_score_attempt_prediction_rows.length
      + rowsByTable.contest_score_attempt_test_rows.length + rowsByTable.contest_prediction_score_revisions.length,
    rankingCount: rowsByTable.contest_ranking_reflection_revisions.length
      + rowsByTable.contest_ranking_eligibility_history.length + rowsByTable.contest_perfect_achievers.length
      + rowsByTable.contest_ranking_test_predictions.length + rowsByTable.contest_ranking_test_game_settings.length,
    publicationCount: rowsByTable.contest_ranking_games.length,
    formalJobCount: rowsByTable.game_jobs_v3.length,
    fingerprint
  };
}

async function resetFightersRehearsalContest(db, {
  internalGameId, expectedContestId, expectedSiblingContestId
}) {
  const game = await db.prepare(`SELECT games.internal_game_id, games.game_date, games.start_time,
      COALESCE((SELECT identifier_value FROM game_identifiers
        WHERE internal_game_id = games.internal_game_id AND provider = 'npb'
          AND identifier_type = 'npb_game_code'
        ORDER BY updated_at DESC, id DESC LIMIT 1), games.npb_game_code) AS provider_game_id
    FROM games WHERE games.internal_game_id = ?1 LIMIT 1`).bind(internalGameId).first();
  const identityFailure = !game ? "game_missing"
    : game.provider_game_id !== "g-t-4" ? "provider_game_code_mismatch"
      : game.game_date !== "2026-10-25" ? "game_date_mismatch"
        : Date.parse(String(game.start_time || "")) !== Date.parse("2026-10-25T06:00:00.000Z")
          ? "start_time_mismatch" : "";
  if (identityFailure) {
    return { ok: false, status: 409, code: "REHEARSAL_GAME_IDENTITY_MISMATCH", reason: identityFailure };
  }
  const contests = await db.prepare(`SELECT contest_id, target_team_key FROM game_contests
    WHERE internal_game_id = ?1 ORDER BY target_team_key`).bind(internalGameId).all();
  const byTeam = new Map((contests.results || []).map((row) => [String(row.target_team_key), String(row.contest_id)]));
  if (byTeam.size !== 2 || !byTeam.has("fighters") || !byTeam.has("hawks")
      || byTeam.get("fighters") !== expectedContestId || byTeam.get("hawks") !== expectedSiblingContestId) {
    return { ok: false, status: 409, code: "REHEARSAL_CONTEST_IDENTITY_MISMATCH" };
  }

  const targetBefore = await readRehearsalContestSnapshot(db, { internalGameId, contestId: expectedContestId });
  const siblingBefore = await readRehearsalContestSnapshot(db, { internalGameId, contestId: expectedSiblingContestId });
  if (targetBefore.stateRowCount !== 1 || siblingBefore.stateRowCount !== 1) {
    return { ok: false, status: 409, code: "REHEARSAL_CONTEST_STATE_MISSING" };
  }
  if (siblingBefore.state !== "published" || siblingBefore.publicationStatus !== "published"
      || siblingBefore.publicationCount !== 1) {
    return { ok: false, status: 409, code: "PUBLISHED_SIBLING_REQUIRED", siblingBefore };
  }

  // Verify the reset schema before the first write. In particular, do not
  // fall back to internal_game_id when a table cannot prove contest ownership.
  for (const table of REHEARSAL_CONTEST_RESET_TABLES) {
    const columns = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!(columns.results || []).some((column) => column.name === "contest_id")) {
      return { ok: false, status: 500, code: "REHEARSAL_RESET_SCOPE_UNAVAILABLE", table };
    }
  }

  const statements = [
    // D1 batch is transactional. This one-shot capability intentionally resets
    // a published Fighters contest, but rechecks exact team/contest ownership
    // and the published Hawks sibling in the transaction before deleting rows.
    // The invalid sentinel violates the state CHECK and rolls back the batch if
    // those identities changed after the read-only preflight.
    db.prepare(`UPDATE contest_automation_v3_state
      SET state = CASE WHEN EXISTS (SELECT 1 FROM game_contests AS target
          WHERE target.contest_id = ?1 AND target.internal_game_id = ?2
            AND target.target_team_key = 'fighters')
        AND EXISTS (SELECT 1 FROM game_contests AS sibling
          WHERE sibling.contest_id = ?3 AND sibling.internal_game_id = ?2
            AND sibling.target_team_key = 'hawks')
        AND EXISTS (SELECT 1 FROM contest_automation_v3_state AS sibling_state
          WHERE sibling_state.contest_id = ?3 AND sibling_state.internal_game_id = ?2
            AND sibling_state.state = 'published')
        AND EXISTS (SELECT 1 FROM contest_ranking_games AS sibling_publication
          WHERE sibling_publication.contest_id = ?3 AND sibling_publication.internal_game_id = ?2
            AND sibling_publication.publication_status = 'published')
        THEN 'scheduled' ELSE 'unsafe-reset' END
      WHERE contest_id = ?1 AND internal_game_id = ?2`)
      .bind(expectedContestId, internalGameId, expectedSiblingContestId),
    db.prepare(`DELETE FROM contest_score_attempt_test_rows WHERE attempt_id IN
      (SELECT attempt_id FROM contest_score_attempts WHERE contest_id = ?1)`).bind(expectedContestId),
    ...REHEARSAL_CONTEST_RESET_TABLES.map((table) => db.prepare(
      `DELETE FROM ${table} WHERE contest_id = ?1`
    ).bind(expectedContestId)),
    db.prepare(`INSERT INTO contest_automation_v3_state
      (contest_id, internal_game_id, state, created_at, updated_at)
      VALUES (?1, ?2, 'scheduled', ?3, ?3)`)
      .bind(expectedContestId, internalGameId, new Date().toISOString())
  ];
  await db.batch(statements);

  // game_automation_v3_audit and game_workflow_logs have no contest identity;
  // preserve their shared-game history rather than deleting sibling evidence.
  const targetAfter = await readRehearsalContestSnapshot(db, { internalGameId, contestId: expectedContestId });
  const siblingAfter = await readRehearsalContestSnapshot(db, { internalGameId, contestId: expectedSiblingContestId });
  if (targetAfter.state !== "scheduled" || targetAfter.predictionCount !== 0 || targetAfter.lineupCount !== 0
      || targetAfter.scoringCount !== 0 || targetAfter.rankingCount !== 0
      || targetAfter.publicationCount !== 0 || targetAfter.formalJobCount !== 0) {
    return { ok: false, status: 500, code: "REHEARSAL_TARGET_RESET_INCOMPLETE", targetAfter };
  }
  if (JSON.stringify(siblingBefore) !== JSON.stringify(siblingAfter)) {
    return { ok: false, status: 500, code: "REHEARSAL_SIBLING_CHANGED", siblingBefore, siblingAfter };
  }
  return { ok: true, targetBefore, targetAfter, siblingBefore, siblingAfter };
}

async function markManualLineupReadyScenario(db) {
  const [state, lineup, predictionClose] = await Promise.all([
    db.prepare("SELECT state FROM contest_automation_v3_state WHERE contest_id = ?1 AND internal_game_id = ?2 LIMIT 1").bind(CONTEST_ID, INTERNAL_GAME_ID).first(),
    db.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1 AND contest_id = ?2 LIMIT 1").bind(INTERNAL_GAME_ID, CONTEST_ID).first(),
    db.prepare("SELECT id FROM game_jobs_v3 WHERE internal_game_id = ?1 AND contest_id = ?2 AND job_type = 'prediction_close' AND status = 'completed' LIMIT 1").bind(INTERNAL_GAME_ID, CONTEST_ID).first()
  ]);
  if (state?.state !== "prediction_closed" || !String(lineup?.final_lineup_revision_id || "").trim() || !predictionClose?.id) {
    throw new Error("synthetic lineup-ready transition requires a closed prediction and canonical final lineup");
  }
  // Manual V4 finalize deliberately creates the canonical final artifact but
  // no lineup_finalize job. The test scenario represents that verified
  // boundary with the same optimistic state-transition helper used by V3;
  // leaving the due score job untouched lets the UI inspect lineup_ready.
  return transitionV3State(db, {
    internalGameId: INTERNAL_GAME_ID,
    contestId: CONTEST_ID,
    from: "prediction_closed",
    to: "lineup_ready",
    now: new Date()
  });
}

async function requireTestAdmin(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers({
    Cookie: request.headers.get("Cookie") || "",
    Origin: origin
  });
  const response = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/admin/me", {
    method: "GET", headers
  }), env, ctx);
  if (response.status !== 200) return false;
  const body = await response.json();
  return body?.ok === true && body?.admin === true;
}

function secureRandomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSessionCookie(response) {
  const value = response.headers.get("Set-Cookie") || "";
  const cookie = value.split(";", 1)[0];
  return cookie.startsWith("s9_session=") ? cookie : "";
}

async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function withSessionExpiry(setCookie, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return String(setCookie || "")
    .replace(/Max-Age=\d+/i, `Max-Age=${maxAge}`)
    .replace(/Expires=[^;]+/i, `Expires=${expiresAt.toUTCString()}`);
}

async function removeE2EAdmin(env, userId, username) {
  if (!/^e2e-[a-f0-9]{12}$/.test(username)) return false;
  const result = await env.AUTH_DB.prepare(
    "DELETE FROM users WHERE id = ?1 AND username = ?2 AND role IN ('user', 'admin')"
  ).bind(userId, username).run();
  return Number(result?.meta?.changes || 0) === 1;
}

function classifyE2EAdminProvisionFailure(stage, error) {
  const stageCodes = {
    existing_identity_lookup: "E2E_IDENTITY_LOOKUP_FAILED",
    register_request: "E2E_REGISTER_FAILED",
    register_response: "E2E_REGISTER_RESPONSE_FAILED",
    promote_admin: "E2E_ADMIN_PROMOTION_FAILED",
    login_request: "E2E_LOGIN_FAILED",
    login_cookie: "E2E_LOGIN_COOKIE_FAILED",
    session_hash: "E2E_SESSION_HASH_FAILED",
    stale_session_cleanup: "E2E_STALE_SESSION_CLEANUP_FAILED",
    session_expiry_update: "E2E_SESSION_EXPIRY_FAILED",
    session_readback: "E2E_SESSION_READBACK_FAILED",
    response: "E2E_RESPONSE_FAILED"
  };
  const rawCode = String(error?.code || "");
  const databaseCode = /^(?:SQLITE_(?:CONSTRAINT|ERROR|BUSY|LOCKED)(?:_[A-Z_]+)?|D1_ERROR_[A-Z_]+)$/.test(rawCode)
    ? rawCode : "";
  const message = String(error?.message || "");
  const constraint = /UNIQUE constraint failed/i.test(message) ? "UNIQUE_CONSTRAINT"
    : /FOREIGN KEY constraint failed/i.test(message) ? "FOREIGN_KEY_CONSTRAINT"
      : /NOT NULL constraint failed/i.test(message) ? "NOT_NULL_CONSTRAINT"
        : /CHECK constraint failed/i.test(message) ? "CHECK_CONSTRAINT"
          : /no such (?:table|column)/i.test(message) ? "SCHEMA_MISMATCH" : "";
  const errorClass = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(String(error?.name || ""))
    ? String(error.name) : "Error";
  return {
    ok: false,
    code: "E2E_ADMIN_PROVISION_FAILED",
    reasonCode: stageCodes[stage] || "E2E_PROVISION_STAGE_UNKNOWN",
    stage,
    errorClass,
    ...(databaseCode ? { databaseCode } : {}),
    ...(constraint ? { constraint } : {})
  };
}

async function provisionE2EAdmin(request, env, ctx, input = {}) {
  // The Pages proxy deliberately removes Origin. The signed, run-scoped GitHub
  // Actions identity is the sole bootstrap authority; the ordinary admin
  // cookie returned below then protects scenario controls for this Test run.
  const origin = request.headers.get("Origin") || "https://s9simu.pages.dev";
  if (!isIsolatedTestEnvironment(env) || origin !== "https://s9simu.pages.dev") {
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
  }

  let userId = "";
  let username = "";
  const authorization = String(request.headers.get("Authorization") || "");
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
  let runIdentity;
  let stage = "existing_identity_lookup";
  try {
    runIdentity = await verifyS9SimuRunToken(match[1]);
  } catch (error) {
    const status = error?.message === "OIDC_KEYSET_UNAVAILABLE" ? 503 : 404;
    return jsonResponse({ ok: false, code: status === 503 ? "E2E_AUTH_UNAVAILABLE" : "NOT_FOUND" }, status, origin);
  }
  try {
    if (String(input?.runId || "") !== runIdentity.runId) {
      return jsonResponse({ ok: false, code: "E2E_RUN_MISMATCH" }, 403, origin);
    }
    // Disabled replay tombstones are also durable user identities referenced by
    // historical test records. OIDC expiry already makes their proofs unusable;
    // never hard-delete them here, because D1 restricts deletion when those
    // records retain the identity and cascading would erase other history.
    username = runIdentity.username;
    const previousRun = await env.AUTH_DB.prepare(
      "SELECT id FROM users WHERE username_normalized = ?1 LIMIT 1"
    ).bind(username).first();
    if (previousRun) return jsonResponse({ ok: false, code: "E2E_RUN_REPLAYED" }, 409, origin);
    const password = secureRandomHex(32);
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    stage = "register_request";
    const register = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/auth/register", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
      body: JSON.stringify({ username, password, passwordConfirmation: password })
    }), env, ctx);
    stage = "register_response";
    const registered = await register.json();
    if (register.status !== 201 || !registered?.user?.id) {
      return jsonResponse({ ok: false, code: "E2E_ADMIN_PROVISION_FAILED" }, 409, origin);
    }
    userId = String(registered.user.id);
    stage = "promote_admin";
    const promoted = await env.AUTH_DB.prepare(
      "UPDATE users SET role = 'admin', updated_at = ?1 WHERE id = ?2 AND username = ?3 AND role = 'user'"
    ).bind(runIdentity.expiresAt, userId, username).run();
    if (Number(promoted?.meta?.changes || 0) !== 1) {
      await removeE2EAdmin(env, userId, username);
      return jsonResponse({ ok: false, code: "E2E_ADMIN_PROVISION_FAILED" }, 409, origin);
    }

    // Provisioning only grants the disposable identity. The returned cookie is
    // issued by the ordinary login endpoint and is then checked by the same
    // admin authorization boundary used by scenario mutations.
    stage = "login_request";
    const login = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
      body: JSON.stringify({ username, password })
    }), env, ctx);
    stage = "login_cookie";
    const cookie = readSessionCookie(login);
    if (login.status !== 200 || !cookie) {
      await removeE2EAdmin(env, userId, username);
      return jsonResponse({ ok: false, code: "E2E_ADMIN_LOGIN_FAILED" }, 500, origin);
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const token = cookie.slice(cookie.indexOf("=") + 1);
    stage = "session_hash";
    const sessionHash = await hashSessionToken(decodeURIComponent(token));
    stage = "stale_session_cleanup";
    await env.AUTH_DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2"
    ).bind(userId, sessionHash).run();
    stage = "session_expiry_update";
    const shortened = await env.AUTH_DB.prepare(
      "UPDATE sessions SET expires_at = ?1 WHERE user_id = ?2 AND token_hash = ?3"
    ).bind(expiresAt.toISOString(), userId, sessionHash).run();
    if (Number(shortened?.meta?.changes || 0) !== 1) {
      await removeE2EAdmin(env, userId, username);
      return jsonResponse({ ok: false, code: "E2E_ADMIN_SESSION_FAILED" }, 500, origin);
    }
    stage = "session_readback";
    const activeSession = await env.AUTH_DB.prepare(
      "SELECT id FROM sessions WHERE token_hash = ?1 AND user_id = ?2 LIMIT 1"
    ).bind(sessionHash, userId).first();
    if (!activeSession) {
      await removeE2EAdmin(env, userId, username);
      return jsonResponse({ ok: false, code: "E2E_ADMIN_SESSION_FAILED" }, 500, origin);
    }
    stage = "response";
    const response = jsonResponse({ ok: true, username, runId: runIdentity.runId,
      capabilityExpiresAt: runIdentity.expiresAt, sessionExpiresAt: expiresAt.toISOString() }, 201, origin);
    response.headers.set("Set-Cookie", withSessionExpiry(login.headers.get("Set-Cookie"), expiresAt));
    return response;
  } catch (error) {
    if (userId && username) {
      await removeE2EAdmin(env, userId, username).catch(() => false);
    }
    return jsonResponse(classifyE2EAdminProvisionFailure(stage, error), 500, origin);
  }
}

async function cleanupE2EAdmin(request, env, ctx, input = {}) {
  const origin = request.headers.get("Origin") || "https://s9simu.pages.dev";
  if (!isIsolatedTestEnvironment(env) || origin !== "https://s9simu.pages.dev") {
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
  }
  let userId = "";
  let username = "";
  let runIdentity = null;
  const cookie = request.headers.get("Cookie") || "";
  const hasSessionCookie = /(?:^|;\s*)s9_session=/.test(cookie);
  if (hasSessionCookie) {
    const me = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/auth/me", {
      headers: { Cookie: cookie, Origin: origin }
    }), env, ctx);
    const identity = await me.json();
    userId = String(identity?.user?.id || "");
    username = String(identity?.user?.username || "");
    if (identity?.authenticated !== true) return jsonResponse({ ok: false, code: "E2E_ADMIN_REQUIRED" }, 403, origin);
  } else {
    // If the provisioning response was lost, the same signed run proof may
    // remove only the identity deterministically bound to that workflow run.
    const authorization = String(request.headers.get("Authorization") || "");
    const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match) return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
    try {
      runIdentity = await verifyS9SimuRunToken(match[1]);
    } catch {
      return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
    }
    if (String(input?.runId || "") !== runIdentity.runId || input?.preserveUser === true) {
      return jsonResponse({ ok: false, code: "E2E_RUN_MISMATCH" }, 403, origin);
    }
    username = runIdentity.username;
  }
  if (!/^e2e-[a-f0-9]{12}$/.test(username)) {
    return jsonResponse({ ok: false, code: "E2E_ADMIN_REQUIRED" }, 403, origin);
  }
  const row = userId
    ? await env.AUTH_DB.prepare("SELECT id, role, updated_at FROM users WHERE id = ?1 AND username = ?2 LIMIT 1").bind(userId, username).first()
    : await env.AUTH_DB.prepare("SELECT id, role, updated_at FROM users WHERE username = ?1 LIMIT 1").bind(username).first();
  if (!row) return jsonResponse({ ok: true, removed: false, alreadyAbsent: true }, 200, origin);
  if (!userId && row?.role === "admin") userId = String(row.id || "");
  if (row?.role !== "admin") return jsonResponse({ ok: false, code: "E2E_ADMIN_REQUIRED" }, 403, origin);

  let logout = null;
  if (hasSessionCookie) {
    logout = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/auth/logout", {
      method: "POST", headers: { Cookie: cookie, Origin: origin }
    }), env, ctx);
  }
  if (userId) await env.AUTH_DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
  if (input?.preserveUser === true) {
    if (!hasSessionCookie) return jsonResponse({ ok: false, code: "E2E_ADMIN_REQUIRED" }, 403, origin);
    const demoted = userId
      ? await env.AUTH_DB.prepare("UPDATE users SET role = 'user', status = 'active', updated_at = ?1 WHERE id = ?2 AND username = ?3 AND role = 'admin'")
        .bind(new Date().toISOString(), userId, username).run()
      : { meta: { changes: 0 } };
    if (Number(demoted?.meta?.changes || 0) !== 1) {
      return jsonResponse({ ok: false, code: "E2E_ADMIN_CLEANUP_FAILED" }, 500, origin);
    }
    return jsonResponse({ ok: true, removed: false, retainedAsUser: true }, 200, origin);
  }
  const replayExpiresAt = runIdentity?.expiresAt || row?.updated_at || "";
  if (Date.parse(replayExpiresAt) > Date.now()) {
    const marker = await env.AUTH_DB.prepare(
      "UPDATE users SET role = 'user', status = 'disabled', updated_at = ?1 WHERE id = ?2 AND username = ?3 AND role = 'admin'"
    ).bind(replayExpiresAt, userId, username).run();
    if (Number(marker?.meta?.changes || 0) !== 1) {
      return jsonResponse({ ok: false, code: "E2E_ADMIN_CLEANUP_FAILED" }, 500, origin);
    }
    return jsonResponse({ ok: true, removed: false, replayMarkerRetainedUntil: replayExpiresAt }, 200, origin);
  }
  const removed = await removeE2EAdmin(env, userId, username);
  if (!removed) {
    // D1's write response may be ambiguous after a successful cascade. A
    // read-back makes cleanup safely idempotent without deleting any other user.
    const remaining = await env.AUTH_DB.prepare("SELECT id FROM users WHERE id = ?1 AND username = ?2 LIMIT 1")
      .bind(userId, username).first();
    if (remaining) return jsonResponse({ ok: false, code: "E2E_ADMIN_CLEANUP_FAILED" }, 500, origin);
  }
  const response = jsonResponse({ ok: true, removed: true }, 200, origin);
  const clearedCookie = logout?.headers.get("Set-Cookie");
  if (clearedCookie) response.headers.set("Set-Cookie", clearedCookie);
  return response;
}

async function callAdminApi(request, env, ctx, pathname, body) {
  const headers = new Headers({
    Cookie: request.headers.get("Cookie") || "",
    Origin: request.headers.get("Origin") || "https://s9simu.pages.dev",
    "Content-Type": "application/json"
  });
  return authWorker.fetch(new Request(`https://starting9-test-auth.internal${pathname}`, {
    method: "POST", headers, body: JSON.stringify(body)
  }), createProductEnvironment(env), ctx);
}

async function submitTestPredictionAtLogicalTime(env, ctx, { sessionCookie, prediction, logicalNow, origin }) {
  const session = String(sessionCookie || "");
  if (!/^s9_session=[A-Za-z0-9._~-]{16,256}$/.test(session)) {
    return jsonResponse({ ok: false, code: "TEST_USER_SESSION_REQUIRED" }, 400, origin);
  }
  const parsedNow = new Date(logicalNow);
  if (!Number.isFinite(parsedNow.getTime()) || parsedNow.toISOString() !== logicalNow) {
    return jsonResponse({ ok: false, code: "TEST_CLOCK_INVALID" }, 400, origin);
  }
  const scheduled = await env.AUTH_DB.prepare(`SELECT games.start_time
    FROM games JOIN game_contests ON game_contests.internal_game_id = games.internal_game_id
    WHERE games.internal_game_id = ?1 AND game_contests.contest_id = ?2
      AND game_contests.target_team_key = ?3 LIMIT 1`)
    .bind(INTERNAL_GAME_ID, CONTEST_ID, targetTeam.key).first();
  const startAt = Date.parse(String(scheduled?.start_time || ""));
  if (!Number.isFinite(startAt)) return jsonResponse({ ok: false, code: "TEST_GAME_NOT_FOUND" }, 404, origin);
  const cutoffAt = startAt - V3_TIMING.predictionDeadlineMinutes * 60_000;
  if (Math.abs(parsedNow.getTime() - cutoffAt) > 60_000) {
    return jsonResponse({ ok: false, code: "TEST_CLOCK_OUT_OF_WINDOW" }, 400, origin);
  }

  // This admin-only bridge injects time into one ordinary prediction PUT.
  // The production worker never receives this internal env property, and the
  // public request cannot set it through headers or query parameters.
  const response = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/predictions/current", {
    method: "PUT",
    headers: {
      Cookie: session,
      Origin: "https://s9simu.pages.dev",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ internalGameId: INTERNAL_GAME_ID, contestId: CONTEST_ID, prediction })
  }), createProductEnvironment(env, { predictionClockNow: parsedNow.toISOString() }), ctx);
  const payload = await response.json().catch(() => null);
  return jsonResponse({
    ok: response.ok && payload?.ok === true,
    status: response.status,
    code: typeof payload?.code === "string" ? payload.code : null,
    predictionStatus: typeof payload?.status === "string" ? payload.status : null
  }, 200, origin);
}

async function finalizeSyntheticLineup(request, env, ctx) {
  const lineup = teamRoster.slice(0, 9).map((player, index) => ({
    playerId: player.playerId,
    playerName: player.name,
    uniformNumber: player.uniformNumber,
    teamCode: player.teamCode,
    teamId: player.teamId,
    position: POSITIONS[index],
    battingOrder: index + 1
  }));
  const save = await callAdminApi(request, env, ctx, `/api/admin/v3/games/${INTERNAL_GAME_ID}/lineup-revisions`, {
    lineup,
    reason: "Test scenario fixture",
    confirmed: true
  });
  const saved = await save.json();
  if (save.status !== 201 || !saved?.revision?.revisionId) {
    throw new Error(`synthetic lineup save failed: ${JSON.stringify(saved)}`);
  }
  const finalize = await callAdminApi(request, env, ctx, `/api/admin/v3/games/${INTERNAL_GAME_ID}/lineup-finalize`, {
    lineupRevisionId: saved.revision.revisionId,
    confirmed: true
  });
  const finalized = await finalize.json();
  if (finalize.status !== 200) throw new Error(`synthetic ${targetTeam.key} lineup finalize failed: ${JSON.stringify(finalized)}`);
  return finalized;
}

async function runPipeline(env, { target = "published", failAt = "", stageOnly = false, nowOverride = null, automaticOfficialLineup = false } = {}) {
  env = createProductEnvironment(env, { automaticOfficialLineup });
  const disabledStages = target === "scored"
    ? ["ranking_rebuild", "publish"]
    : target === "ranked"
      ? ["publish"]
      : target === "closed"
        ? ["lineup_finalize", "score", "ranking_rebuild", "publish"]
        : target === "lineup-captured"
          ? ["score", "ranking_rebuild", "publish"]
        : target === "lineup-ready"
          ? ["lineup_finalize", "ranking_rebuild", "publish"]
        : [];
  let injected = false;
  let latest;
  const stageOnlyJobTypes = stageOnly
    ? target === "scored"
      ? ["prediction_close", "lineup_finalize", "ranking_rebuild", "publish"]
      : target === "ranked"
        ? ["prediction_close", "lineup_finalize", "score", "publish"]
        : target === "published"
          ? ["prediction_close", "lineup_finalize", "score", "ranking_rebuild"]
          : target === "closed"
            ? ["lineup_finalize", "score", "ranking_rebuild", "publish"]
          : target === "lineup-captured"
            ? ["prediction_close", "score", "ranking_rebuild", "publish"]
          : []
    : [];
  const stageOnlyDisabledStages = stageOnly
    ? target === "scored"
      ? ["prediction_close", "lineup_finalize", "ranking_rebuild", "publish"]
      : target === "ranked"
        ? ["prediction_close", "lineup_finalize", "score", "publish"]
        : target === "published"
          ? ["prediction_close", "lineup_finalize", "score", "ranking_rebuild"]
        : target === "closed"
          ? ["lineup_finalize", "score", "ranking_rebuild", "publish"]
          : target === "lineup-captured"
            ? ["prediction_close", "score", "ranking_rebuild", "publish"]
          : []
    : [];
  const passLimit = stageOnly ? 1 : 8;
  let currentGame = null;
  for (let pass = 0; pass < passLimit; pass += 1) {
    const now = nowOverride ? new Date(nowOverride) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("TEST_CLOCK_INVALID");
    latest = await runGameAutomationV3(env, now, {
      // The planner and executor must operate on the same Test Site contest.
      // Without this claim filter, a per-team scenario can claim a sibling
      // contest's due job for the same physical game and make its transition
      // timing depend on which team happened to be processed first.
      targetTeamKey: targetTeam.key,
      gameListOptions: { includeRecentHistory: true, internalGameId: INTERNAL_GAME_ID, targetTeam },
      formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
        disabledStages: [...disabledStages, ...stageOnlyDisabledStages],
        targetTeamKey: targetTeam.key
      }),
      auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
      disabledJobTypes: [
        ...(target === "lineup-ready" ? ["score"] : []),
        ...stageOnlyJobTypes
      ],
      // The Test Site disables automatic roster/probable-starter polling and
      // this scenario exercises only the formal contest workflow. Skipping
      // auxiliary discovery keeps each test invocation inside the Worker's
      // Free CPU budget without bypassing the production planner/claim/executor.
      runAuxiliary: false,
      executeJob: async (context) => {
        if (!injected && failAt && String(context.job?.job_type) === failAt) {
          injected = true;
          throw new Error("TEST_SCENARIO_INJECTED_FAILURE");
        }
        return executeGameAutomationV3Job(context);
      }
    });
    currentGame = await currentScenarioGame(env.AUTH_DB);
    if (!currentGame) break;
    if (target === "closed" && currentGame.state === "prediction_closed") break;
    if (target === "lineup-ready" && currentGame.state === "lineup_ready") break;
    if (target === "scored" && currentGame.state === "scored") break;
    if (target === "ranked" && currentGame.state === "ranked") break;
    if (target === "published" && currentGame.state === "published") break;
  }
  return { result: latest || null, failureInjected: injected, game: currentGame };
}

async function applyScenario(request, env, ctx, scenario, { stageOnly = false, simulatorMode = false, nowOverride = null } = {}) {
  const allowed = new Set(["no-game", "pre-open", "open", "deadline-imminent", "closed", "lineup-ready", "lineup-captured", "scored", "ranked", "published", "retry", "probable-unannounced", "probable-announced", "probable-unavailable"]);
  if (!allowed.has(scenario)) return jsonResponse({ ok: false, code: "INVALID_SCENARIO" }, 400);
  if (simulatorMode && scenario === "lineup-ready") return jsonResponse({ ok: false, code: "SIMULATOR_SCENARIO_UNSUPPORTED" }, 400);
  let pipelineGame = null;
  let pipelineDiagnostics = null;
  let failureInjected = false;
  if (scenario === "no-game") {
    const cleanupScope = await deleteScenarioRows(env.AUTH_DB, INTERNAL_GAME_ID);
    await deleteScenarioAuditRows(env.AUDIT_DB, { internalGameId: INTERNAL_GAME_ID, ...cleanupScope });
    return jsonResponse({ ok: true, scenario, game: null });
  }

  const offset = scenario === "pre-open" ? 240
    : scenario === "open" ? 180
      : scenario === "deadline-imminent" ? 65
        : -12;
  let game = await currentScenarioGame(env.AUTH_DB);
  if (simulatorMode && !game) return jsonResponse({ ok: false, code: "SIMULATED_GAME_NOT_FOUND" }, 404);
  if (!game && !simulatorMode) {
    game = await seedScenarioGame(env.AUTH_DB, offset);
  } else if (!simulatorMode) {
    const times = currentTimes(offset);
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare("UPDATE games SET game_date = ?1, start_time = ?2, game_status = 'scheduled', updated_at = ?3 WHERE internal_game_id = ?4")
        .bind(times.gameDate, times.startAt, times.now, INTERNAL_GAME_ID),
      env.AUTH_DB.prepare("UPDATE detected_game_schedule SET game_date = ?1, start_at = ?2, game_status = 'scheduled', updated_at = ?3 WHERE internal_game_id = ?4")
        .bind(times.gameDate, times.startAt, times.now, INTERNAL_GAME_ID),
      env.AUTH_DB.prepare("UPDATE game_roster_snapshots SET game_date = ?1, captured_at = ?2, updated_at = ?2 WHERE internal_game_id = ?3")
        .bind(times.gameDate, times.now, INTERNAL_GAME_ID),
      env.AUTH_DB.prepare("UPDATE game_pregame_automation SET game_date = ?1, start_at = ?2, updated_at = ?3 WHERE internal_game_id = ?4")
        .bind(times.gameDate, times.startAt, times.now, INTERNAL_GAME_ID),
      env.AUTH_DB.prepare("UPDATE ranking_games SET game_date = ?1, updated_at = ?2 WHERE internal_game_id = ?3")
        .bind(times.gameDate, times.now, INTERNAL_GAME_ID)
    ]);
    game = { ...game, gameDate: times.gameDate, startAt: times.startAt, deadlineAt: times.deadlineAt };
  }

  if (scenario.startsWith("probable-")) {
    const status = scenario === "probable-announced" ? "announced"
      : scenario === "probable-unavailable" ? "error" : "unannounced";
    await env.AUTH_DB.prepare(`UPDATE probable_starters
      SET status = ?1, home_pitcher_name = ?2, away_pitcher_name = ?3, announced_at = ?4,
          fetched_at = ?5, error_code = ?6, updated_at = ?5 WHERE internal_game_id = ?7`)
      .bind(status, status === "announced" ? "TEST Pitcher 01" : null,
        status === "announced" ? "TEST Pitcher 02" : null,
        status === "announced" ? new Date().toISOString() : null, new Date().toISOString(),
        status === "error" ? "TEST_FIXTURE_UNAVAILABLE" : null, INTERNAL_GAME_ID).run();
  }

  if (["closed", "lineup-ready", "lineup-captured", "scored", "ranked", "published", "retry"].includes(scenario)) {
    const existingLineup = await env.AUTH_DB.prepare(`SELECT final_lineup_revision_id FROM game_lineups
      WHERE internal_game_id = ?1 AND contest_id=(SELECT contest_id FROM game_contests
        WHERE internal_game_id=?1 AND target_team_key=?2 LIMIT 1) LIMIT 1`)
      .bind(INTERNAL_GAME_ID, targetTeam.key).first();
    if (stageOnly && ["scored", "ranked", "published"].includes(scenario)) {
      const currentState = String((await env.AUTH_DB.prepare(
        "SELECT state FROM contest_automation_v3_state WHERE contest_id = ?1 LIMIT 1"
      ).bind(CONTEST_ID).first())?.state || "scheduled");
      const scoringRevision = scenario === "ranked"
        ? await env.AUTH_DB.prepare(`SELECT status FROM contest_scoring_revisions
            WHERE internal_game_id = ?1 AND contest_id = ?2 AND is_active = 1
            ORDER BY created_at DESC LIMIT 1`).bind(INTERNAL_GAME_ID, CONTEST_ID).first()
        : null;
      // Test scenario gating may observe a completed canonical score artifact
      // before its state projection catches up. Permit the ranking request in
      // that one case; the normal V3 planner and executor still verify the
      // scoring revision and perform the forward state transition.
      const rankedFromCompletedScore = scenario === "ranked"
        && currentState === "lineup_ready" && scoringRevision?.status === "completed";
      const readyStates = scenario === "scored"
        ? new Set(["prediction_closed", "lineup_ready", "scored", "ranked", "published"])
        : scenario === "ranked"
          ? new Set(["scored", "ranked", "published"])
          : new Set(["ranked", "published"]);
      if ((!readyStates.has(currentState) && !rankedFromCompletedScore) || !existingLineup?.final_lineup_revision_id) {
        return jsonResponse({ ok: false, code: "SCENARIO_STAGE_PREREQUISITE", game: await currentScenarioGame(env.AUTH_DB) }, 409);
      }
    } else if (!simulatorMode) {
      const pipeline = await runPipeline(env, { target: "closed",
        stageOnly: scenario === "retry" || (stageOnly && scenario === "closed") });
      pipelineGame = pipeline.game;
      const afterClose = pipelineGame;
      if (stageOnly && scenario === "closed" && afterClose?.state !== "prediction_closed") {
        return jsonResponse({ ok: true, scenario, game: afterClose });
      }
      if (!existingLineup?.final_lineup_revision_id) await finalizeSyntheticLineup(request, env, ctx);
    }
  }
  if (simulatorMode && ["closed", "lineup-captured", "scored", "ranked", "published"].includes(scenario)) {
    const target = scenario === "lineup-captured" ? "lineup-captured" : scenario;
    const stateBefore = (await currentScenarioGame(env.AUTH_DB))?.state || null;
    const pipeline = await runPipeline(env, { target, stageOnly: true, nowOverride, automaticOfficialLineup: true });
    pipelineGame = pipeline.game;
    const lineup = await env.AUTH_DB.prepare(`SELECT final_lineup_revision_id FROM game_lineups
      WHERE internal_game_id = ?1 AND contest_id = ?2 LIMIT 1`).bind(INTERNAL_GAME_ID, CONTEST_ID).first();
    const jobs = await env.AUTH_DB.prepare(`SELECT job_type, status FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND contest_id = ?2 ORDER BY job_type`).bind(INTERNAL_GAME_ID, CONTEST_ID).all();
    pipelineDiagnostics = {
      contestId: CONTEST_ID,
      targetTeam: targetTeam.key,
      stateBefore,
      lineupPersisted: Boolean(lineup?.final_lineup_revision_id),
      stateAfter: pipelineGame?.state || null,
      claimedJobTypes: (pipeline.result?.claimReport?.claimed || []).map((entry) => String(entry?.claimed?.job_type || entry?.job?.job_type || "")),
      claimedContestIds: [...new Set((pipeline.result?.claimReport?.claimed || [])
        .map((entry) => String(entry?.claimed?.contest_id || entry?.job?.contest_id || "")).filter(Boolean))],
      lineupFetchPlans: (pipeline.result?.mainPlan?.diagnostics || [])
        .filter((entry) => entry?.stage === "lineup_fetch")
        .map((entry) => ({
          targetTeam: targetTeam.key,
          state: entry.effectiveState || entry.persistedState || null,
          due: entry.due === true,
          shouldCreateJob: entry.shouldCreateJob === true,
          blockedReason: entry.blockedReason || null,
          reasonCode: entry.reasonCode || null,
          existingStatus: entry.existingStatus || null
        })),
      jobs: (jobs.results || []).map((job) => ({ jobType: job.job_type, status: job.status }))
    };
  }
  if (scenario === "lineup-ready") {
    await markManualLineupReadyScenario(env.AUTH_DB);
    await runPipeline(env, { target: "lineup-ready" });
  }
  if (["scored", "ranked", "published"].includes(scenario) && !simulatorMode) {
    const target = scenario;
    const pipeline = await runPipeline(env, { target, stageOnly });
    pipelineGame = pipeline.game;
  }
  if (scenario === "retry") {
    const pipeline = await runPipeline(env, { target: "ranked", failAt: "ranking_rebuild" });
    pipelineGame = pipeline.game;
    failureInjected = pipeline.failureInjected;
  }
  const current = pipelineGame || await currentScenarioGame(env.AUTH_DB);
  if (scenario === "published") {
    const contestId = (await env.AUTH_DB.prepare(`SELECT contest_id FROM game_contests
      WHERE internal_game_id=?1 AND target_team_key=?2 LIMIT 1`).bind(INTERNAL_GAME_ID, targetTeam.key).first())?.contest_id;
    const [lineup, score, reflection, publication] = await Promise.all([
      env.AUTH_DB.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1 AND contest_id = ?2 LIMIT 1").bind(INTERNAL_GAME_ID, contestId).first(),
      env.AUTH_DB.prepare("SELECT status FROM contest_scoring_revisions WHERE internal_game_id = ?1 AND contest_id = ?2 AND is_active = 1 ORDER BY created_at DESC LIMIT 1").bind(INTERNAL_GAME_ID, contestId).first(),
      env.AUTH_DB.prepare("SELECT status FROM contest_ranking_reflection_revisions WHERE internal_game_id = ?1 AND contest_id = ?2 ORDER BY created_at DESC LIMIT 1").bind(INTERNAL_GAME_ID, contestId).first(),
      env.AUTH_DB.prepare("SELECT publication_status FROM contest_ranking_games WHERE internal_game_id = ?1 AND contest_id = ?2 LIMIT 1").bind(INTERNAL_GAME_ID, contestId).first()
    ]);
    const ready = validatePublishedScenario({
      state: current?.state,
      lineupReady: Boolean(lineup?.final_lineup_revision_id),
      scoringReady: score?.status === "completed",
      rankingReady: reflection?.status === "reflected",
      publicationReady: publication?.publication_status === "published"
    });
    if (!ready) return jsonResponse({ ok: false, code: "PUBLISHED_SCENARIO_INCOMPLETE", game: current }, 500);
  }
  return jsonResponse({ ok: true, scenario, game: current,
    ...(pipelineDiagnostics ? { pipelineDiagnostics } : {}),
    ...(scenario === "retry" ? { failureInjected } : {}) });
}

async function handleTestControl(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (!isIsolatedTestEnvironment(env)) return jsonResponse({ ok: false, code: "TEST_ENVIRONMENT_REQUIRED" }, 404, origin);
  if (origin && !TEST_SITE_ORIGINS.has(origin)) return jsonResponse({ ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403, origin);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin || "https://s9simu.pages.dev",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Cache-Control": "no-store"
    } });
  }
  if (url.pathname === "/api/test/e2e-admin" && request.method === "POST") {
    const input = await request.json().catch(() => null);
    if (input?.action === "provision") return provisionE2EAdmin(request, env, ctx, input);
    if (input?.action === "cleanup") return cleanupE2EAdmin(request, env, ctx, input);
    return jsonResponse({ ok: false, code: "INVALID_ACTION" }, 400, origin);
  }
  if (url.pathname === "/api/test/simu/schedule" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const pending = [];
    const scheduledContext = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
    // Keep the simulator's next-day fixture date stable across the formal
    // scheduled event and read-back, and move only this isolated test event
    // past the schedule check gate when a prior narrow check already ran.
    const date = simulatorGameDate();
    const previousCheck = await env.AUTH_DB.prepare(
      "SELECT next_check_at FROM game_schedule_check_state WHERE schedule_date = ?1 LIMIT 1"
    ).bind(date).first();
    const nextCheckAt = Date.parse(String(previousCheck?.next_check_at || ""));
    const scheduledTime = Math.max(Date.now(), Number.isFinite(nextCheckAt) ? nextCheckAt + 1000 : 0);
    await authWorker.scheduled({
      cron: "1,16,31,46 * * * *",
      scheduledTime
    }, createProductEnvironment(env), scheduledContext);
    const taskResults = await Promise.allSettled(pending);
    const failed = taskResults.find((result) => result.status === "rejected");
    if (failed) {
      console.error(`[S9SIMU] formal_schedule_sync_failed code=${failed.reason?.code || "SCHEDULE_SYNC_FAILED"}`);
      return jsonResponse({ ok: false, code: "SIMULATED_SCHEDULE_SYNC_FAILED" }, 502, origin);
    }
    const scheduleExecution = taskResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .find((value) => value?.cronMode === "schedule") || null;
    const scheduleSync = scheduleExecution?.scheduleSync || {};
    const fixtureSync = scheduleSync.currentDay?.date === date
      ? scheduleSync.currentDay
      : (scheduleSync.results || []).find((result) => result?.date === date) || null;
    const games = await env.AUTH_DB.prepare(
      `SELECT schedule.game_id, schedule.internal_game_id, schedule.game_date, schedule.start_at,
              schedule.home_team, schedule.away_team, schedule.game_code, schedule.game_status,
              (SELECT game.internal_game_id FROM games AS game
                WHERE game.internal_game_id = schedule.internal_game_id LIMIT 1) AS persisted_internal_game_id,
              COALESCE((SELECT identifier.identifier_value FROM game_identifiers AS identifier
                WHERE identifier.internal_game_id = schedule.internal_game_id AND identifier.provider='npb'
                  AND identifier.identifier_type='npb_game_code' ORDER BY identifier.updated_at DESC, identifier.id DESC LIMIT 1),
                (SELECT game.npb_game_code FROM games AS game
                  WHERE game.internal_game_id = schedule.internal_game_id LIMIT 1)) AS provider_game_id,
              (SELECT COUNT(*) FROM game_contests AS contest
                WHERE contest.internal_game_id = schedule.internal_game_id) AS persisted_contest_count,
              (SELECT group_concat(target_team_key, ',') FROM (
                SELECT contest.target_team_key FROM game_contests AS contest
                 WHERE contest.internal_game_id = schedule.internal_game_id ORDER BY contest.target_team_key
              )) AS persisted_contest_teams
         FROM detected_game_schedule AS schedule
        WHERE schedule.game_date = ?1 ORDER BY schedule.start_at, schedule.game_id LIMIT 6`
    ).bind(date).all();
    const contests = await env.AUTH_DB.prepare(
      `SELECT COUNT(*) AS count FROM game_contests WHERE internal_game_id IN
         (SELECT internal_game_id FROM detected_game_schedule WHERE game_date = ?1 LIMIT 6)`
    ).bind(date).first();
    const physicalGames = games.results || [];
    return jsonResponse({
      ok: true,
      date,
      physicalGames,
      contestCount: Number(contests?.count || 0),
      scheduleDiagnostics: {
        requestedDate: fixtureSync?.date || date,
        requestedTeam: fixtureSync?.sourceDiagnostics?.requestedTeam || "all",
        upstreamPath: fixtureSync?.sourceDiagnostics?.upstreamPath || null,
        upstreamStatus: fixtureSync?.sourceDiagnostics?.upstreamStatus ?? null,
        contentType: fixtureSync?.sourceDiagnostics?.contentType || null,
        rawGamesCount: fixtureSync?.sourceDiagnostics?.rawGamesCount ?? null,
        parsedGamesCount: fixtureSync?.sourceDiagnostics?.parsedGamesCount ?? null,
        filteredGamesCount: fixtureSync?.sourceDiagnostics?.filteredGamesCount ?? null,
        normalizedGamesCount: fixtureSync?.sourceDiagnostics?.normalizedGamesCount ?? null,
        attemptedUpsertCount: fixtureSync?.gameCount ?? 0,
        insertedCount: fixtureSync?.gamesInserted ?? 0,
        updatedCount: fixtureSync?.gamesUpdated ?? 0,
        readBackCount: physicalGames.length,
        internalGameIds: physicalGames.map((game) => game.internal_game_id)
      }
    }, 200, origin);
  }
  if (url.pathname === "/api/test/status" && request.method === "GET") {
    return jsonResponse({ ok: true, game: await currentScenarioGame(env.AUTH_DB) }, 200, origin);
  }
  if (url.pathname === "/api/test/rehearsal/snapshot" && request.method === "GET") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const game = await env.AUTH_DB.prepare(`SELECT COALESCE((SELECT identifier_value FROM game_identifiers
        WHERE internal_game_id = ?1 AND provider = 'npb' AND identifier_type = 'npb_game_code'
        ORDER BY updated_at DESC, id DESC LIMIT 1), games.npb_game_code) AS provider_game_id
      FROM games WHERE internal_game_id = ?1 LIMIT 1`).bind(INTERNAL_GAME_ID).first();
    if (game?.provider_game_id !== "g-t-4" || !["hawks", "fighters"].includes(targetTeam.key)) {
      return jsonResponse({ ok: false, code: "REHEARSAL_GAME_IDENTITY_MISMATCH" }, 409, origin);
    }
    const snapshot = await readRehearsalContestSnapshot(env.AUTH_DB, { internalGameId: INTERNAL_GAME_ID, contestId: CONTEST_ID });
    return jsonResponse({ ok: true, snapshot, environment: env.ENVIRONMENT,
      expectedAccountId: env.TEST_EXPECTED_ACCOUNT_ID, workerName: env.TEST_WORKER_NAME,
      authDatabaseId: env.TEST_AUTH_DB_ID, siteId: env.TEST_SITE_ID, targetTeam: targetTeam.key }, 200, origin);
  }
  if (url.pathname === "/api/test/rehearsal/reset-fighters" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    if (!isAuthorizedFightersRehearsalResetEnvironment(env)) {
      return jsonResponse({ ok: false, code: "REHEARSAL_TEST_ACCOUNT_REQUIRED" }, 404, origin);
    }
    if (targetTeam.key !== "fighters") return jsonResponse({ ok: false, code: "REHEARSAL_TARGET_REQUIRED" }, 403, origin);
    const input = await request.json().catch(() => null);
    const result = await resetFightersRehearsalContest(env.AUTH_DB, {
      internalGameId: INTERNAL_GAME_ID,
      expectedContestId: String(input?.expectedContestId || ""),
      expectedSiblingContestId: String(input?.expectedSiblingContestId || "")
    });
    return jsonResponse(result, result.status || 200, origin);
  }
  if (url.pathname === "/api/test/jobs" && request.method === "GET") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const jobs = await env.AUTH_DB.prepare(`SELECT job_type, status, attempt_count, next_retry_at,
        lease_expires_at, failure_code, failure_message
      FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND contest_id = ?2
      ORDER BY job_type`)
      .bind(INTERNAL_GAME_ID, CONTEST_ID).all();
    return jsonResponse({ ok: true, internalGameId: INTERNAL_GAME_ID, contestId: CONTEST_ID,
      jobs: Array.isArray(jobs?.results) ? jobs.results : [] }, 200, origin);
  }
  if (url.pathname === "/api/test/prediction-write" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || !input.prediction || typeof input.prediction !== "object") {
      return jsonResponse({ ok: false, code: "INVALID_TEST_PREDICTION" }, 400, origin);
    }
    return submitTestPredictionAtLogicalTime(env, ctx, {
      sessionCookie: input.sessionCookie,
      prediction: input.prediction,
      logicalNow: input.logicalNow,
      origin
    });
  }
  if (url.pathname === "/api/test/scenario" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const input = await request.json().catch(() => null);
    const simulatorMode = url.searchParams.get("simuNpb") === "1" && Boolean(url.searchParams.get("internalGameId"));
    return applyScenario(request, env, ctx, String(input?.scenario || ""), {
      stageOnly: input?.stageOnly === true,
      simulatorMode,
      nowOverride: simulatorMode ? String(input?.now || "") : null
    });
  }
  if (url.pathname === "/api/test/reset" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const cleanupScope = await deleteScenarioRows(env.AUTH_DB, INTERNAL_GAME_ID);
    await deleteScenarioAuditRows(env.AUDIT_DB, { internalGameId: INTERNAL_GAME_ID, ...cleanupScope });
    const game = await seedScenarioGame(env.AUTH_DB, 180);
    return jsonResponse({ ok: true, scenario: "open", game }, 200, origin);
  }
  return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
}

async function serveSyntheticRoster(request, env) {
  const internalGameId = String(new URL(request.url).searchParams.get("internalGameId") || "");
  if (internalGameId !== INTERNAL_GAME_ID) return null;
  const game = await env.AUTH_DB.prepare(
    "SELECT game_date FROM games WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(INTERNAL_GAME_ID).first();
  if (!game) return jsonResponse({ ok: false, code: "ROSTER_NOT_FOUND" }, 404);
  const capturedAt = new Date().toISOString();
  return jsonResponse({
    ok: true,
    internalGameId: INTERNAL_GAME_ID,
    gameDate: game.game_date,
    status: "captured",
    rosterStatus: "captured",
    displayRosterSource: "test_fixture",
    sourceOfTruth: "verified_snapshot",
    rosterUse: "verified_snapshot",
    freshness: "verified",
    canUseForPrediction: true,
    verified: true,
    stale: false,
    capturedAt,
    playerCount: teamRoster.length,
    players: teamRoster,
    warning: null,
    nextSafeAction: null
  });
}

return {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET" && isIsolatedTestEnvironment(env)) {
      return jsonResponse({ ok: true, service: "starting9-test-auth", environment: "test", database: "not_checked" });
    }
    if (url.pathname.startsWith("/api/test/")) return handleTestControl(request, env, ctx);
    if (url.pathname === "/api/auth/register" && request.method === "POST" && isIsolatedTestEnvironment(env)) {
      const input = await request.clone().json().catch(() => null);
      if (/^e2e-[a-f0-9]{12}$/i.test(String(input?.username || ""))) {
        return jsonResponse({ ok: false, code: "TEST_USERNAME_RESERVED" }, 400, request.headers.get("Origin") || "");
      }
    }
    if (url.pathname === "/api/game-day-roster" && request.method === "GET" && isIsolatedTestEnvironment(env)
        && env.S9SIMU_ENABLED !== "true") {
      const roster = await serveSyntheticRoster(request, env);
      if (roster) return roster;
    }
    return authWorker.fetch(request, createProductEnvironment(env), ctx);
  }
};
}

export default {
  async fetch(request, env, ctx) {
    if (!isIsolatedTestEnvironment(env)) return authWorker.fetch(request, env, ctx);
    const url = new URL(request.url);
    const key = url.searchParams.get("testTeam") || "fighters";
    if (!TEST_TEAM_KEYS.includes(key)) return jsonResponseForUnknownTeam();
    let internalGameId = "";
    const requestedGameId = url.searchParams.get("internalGameId") || "";
    if (url.searchParams.get("simuNpb") === "1" && requestedGameId) {
      const input = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
      const game = await env.AUTH_DB.prepare(
        `SELECT games.internal_game_id,
                COALESCE((SELECT identifier_value FROM game_identifiers
                  WHERE internal_game_id = games.internal_game_id AND provider = 'npb'
                    AND identifier_type = 'npb_game_code' ORDER BY updated_at DESC, id DESC LIMIT 1),
                  games.npb_game_code) AS simulator_game_id,
                game_contests.contest_id
           FROM games
          JOIN game_contests ON game_contests.internal_game_id = games.internal_game_id
         WHERE games.internal_game_id = ?1 AND game_contests.target_team_key = ?2 LIMIT 1`
      ).bind(requestedGameId, key).first();
      // Provider game identity belongs to the persisted schedule/game registry.
      // The product-generated internal ID is intentionally unrelated to the
      // static IDs in TEST_TEAM_GROUPS.
      const codeMatch = String(game?.simulator_game_id || "").match(/^g-t-([1-6])$/);
      const simulatorGroup = codeMatch ? TEST_TEAM_GROUPS[Number(codeMatch[1]) - 1] : null;
      const requestedTeamIsParticipant = Boolean(simulatorGroup
        && [simulatorGroup.homeKey, simulatorGroup.awayKey].includes(key));
      const cleaningMissingSimulatorFixture = !game
        && input?.scenario === "no-game"
        // Cleanup is idempotent and remains limited to the exact UUID-shaped
        // product ID supplied by this Test Site request.
        && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestedGameId);
      if (!game && !cleaningMissingSimulatorFixture) {
        return Response.json({ ok: false, code: "SIMULATED_GAME_NOT_FOUND",
          identity: { namespace: "internalGameId", found: false } }, { status: 404 });
      }
      const cleanupIsContestScoped = input?.scenario === "no-game" && Boolean(game?.contest_id);
      if (game && (!simulatorGroup || !requestedTeamIsParticipant) && !cleanupIsContestScoped) {
        return Response.json({ ok: false, code: "SIMULATED_GAME_NOT_FOUND",
          identity: { namespace: "internalGameId->npb_game_code", found: true,
            providerIdentityFound: Boolean(game.simulator_game_id), participantContestFound: Boolean(game.contest_id) } }, { status: 404 });
      }
      internalGameId = String(game?.internal_game_id || requestedGameId);
    }
    return createTestTeamWorker(key, { internalGameId }).fetch(request, env, ctx);
  }
};

function jsonResponseForUnknownTeam() {
  return Response.json({ ok: false, code: "INVALID_TEST_TEAM" }, { status: 400 });
}
