import authWorker, { executeGameAutomationV3Job } from "../../auth-worker.js";
import { planMainWorkflowJobs, runGameAutomationV3 } from "../../game-automation-v3.js";
import { isIsolatedTestEnvironment, validatePublishedScenario } from "./isolation.js";

const INTERNAL_GAME_ID = "11111111-2027-4000-8000-000000000001";
const LEGACY_GAME_ID = INTERNAL_GAME_ID;
const POSITIONS = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
const CLEANUP_ORDER = Object.freeze([
  "score_attempt_prediction_rows", "score_attempt_test_rows", "score_attempts",
  "prediction_score_revisions", "ranking_reflection_revisions", "game_scoring_revisions",
  "ranking_eligibility_history", "game_rescore_audits", "game_rescore_previews", "game_rescore_jobs",
  "game_lineup_revisions", "game_automation_v3_audit", "game_jobs_v3",
  "game_workflow_logs", "game_lineups", "predictions", "ranking_games",
  "game_automation_v3_state", "game_pregame_automation", "game_roster_snapshots",
  "probable_starters", "game_identifiers", "detected_game_schedule", "games"
]);

const TEST_PLAYERS = Object.freeze(Array.from({ length: 15 }, (_, index) => Object.freeze({
  playerId: `npb:9999${String(index + 1).padStart(4, "0")}`,
  name: `TEST Player ${String(index + 1).padStart(2, "0")}`,
  number: String(index + 1),
  uniformNumber: String(index + 1),
  position: POSITIONS[index % POSITIONS.length],
  teamCode: "fighters",
  teamId: "F"
})));

function jsonResponse(body, status = 200, origin = "") {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (origin === "https://starting9-test.pages.dev") {
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

function createProductEnvironment(env) {
  if (!isIsolatedTestEnvironment(env)) return env;
  // The production Auth Worker resolves temporary players through its NPB
  // service binding. Replace that boundary only inside this test Worker with
  // a fixed synthetic roster response; never bind or call the production NPB
  // Worker from the test environment.
  return {
    ...env,
    NPB_FETCH_DISABLED: "false",
    NPB_FETCH_WORKER: {
      async fetch(request) {
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode");
        if (mode !== "roster") {
          return jsonResponse({ ok: false, code: "TEST_FIXTURE_MODE_UNSUPPORTED" }, 404);
        }
        return jsonResponse({
          ok: true,
          players: TEST_PLAYERS,
          fetchedAt: new Date().toISOString(),
          sourceUrl: "test-fixture://fighters-roster",
          cacheStatus: "fixture"
        });
      }
    }
  };
}

async function deleteScenarioRows(db) {
  const statements = [];
  for (const table of CLEANUP_ORDER) {
    const columnsResult = await db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = new Set((columnsResult.results || []).map((row) => String(row.name)));
    if (!columns.size) continue;
    const predicates = [];
    const values = [];
    if (columns.has("internal_game_id")) {
      predicates.push("internal_game_id = ?1");
      values.push(INTERNAL_GAME_ID);
    }
    if (columns.has("game_id")) {
      predicates.push(`game_id = ?${values.length + 1}`);
      values.push(LEGACY_GAME_ID);
    }
    if (!predicates.length) continue;
    const clauses = [...new Set(predicates)];
    statements.push(db.prepare(`DELETE FROM ${table} WHERE ${clauses.join(" OR ")}`).bind(...values));
  }
  if (statements.length) await db.batch(statements);
}

async function seedScenarioGame(db, offsetMinutes) {
  const { now, startAt, deadlineAt, gameDate } = currentTimes(offsetMinutes);
  const roster = JSON.stringify(TEST_PLAYERS);
  await db.batch([
    db.prepare(`INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'fighters', 'marines', 'scheduled', ?4, ?4)`)
      .bind(INTERNAL_GAME_ID, gameDate, startAt, now),
    db.prepare(`INSERT INTO detected_game_schedule
      (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue,
       game_status, detected_at, schedule_checked_at, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, 'fighters', 'marines', 'TEST-ONLY', 'TEST ONLY', 'scheduled', ?5, ?5, ?5, ?5, ?6)`)
      .bind(LEGACY_GAME_ID, `test-only:${INTERNAL_GAME_ID}`, gameDate, startAt, now, INTERNAL_GAME_ID),
    db.prepare(`INSERT INTO game_automation_v3_state (internal_game_id, state, created_at, updated_at)
      VALUES (?1, 'scheduled', ?2, ?2)`)
      .bind(INTERNAL_GAME_ID, now),
    db.prepare(`INSERT INTO game_roster_snapshots
      (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, 'npb-roster', 15, 'captured', ?3, ?3, ?5)`)
      .bind(LEGACY_GAME_ID, gameDate, now, roster, INTERNAL_GAME_ID),
    db.prepare(`INSERT INTO game_pregame_automation
      (game_id, game_date, start_at, created_at, updated_at, internal_game_id)
      VALUES (?1, ?2, ?3, ?4, ?4, ?5)`)
      .bind(LEGACY_GAME_ID, gameDate, startAt, now, INTERNAL_GAME_ID),
    db.prepare(`INSERT INTO probable_starters
      (game_id, internal_game_id, status, fetched_at, next_check_at, updated_at)
      VALUES (?1, ?2, 'unannounced', ?3, ?4, ?3)`)
      .bind(LEGACY_GAME_ID, INTERNAL_GAME_ID, now, now),
    db.prepare(`INSERT INTO ranking_games
      (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at,
       game_status, is_test_game, publication_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, 'pending', 0, 'pending', ?4, ?4)`)
      .bind(LEGACY_GAME_ID, INTERNAL_GAME_ID, gameDate, now)
  ]);
  return { gameId: LEGACY_GAME_ID, internalGameId: INTERNAL_GAME_ID, gameDate, startAt, deadlineAt };
}

async function currentScenarioGame(db) {
  return db.prepare(`SELECT games.internal_game_id, games.game_date, games.start_time, games.home_team,
      games.away_team, state.state, lineup.scoring_status, ranking.publication_status
    FROM games
    LEFT JOIN game_automation_v3_state AS state USING (internal_game_id)
    LEFT JOIN game_lineups AS lineup ON lineup.internal_game_id = games.internal_game_id
    LEFT JOIN ranking_games AS ranking ON ranking.internal_game_id = games.internal_game_id
    WHERE games.internal_game_id = ?1 LIMIT 1`).bind(INTERNAL_GAME_ID).first();
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

async function bootstrapFirstAdmin(request, env, ctx) {
  const expected = String(env.TEST_BOOTSTRAP_TOKEN || "");
  const supplied = String(request.headers.get("x-test-bootstrap-token") || "");
  if (!expected || supplied !== expected) return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404);
  const me = await authWorker.fetch(new Request("https://starting9-test-auth.internal/api/auth/me", {
    headers: { Cookie: request.headers.get("Cookie") || "", Origin: request.headers.get("Origin") || "" }
  }), env, ctx);
  const identity = await me.json();
  const userId = String(identity?.user?.id || "");
  if (identity?.authenticated !== true || !userId) return jsonResponse({ ok: false, code: "AUTH_REQUIRED" }, 401);
  const admin = await env.AUTH_DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
  if (admin) return jsonResponse({ ok: false, code: "BOOTSTRAP_CLOSED" }, 409);
  const result = await env.AUTH_DB.prepare("UPDATE users SET role = 'admin', updated_at = ?1 WHERE id = ?2 AND role = 'user'")
    .bind(new Date().toISOString(), userId).run();
  if (Number(result?.meta?.changes || 0) !== 1) return jsonResponse({ ok: false, code: "BOOTSTRAP_FAILED" }, 409);
  return jsonResponse({ ok: true, admin: true });
}

async function callAdminApi(request, env, ctx, pathname, body) {
  const headers = new Headers({
    Cookie: request.headers.get("Cookie") || "",
    Origin: request.headers.get("Origin") || "https://starting9-test.pages.dev",
    "Content-Type": "application/json"
  });
  return authWorker.fetch(new Request(`https://starting9-test-auth.internal${pathname}`, {
    method: "POST", headers, body: JSON.stringify(body)
  }), createProductEnvironment(env), ctx);
}

async function finalizeSyntheticLineup(request, env, ctx) {
  const lineup = TEST_PLAYERS.slice(0, 9).map((player, index) => ({
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
    throw new Error(`synthetic lineup save failed: ${saved?.code || save.status}`);
  }
  const finalize = await callAdminApi(request, env, ctx, `/api/admin/v3/games/${INTERNAL_GAME_ID}/lineup-finalize`, {
    lineupRevisionId: saved.revision.revisionId,
    confirmed: true
  });
  const finalized = await finalize.json();
  if (finalize.status !== 200) throw new Error(`synthetic lineup finalize failed: ${finalized?.code || finalize.status}`);
  return finalized;
}

async function runPipeline(env, { target = "published", failAt = "" } = {}) {
  const disabledStages = target === "scored"
    ? ["ranking_rebuild", "publish"]
    : target === "ranked"
      ? ["publish"]
      : target === "closed" || target === "lineup-ready"
        ? ["lineup_finalize", "score", "ranking_rebuild", "publish"]
        : [];
  let injected = false;
  let latest;
  for (let pass = 0; pass < 8; pass += 1) {
    const now = new Date();
    latest = await runGameAutomationV3(env, now, {
      gameListOptions: { includeRecentHistory: true },
      formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, { disabledStages }),
      auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
      executeJob: async (context) => {
        if (!injected && failAt && String(context.job?.job_type) === failAt) {
          injected = true;
          throw new Error("TEST_SCENARIO_INJECTED_FAILURE");
        }
        return executeGameAutomationV3Job(context);
      }
    });
    const game = await currentScenarioGame(env.AUTH_DB);
    if (!game) break;
    if (target === "closed" && game.state === "prediction_closed") break;
    if (target === "lineup-ready" && game.state === "lineup_ready") break;
    if (target === "scored" && game.state === "scored") break;
    if (target === "ranked" && game.state === "ranked") break;
    if (target === "published" && game.state === "published") break;
  }
  return { result: latest || null, failureInjected: injected };
}

async function applyScenario(request, env, ctx, scenario) {
  const allowed = new Set(["no-game", "pre-open", "open", "deadline-imminent", "closed", "lineup-ready", "scored", "ranked", "published", "retry", "probable-unannounced", "probable-announced", "probable-unavailable"]);
  if (!allowed.has(scenario)) return jsonResponse({ ok: false, code: "INVALID_SCENARIO" }, 400);
  if (scenario === "no-game") {
    await deleteScenarioRows(env.AUTH_DB);
    return jsonResponse({ ok: true, scenario, game: null });
  }

  const offset = scenario === "pre-open" ? 240
    : scenario === "open" ? 180
      : scenario === "deadline-imminent" ? 65
        : -12;
  let game = await currentScenarioGame(env.AUTH_DB);
  if (!game) {
    game = await seedScenarioGame(env.AUTH_DB, offset);
  } else {
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

  if (["lineup-ready", "scored", "ranked", "published", "retry"].includes(scenario)) {
    await runPipeline(env, { target: "closed" });
    const existingLineup = await env.AUTH_DB.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1 LIMIT 1")
      .bind(INTERNAL_GAME_ID).first();
    if (!existingLineup?.final_lineup_revision_id) await finalizeSyntheticLineup(request, env, ctx);
    if (scenario === "lineup-ready") await runPipeline(env, { target: "lineup-ready" });
  }
  if (["scored", "ranked", "published"].includes(scenario)) {
    const target = scenario;
    await runPipeline(env, { target });
  }
  if (scenario === "retry") await runPipeline(env, { target: "ranked", failAt: "ranking_rebuild" });
  const current = await currentScenarioGame(env.AUTH_DB);
  if (scenario === "published") {
    const [lineup, score, reflection, publication] = await Promise.all([
      env.AUTH_DB.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1 LIMIT 1").bind(INTERNAL_GAME_ID).first(),
      env.AUTH_DB.prepare("SELECT status FROM game_scoring_revisions WHERE internal_game_id = ?1 AND is_active = 1 ORDER BY created_at DESC LIMIT 1").bind(INTERNAL_GAME_ID).first(),
      env.AUTH_DB.prepare("SELECT status FROM ranking_reflection_revisions WHERE internal_game_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(INTERNAL_GAME_ID).first(),
      env.AUTH_DB.prepare("SELECT publication_status FROM ranking_games WHERE internal_game_id = ?1 LIMIT 1").bind(INTERNAL_GAME_ID).first()
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
  return jsonResponse({ ok: true, scenario, game: current });
}

async function handleTestControl(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (!isIsolatedTestEnvironment(env)) return jsonResponse({ ok: false, code: "TEST_ENVIRONMENT_REQUIRED" }, 404, origin);
  if (origin && origin !== "https://starting9-test.pages.dev") return jsonResponse({ ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403, origin);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "https://starting9-test.pages.dev",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Test-Bootstrap-Token",
      "Cache-Control": "no-store"
    } });
  }
  if (url.pathname === "/api/test/bootstrap-admin" && request.method === "POST") return bootstrapFirstAdmin(request, env, ctx);
  if (url.pathname === "/api/test/status" && request.method === "GET") {
    return jsonResponse({ ok: true, game: await currentScenarioGame(env.AUTH_DB) }, 200, origin);
  }
  if (url.pathname === "/api/test/scenario" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    const input = await request.json().catch(() => null);
    return applyScenario(request, env, ctx, String(input?.scenario || ""));
  }
  if (url.pathname === "/api/test/reset" && request.method === "POST") {
    if (!await requireTestAdmin(request, env, ctx)) return jsonResponse({ ok: false, code: "ADMIN_REQUIRED" }, 401, origin);
    await deleteScenarioRows(env.AUTH_DB);
    const game = await seedScenarioGame(env.AUTH_DB, 180);
    return jsonResponse({ ok: true, scenario: "open", game }, 200, origin);
  }
  return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404, origin);
}

async function serveSyntheticRoster(request, env) {
  const internalGameId = String(new URL(request.url).searchParams.get("internalGameId") || "");
  if (internalGameId !== INTERNAL_GAME_ID) return null;
  const snapshot = await env.AUTH_DB.prepare(
    "SELECT game_date, roster_json, captured_at FROM game_roster_snapshots WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(INTERNAL_GAME_ID).first();
  if (!snapshot) return jsonResponse({ ok: false, code: "ROSTER_NOT_FOUND" }, 404);
  const players = JSON.parse(snapshot.roster_json);
  return jsonResponse({
    ok: true,
    internalGameId: INTERNAL_GAME_ID,
    gameDate: snapshot.game_date,
    status: "captured",
    rosterStatus: "captured",
    displayRosterSource: "test_fixture",
    sourceOfTruth: "verified_snapshot",
    rosterUse: "verified_snapshot",
    freshness: "verified",
    canUseForPrediction: true,
    verified: true,
    stale: false,
    capturedAt: snapshot.captured_at,
    playerCount: players.length,
    players,
    warning: null,
    nextSafeAction: null
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET" && isIsolatedTestEnvironment(env)) {
      return jsonResponse({ ok: true, service: "starting9-test-auth", environment: "test", database: "not_checked" });
    }
    if (url.pathname.startsWith("/api/test/")) return handleTestControl(request, env, ctx);
    if (url.pathname === "/api/game-day-roster" && request.method === "GET" && isIsolatedTestEnvironment(env)) {
      const roster = await serveSyntheticRoster(request, env);
      if (roster) return roster;
    }
    return authWorker.fetch(request, createProductEnvironment(env), ctx);
  }
};
