import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCORING_MAX_SCORE, SCORING_RULES, scorePredictionLineup } from "../backend/domain/scoring.js";
import { scoreLineup } from "../asia-cs/scoring.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationFiles = ["0001_asia_cs_mvp.sql", "0002_competition_and_formal_jobs.sql", "0003_review_hardening.sql", "0004_ranking-generation-snapshots.sql"];
const migrationSql = migrationFiles.map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8"));
const migration = migrationSql
  .join("\n");

function createD1Adapter(database, failure = null) {
  const wrap = (statement, values = []) => ({
    bind(...nextValues) { return wrap(statement, nextValues); },
    async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; },
    async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; },
    _execute() { statement.run(...values); }
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        for (const [index, statement] of statements.entries()) {
          if (failure?.enabled && !failure.used && index === failure.statementIndex) {
            failure.used = true;
            throw new Error("injected batch failure");
          }
          statement._execute();
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function createDatabase({ failure = null } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, DB: createD1Adapter(database, failure), ASIA_CS_LOCAL_AUTH: "true" };
}

async function request(worker, env, path, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${path}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

function authCookie(response) {
  return response.cookie.split(";")[0];
}

const players = Array.from({ length: 9 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Player ${index + 1}`,
  uniformNumber: String(index + 1),
  team: "ASIA"
}));
const lineup = players.map((player, index) => ({
  battingOrder: index + 1,
  playerId: player.id,
  playerName: player.name,
  position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
}));

test("採点契約は本家の99点方式を使い、主要ケースの期待値を固定する", () => {
  const actual = lineup.map((item) => ({ ...item }));
  const playersOnly = actual.map((item, index) => ({ ...item, battingOrder: ((index + 1) % 9) + 1, position: actual[(index + 1) % 9].position }));
  const eightPerfect = actual.slice(0, 8).map((item) => ({ ...item }));
  const battingOrderMiss = actual.map((item, index) => ({ ...item, battingOrder: index === 0 ? 2 : item.battingOrder }));
  const positionMiss = actual.map((item, index) => ({ ...item, position: index === 0 ? actual[1].position : item.position }));
  const cases = [
    ["perfect", actual, 99],
    ["players-only", playersOnly, 45],
    ["eight-perfect", eightPerfect, 88],
    ["batting-order-miss", battingOrderMiss, 95],
    ["position-miss", positionMiss, 96]
  ];

  assert.equal(SCORING_MAX_SCORE, 99);
  assert.deepEqual(SCORING_RULES, {
    player: { perHit: 5, max: 45 },
    order: { perHit: 3, max: 27 },
    position: { perHit: 2, max: 18 },
    perfect: { perHit: 1, max: 9 }
  });
  for (const [, prediction, expected] of cases) {
    assert.equal(scorePredictionLineup(prediction, actual).total, expected);
    assert.deepEqual(scoreLineup(prediction, actual), scorePredictionLineup(prediction, actual));
  }
});

test("Asia CS MVP: 予想→締切→正式登録→採点→B9→正式修正→再採点→B9更新", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminBootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  assert.equal(adminBootstrap.response.status, 201);
  const adminLogin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = authCookie(adminLogin);
  const fanRegistration = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "fan", password: "fan-password" }) });
  assert.equal(fanRegistration.response.status, 201);
  const fanCookie = authCookie(fanRegistration);
  const staleRegistration = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "stale", password: "stale-password" }) });
  assert.equal(staleRegistration.response.status, 201);

  const future = "2026-11-15T09:00:00+09:00";
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "asia-cs-demo", title: "Asia CS Final", gameDate: "2026-11-15", startAt: future, predictionDeadlineAt: "2026-11-15T08:00:00+09:00" }) });
  assert.equal(created.response.status, 201);
  const roster = await request(worker, env, "/api/admin/games/asia-cs-demo/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players }) });
  assert.equal(roster.response.status, 200);

  const saved = await request(worker, env, "/api/games/asia-cs-demo/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(saved.response.status, 200);

  const closedAt = new Date(Date.now() - 1_000).toISOString();
  const submittedBeforeDeadline = new Date(Date.now() - 2_000).toISOString();
  fixture.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(closedAt, "asia-cs-demo");
  fixture.database.prepare("UPDATE predictions SET submitted_at = ? WHERE game_id = ?").run(submittedBeforeDeadline, "asia-cs-demo");
  const rejectedAfterDeadline = await request(worker, env, "/api/games/asia-cs-demo/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(rejectedAfterDeadline.response.status, 409);
  assert.equal(rejectedAfterDeadline.payload.code, "PREDICTION_DEADLINE_PASSED");

  const confirmed = await request(worker, env, "/api/admin/games/asia-cs-demo/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(confirmed.response.status, 200);
  const scored = await request(worker, env, "/api/admin/games/asia-cs-demo/score", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(scored.response.status, 200);
  assert.equal(scored.payload.scored, 1);
  assert.equal(scored.payload.scoreChangedCount, 1);
  assert.deepEqual(fixture.database.prepare("SELECT job_type, status FROM formal_jobs WHERE game_id = 'asia-cs-demo' ORDER BY job_type").all().map((row) => ({ job_type: row.job_type, status: row.status })), [
    { job_type: "prediction_close", status: "completed" },
    { job_type: "publish", status: "scheduled" },
    { job_type: "ranking_rebuild", status: "scheduled" },
    { job_type: "score", status: "completed" }
  ]);
  const beforeRanking = await request(worker, env, "/api/admin/games/asia-cs-demo/publish", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(beforeRanking.response.status, 409);
  assert.equal(beforeRanking.payload.code, "RANKING_INCOMPLETE");
  const ranking = await request(worker, env, "/api/admin/games/asia-cs-demo/ranking", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(ranking.response.status, 200);
  assert.deepEqual((await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking, []);
  const published = await request(worker, env, "/api/admin/games/asia-cs-demo/publish", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(published.response.status, 200);
  assert.deepEqual((await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking.map((row) => [row.rank, row.username, row.score, row.gamesCount]), [[1, "fan", 99, 1]]);
  assert.equal(Object.prototype.hasOwnProperty.call((await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking[0], "userId"), false);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'asia-cs-demo' AND status <> 'completed'").get().count, 0);

  const bestNine = await request(worker, env, "/api/games/asia-cs-demo/best-nine");
  assert.equal(bestNine.payload.published, true);
  assert.deepEqual(bestNine.payload.bestNine.map((row) => [row.rank, row.username, row.score]), [[1, "fan", 99]]);

  const corrected = lineup.map((item) => ({ ...item }));
  [corrected[6].position, corrected[7].position] = [corrected[7].position, corrected[6].position];
  const rescored = await request(worker, env, "/api/admin/games/asia-cs-demo/rescore", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: corrected, reason: "試合前の正式スタメン訂正" }) });
  assert.equal(rescored.response.status, 200);
  assert.equal(rescored.payload.revision, 2);
  assert.equal(rescored.payload.published, false);
  assert.equal(rescored.payload.scoreChangedCount, 1);
  assert.equal((await request(worker, env, "/api/admin/games/asia-cs-demo/ranking", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  const republished = await request(worker, env, "/api/admin/games/asia-cs-demo/publish", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(republished.response.status, 200);

  fixture.database.prepare(`INSERT INTO predictions (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES (?, ?, ?, ?, ?, ?, 'scored', 999, 99, 1, ?, ?, 0)`).run(
    "stale-prediction", staleRegistration.payload.user.id, "asia-cs-demo", JSON.stringify(lineup), "2026-09-22T00:00:00.000Z", "2026-09-22T00:00:00.000Z", JSON.stringify(lineup), "2026-09-22T00:00:00.000Z"
  );
  const updatedBestNine = await request(worker, env, "/api/games/asia-cs-demo/best-nine");
  assert.deepEqual(updatedBestNine.payload.bestNine.map((row) => [row.rank, row.username, row.score]), [[1, "fan", 93]]);
  const predictionRow = fixture.database.prepare("SELECT score, scored_revision, actual_lineup_json FROM predictions WHERE game_id = 'asia-cs-demo'").get();
  assert.equal(predictionRow.score, 93);
  assert.equal(predictionRow.scored_revision, 2);
  assert.deepEqual(JSON.parse(predictionRow.actual_lineup_json), corrected);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM lineup_revisions WHERE game_id = 'asia-cs-demo' AND is_current = 1").get().count, 1);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'asia-cs-demo' AND revision_number = 2").get().count, 1);
});

test("Asia CSのcompetition/team metadataとformal job scopeはNPB前提から分離される", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const login = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const adminCookie = authCookie(login);
  const teamA = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ competitionId: "asia-cs-2026", teamKey: "team-jp", displayName: "Japan", shortName: "JPN", countryCode: "JPN" }) });
  const teamB = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ competitionId: "asia-cs-2026", teamKey: "team-kr", displayName: "Korea", shortName: "KOR", countryCode: "KOR" }) });
  assert.equal(teamA.response.status, 201);
  assert.equal(teamB.response.status, 201);
  const listed = await request(worker, env, "/api/admin/teams?competitionId=asia-cs-2026", { headers: { Cookie: adminCookie } });
  assert.deepEqual(listed.payload.teams.map((team) => team.team_key), ["team-jp", "team-kr"]);

  const startAt = "2026-11-15T09:00:00+09:00";
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({
    id: "asia-cs-metadata", title: "Asia CS Final", competitionId: "asia-cs-2026", gameDate: "2026-11-15", startAt, predictionDeadlineAt: "2026-11-15T08:00:00+09:00",
    homeTeamId: "team-jp", homeTeamName: "Japan", awayTeamId: "team-kr", awayTeamName: "Korea", venue: "Tokyo Dome", externalGameCode: "asia-2026-final"
  }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.game.competitionType, "ASIA_CS");
  assert.equal(created.payload.game.competitionId, "asia-cs-2026");
  assert.equal(created.payload.game.gameSource, "manual");
  assert.equal(created.payload.game.externalGameCode, "asia-2026-final");
  assert.deepEqual(created.payload.game.homeTeam, { id: "team-jp", name: "Japan" });
  assert.deepEqual(created.payload.game.awayTeam, { id: "team-kr", name: "Korea" });

  const detail = await request(worker, env, "/api/admin/games/asia-cs-metadata", { headers: { Cookie: adminCookie } });
  assert.equal(detail.response.status, 200);
  assert.deepEqual(detail.payload.formalJobs.map((job) => job.job_type).sort(), ["prediction_close", "publish", "ranking_rebuild", "score"]);
  assert.ok(detail.payload.formalJobs.every((job) => job.competition_type === "ASIA_CS" && job.competition_id === "asia-cs-2026"));
  assert.equal(detail.payload.formalJobs.some((job) => /npb|probable|roster|lineup/i.test(job.job_type)), false);
});

test("大会のチーム所属と日時境界をサーバー側で検証する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const admin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const adminCookie = authCookie(admin);
  await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ competitionId: "asia-cs", teamKey: "home", displayName: "Home", shortName: "H" }) });
  await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ competitionId: "asia-cs", teamKey: "away", displayName: "Away", shortName: "A" }) });
  const foreignTeam = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ competitionId: "other-cup", teamKey: "foreign", displayName: "Foreign", shortName: "F" }) });
  assert.equal(foreignTeam.response.status, 201);
  const missingTeam = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "bad-team-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00", homeTeamId: "missing", homeTeamName: "Missing", awayTeamId: "away", awayTeamName: "Away" }) });
  assert.equal(missingTeam.response.status, 409);
  const afterStart = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "bad-time-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T10:00:00+09:00" }) });
  assert.equal(afterStart.response.status, 400);
  const missingDeadline = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "missing-deadline-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00" }) });
  assert.equal(missingDeadline.response.status, 400);
  const equalDeadline = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "equal-deadline-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T09:00:00+09:00" }) });
  assert.equal(equalDeadline.response.status, 400);
  const wrongDate = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "wrong-date-game", gameDate: "2026-11-14", startAt: "2026-11-15T00:00:00Z", predictionDeadlineAt: "2026-11-14T23:00:00Z" }) });
  assert.equal(wrongDate.response.status, 400);
  const ambiguousTime = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "ambiguous-time-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00" }) });
  assert.equal(ambiguousTime.response.status, 400);
  const game = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "team-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00", homeTeamId: "home", homeTeamName: "spoof", awayTeamId: "away", awayTeamName: "spoof" }) });
  assert.equal(game.response.status, 201);
  const wrongRoster = await request(worker, env, "/api/admin/games/team-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: [{ ...players[0], teamId: "unregistered" }] }) });
  assert.equal(wrongRoster.response.status, 409);
  const validRoster = await request(worker, env, "/api/admin/games/team-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: players.map((player) => ({ ...player, teamId: "home" })) }) });
  assert.equal(validRoster.response.status, 200);
  const awayPlayer = await request(worker, env, "/api/admin/games/team-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: [{ id: "away-player", name: "Away Player", teamId: "away" }] }) });
  assert.equal(awayPlayer.response.status, 200);
  const crossCompetitionPlayer = await request(worker, env, "/api/admin/games/team-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: [{ id: "foreign-player", name: "Foreign Player", teamId: "foreign" }] }) });
  assert.equal(crossCompetitionPlayer.response.status, 409);
  const missingLineupTeam = await request(worker, env, "/api/admin/games/team-game/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(missingLineupTeam.response.status, 409);
  const mixedLineup = lineup.map((item, index) => index === 8 ? { ...item, playerId: "away-player", playerName: "Away Player" } : item);
  const mixedLineupResponse = await request(worker, env, "/api/admin/games/team-game/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: mixedLineup, teamId: "home" }) });
  assert.equal(mixedLineupResponse.response.status, 409);
  const confirmed = await request(worker, env, "/api/admin/games/team-game/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup, teamId: "home" }) });
  assert.equal(confirmed.response.status, 200);
});

test("Asia CSはStarting9の外部identityを使い、client user_idと独自loginを受け付けない", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = {
    ...fixture,
    ASIA_CS_LOCAL_AUTH: "false",
    ALLOWED_ORIGIN: "https://asia-cs.test",
    AUTH_VERIFY: async (request) => request.headers.get("Cookie") === "s9_session=admin-token"
      ? { id: "starting9-admin", username: "main-admin", role: "admin" }
      : request.headers.get("Cookie") === "s9_session=user-token"
        ? { id: "starting9-user", username: "main-user", role: "user" }
        : null
  };
  const localLogin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "password" }) });
  assert.equal(localLogin.response.status, 404);
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: "s9_session=admin-token" }, body: JSON.stringify({ id: "external-game", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00" }) });
  assert.equal(created.response.status, 201);
  const roster = await request(worker, env, "/api/admin/games/external-game/players", { method: "POST", headers: { Cookie: "s9_session=admin-token" }, body: JSON.stringify({ players }) });
  assert.equal(roster.response.status, 200);
  const anonymous = await request(worker, env, "/api/games/external-game/prediction", { method: "PUT", body: JSON.stringify({ userId: "attacker", lineup }) });
  assert.equal(anonymous.response.status, 401);
  const saved = await request(worker, env, "/api/games/external-game/prediction", { method: "PUT", headers: { Cookie: "s9_session=user-token" }, body: JSON.stringify({ userId: "attacker", lineup }) });
  assert.equal(saved.response.status, 200);
  assert.equal(fixture.database.prepare("SELECT user_id FROM predictions WHERE game_id = 'external-game'").get().user_id, "starting9-user");
  assert.equal(fixture.database.prepare("SELECT auth_source FROM users WHERE id = 'starting9-user'").get().auth_source, "starting9");
});

test("Asia CSのHTTPS認証連携はs9_sessionだけをStarting9へ転送し、失敗時は匿名扱いにする", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input, init });
    const cookie = new Headers(init.headers || {}).get("Cookie");
    if (cookie === "s9_session=remote-user") return new Response(JSON.stringify({ ok: true, authenticated: true, user: { id: "remote-user", username: "remote", role: "user" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, authenticated: false, user: null }), { status: 200 });
  };
  try {
    const env = { ...fixture, STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev", ALLOWED_ORIGIN: "https://asia-cs.test" };
    const authenticated = await request(worker, env, "/api/auth/me", { headers: { Cookie: "s9_session=remote-user" } });
    assert.equal(authenticated.response.status, 200);
    assert.deepEqual(authenticated.payload.user, { id: "remote-user", username: "remote", role: "user" });
    assert.equal(calls[0].input, "https://starting9-auth.starting9.workers.dev/api/auth/me");
    assert.equal(new Headers(calls[0].init.headers).get("Cookie"), "s9_session=remote-user");
    assert.equal(calls[0].init.redirect, "error");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    const anonymous = await request(worker, env, "/api/auth/me");
    assert.deepEqual(anonymous.payload, { ok: true, authenticated: false, user: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Starting9 Authのorigin allowlist・timeout・redirect失敗はfail closedする", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init = {}) => {
    calls += 1;
    assert.equal(init.redirect, "error");
    await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("upstream timeout")), { once: true }));
  };
  try {
    const blocked = await request(worker, { ...fixture, STARTING9_AUTH_BASE_URL: "https://starting9-auth.attacker.example" }, "/api/auth/me", { headers: { Cookie: "s9_session=blocked" } });
    assert.deepEqual(blocked.payload, { ok: true, authenticated: false, user: null });
    assert.equal(calls, 0);
    const timedOut = await request(worker, { ...fixture, ASIA_CS_ENV: "test", AUTH_UPSTREAM_TIMEOUT_MS: "5", STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev" }, "/api/auth/me", { headers: { Cookie: "s9_session=timeout" } });
    assert.deepEqual(timedOut.payload, { ok: true, authenticated: false, user: null });
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response("upstream failure", { status: 503 });
    const serverError = await request(worker, { ...fixture, STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev" }, "/api/auth/me", { headers: { Cookie: "s9_session=server-error" } });
    assert.deepEqual(serverError.payload, { ok: true, authenticated: false, user: null });
    globalThis.fetch = async () => new Response("{", { status: 200 });
    const invalidJson = await request(worker, { ...fixture, STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev" }, "/api/auth/me", { headers: { Cookie: "s9_session=invalid-json" } });
    assert.deepEqual(invalidJson.payload, { ok: true, authenticated: false, user: null });
    globalThis.fetch = async () => { throw new TypeError("redirect rejected"); };
    const redirect = await request(worker, { ...fixture, STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev" }, "/api/auth/me", { headers: { Cookie: "s9_session=redirect" } });
    assert.deepEqual(redirect.payload, { ok: true, authenticated: false, user: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ranking snapshot migrationはfresh適用と0001〜0003からのupgrade適用を通過する", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(migration);
  const upgraded = new DatabaseSync(":memory:");
  upgraded.exec(migrationSql.slice(0, 3).join("\n"));
  upgraded.exec(migrationSql[3]);
  for (const database of [fresh, upgraded]) {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'competition_ranking_generations'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'competition_ranking_entries'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'competition_ranking_publications'").get().count, 1);
    assert.ok(database.prepare("PRAGMA table_info(formal_jobs)").all().some((column) => column.name === "artifact_generation"));
  }
});

test("ranking_rebuildは対象試合までの大会単位世代を作り、再実行・公開順序・別大会分離を保証する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const admin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const userA = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "rank-a", password: "rank-password" }) });
  const userB = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "rank-b", password: "rank-password" }) });
  const adminCookie = authCookie(admin);
  const create = async (id, competitionId) => request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id, competitionId, gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00" }) });
  assert.equal((await create("rank-a-game", "asia-cs")).response.status, 201);
  assert.equal((await create("rank-b-game", "asia-cs")).response.status, 201);
  assert.equal((await create("other-game", "other-cup")).response.status, 201);
  const markScored = (gameId) => {
    fixture.database.prepare("UPDATE games SET status = 'scored', publication_status = 'pending', current_lineup_revision = 1 WHERE id = ?").run(gameId);
    fixture.database.prepare(`INSERT INTO scoring_runs (id, game_id, revision_number, kind, processed_count, score_changed_count, started_at, completed_at, created_by)
      VALUES (?, ?, 1, 'initial', 2, 2, ?, ?, ?)`).run(`run-${gameId}`, gameId, "2026-11-15T08:01:00.000Z", "2026-11-15T08:02:00.000Z", userA.payload.user.id);
  };
  markScored("rank-a-game");
  markScored("rank-b-game");
  markScored("other-game");
  const insertScore = (id, userId, gameId, score) => fixture.database.prepare(`INSERT INTO predictions
    (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES (?, ?, ?, '{}', ?, ?, 'scored', ?, 99, 1, '{}', ?, 0)`).run(id, userId, gameId, "2026-11-15T07:00:00.000Z", "2026-11-15T07:00:00.000Z", score, "2026-11-15T08:02:00.000Z");
  insertScore("score-a1", userA.payload.user.id, "rank-a-game", 90);
  insertScore("score-a2", userA.payload.user.id, "rank-b-game", 60);
  insertScore("score-b1", userB.payload.user.id, "rank-a-game", 100);
  insertScore("score-other", userA.payload.user.id, "other-game", 999);
  const rebuilt = await request(worker, env, "/api/admin/games/rank-a-game/ranking", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(rebuilt.response.status, 200);
  const rows = fixture.database.prepare("SELECT user_id, score_total, games_count, rank, generation FROM competition_ranking_entries WHERE competition_id = 'asia-cs' ORDER BY rank").all();
  assert.deepEqual(rows.map((row) => [row.user_id, row.score_total, row.games_count, row.rank, row.generation]), [[userB.payload.user.id, 100, 1, 1, 1], [userA.payload.user.id, 90, 1, 2, 1]]);
  assert.equal(fixture.database.prepare("SELECT target_game_id FROM competition_ranking_generations WHERE competition_id = 'asia-cs' AND generation = 1").get().target_game_id, "rank-a-game");
  const repeated = await request(worker, env, "/api/admin/games/rank-a-game/ranking", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.noop, true);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM competition_ranking_entries WHERE competition_id = 'asia-cs'").get().count, 2);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM competition_ranking_entries WHERE competition_id = 'other-cup'").get().count, 0);
  assert.deepEqual((await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking, []);
  assert.equal((await request(worker, env, "/api/admin/games/rank-a-game/publish", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  const publicRows = (await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking;
  assert.deepEqual(publicRows.map((row) => [row.username, row.score, row.gamesCount]), [["rank-b", 100, 1], ["rank-a", 90, 1]]);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRows[0], "userId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRows[0], "generation"), false);
  const rankB = await request(worker, env, "/api/admin/games/rank-b-game/ranking", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(rankB.response.status, 200);
  assert.notEqual(rankB.payload.generation, rebuilt.payload.generation);
  const rankANoop = await request(worker, env, "/api/admin/games/rank-a-game/ranking", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(rankANoop.payload.noop, true);
  assert.equal(rankANoop.payload.generation, rebuilt.payload.generation);
  assert.deepEqual((await request(worker, env, "/api/admin/games/rank-b-game/publish", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  const publishedBoth = (await request(worker, env, "/api/rankings?competitionId=asia-cs")).payload.ranking;
  assert.deepEqual(publishedBoth.map((row) => [row.username, row.score, row.gamesCount]), [["rank-a", 150, 2], ["rank-b", 100, 1]]);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM competition_ranking_entries WHERE competition_id = 'asia-cs' AND generation = 2").get().count, 2);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM competition_ranking_publications WHERE competition_id = 'asia-cs'").get().count, 1);
  assert.equal((await request(worker, env, "/api/rankings")).response.status, 400);
});

test("Asia CS Best Nineは未公開では返さず、得点・提出時刻・username・user_id順を固定する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  assert.equal(bootstrap.response.status, 201);
  const admin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const game = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: authCookie(admin) }, body: JSON.stringify({ id: "b9-test", title: "B9", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }) });
  assert.equal(game.response.status, 201);
  const hidden = await request(worker, env, "/api/games/b9-test/best-nine");
  assert.deepEqual(hidden.payload, { ok: true, published: false, bestNine: [], totalCount: 0 });
});

test("Best Nineは公開済み現行revisionの得点上位9人だけを同点規則どおり返す", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" }, body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const admin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  assert.equal(bootstrap.response.status, 201);
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: authCookie(admin) }, body: JSON.stringify({ id: "b9-ranking", title: "B9", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }) });
  assert.equal(created.response.status, 201);
  fixture.database.prepare("UPDATE games SET status = 'published', publication_status = 'published', current_lineup_revision = 1 WHERE id = ?").run("b9-ranking");
  fixture.database.prepare("INSERT INTO scoring_runs (id, game_id, revision_number, kind, processed_count, score_changed_count, started_at, completed_at, created_by) VALUES (?, ?, 1, 'initial', 11, 0, ?, ?, ?)").run("b9-run", "b9-ranking", "2026-09-22T00:00:00.000Z", "2026-09-22T00:01:00.000Z", bootstrap.payload.user.id);
  const names = ["zeta", "alpha", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10", "u11", "stale"];
  const users = [];
  for (const username of names) {
    const registration = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username, password: "password-123" }) });
    users.push(registration.payload.user.id);
  }
  const scores = [99, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90];
  users.slice(0, 11).forEach((userId, index) => {
    fixture.database.prepare(`INSERT INTO predictions (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
      VALUES (?, ?, ?, '[]', ?, ?, 'scored', ?, 99, 1, '[]', ?, 0)`).run(`b9-${index}`, userId, "b9-ranking", "2026-09-22T00:00:00.000Z", "2026-09-22T00:00:00.000Z", scores[index], "2026-09-22T00:01:00.000Z");
  });
  fixture.database.prepare(`INSERT INTO predictions (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES (?, ?, ?, '[]', ?, ?, 'scored', 1000, 99, 0, '[]', ?, 0)`).run("b9-stale", users[11], "b9-ranking", "2026-09-22T00:00:00.000Z", "2026-09-22T00:00:00.000Z", "2026-09-22T00:01:00.000Z");

  const result = await request(worker, env, "/api/games/b9-ranking/best-nine");
  assert.equal(result.payload.published, true);
  assert.equal(result.payload.totalCount, 11);
  assert.deepEqual(result.payload.bestNine.map((row) => [row.rank, row.username, row.score]), [
    [1, "alpha", 99], [2, "zeta", 99], [3, "u3", 98], [4, "u4", 97], [5, "u5", 96],
    [6, "u6", 95], [7, "u7", 94], [8, "u8", 93], [9, "u9", 92]
  ]);
});

test("管理者bootstrapは一度だけで、公開登録・一般ユーザーから管理者になれない", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "one-time-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const publicAdminName = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "admin", password: "public-password", role: "admin" }) });
  assert.equal(publicAdminName.response.status, 201);
  assert.equal(publicAdminName.payload.user.role, "user");
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "one-time-token" }, body: JSON.stringify({ username: "operator", password: "operator-password" }) });
  assert.equal(bootstrap.response.status, 201);
  const secondBootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "one-time-token" }, body: JSON.stringify({ username: "operator-2", password: "operator-password" }) });
  assert.equal(secondBootstrap.response.status, 409);
  const invalidToken = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "wrong-token" }, body: JSON.stringify({ username: "operator-3", password: "operator-password" }) });
  assert.equal(invalidToken.response.status, 403);

  const regular = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "regular", password: "regular-password" }) });
  const managementRequests = [
    ["POST", "/api/admin/games", { id: "auth-test", title: "Auth", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }],
    ["GET", "/api/admin/games/auth-test"],
    ["POST", "/api/admin/games/auth-test/players", { players }],
    ["PUT", "/api/admin/games/auth-test/players/p1", { name: "Changed" }],
    ["POST", "/api/admin/games/auth-test/lineup", { lineup }],
    ["POST", "/api/admin/games/auth-test/score"],
    ["POST", "/api/admin/games/auth-test/publish"],
    ["POST", "/api/admin/games/auth-test/rescore", { lineup, reason: "test" }]
  ];
  for (const [method, path, body] of managementRequests) {
    const unauthenticated = await request(worker, env, path, { method, body: body ? JSON.stringify(body) : undefined });
    assert.equal(unauthenticated.response.status, 401, `${method} ${path} must require authentication`);
    const regularResponse = await request(worker, env, path, { method, headers: { Cookie: authCookie(regular) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(regularResponse.response.status, 403, `${method} ${path} must require admin role`);
  }

  const adminLogin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "operator", password: "operator-password" }) });
  const adminCookie = authCookie(adminLogin);
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "auth-test", title: "Auth", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }) });
  assert.equal(created.response.status, 201);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test", { method: "GET", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players }) })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/players/p1", { method: "PUT", headers: { Cookie: adminCookie }, body: JSON.stringify({ name: "Changed" }) })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/score", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/ranking", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/publish", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/auth-test/rescore", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup, reason: "test" }) })).response.status, 200);
});

test("採点は状態遷移・batch rollback・並列実行を保護する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const failure = { enabled: false, used: false, statementIndex: 2 };
  const fixture = createDatabase({ failure });
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "one-time-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", { method: "POST", headers: { "X-Admin-Bootstrap-Token": "one-time-token" }, body: JSON.stringify({ username: "operator", password: "operator-password" }) });
  const admin = await request(worker, env, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "operator", password: "operator-password" }) });
  assert.equal(bootstrap.response.status, 201);
  const adminCookie = authCookie(admin);
  const fan = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "fan", password: "fan-password" }) });
  const fanCookie = authCookie(fan);
  const future = "2026-11-15T09:00:00+09:00";
  await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "retry-test", title: "Retry", gameDate: "2026-11-15", startAt: future, predictionDeadlineAt: "2026-11-15T08:00:00+09:00" }) });
  await request(worker, env, "/api/admin/games/retry-test/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players }) });
  await request(worker, env, "/api/games/retry-test/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup }) });
  fixture.database.prepare("UPDATE games SET prediction_deadline_at = ?, status = 'open' WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), "retry-test");
  fixture.database.prepare("UPDATE predictions SET submitted_at = ? WHERE game_id = ?").run(new Date(Date.now() - 2000).toISOString(), "retry-test");
  await request(worker, env, "/api/admin/games/retry-test/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) });

  failure.enabled = true;
  const failed = await request(worker, env, "/api/admin/games/retry-test/score", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(failed.response.status, 500);
  assert.equal(fixture.database.prepare("SELECT status FROM games WHERE id = 'retry-test'").get().status, "lineup_confirmed");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'retry-test'").get().count, 0);
  assert.equal(fixture.database.prepare("SELECT status, score FROM predictions WHERE game_id = 'retry-test'").get().status, "submitted");

  failure.enabled = false;
  const recovered = await request(worker, env, "/api/admin/games/retry-test/score", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(recovered.response.status, 200);
  const duplicateInitial = await request(worker, env, "/api/admin/games/retry-test/score", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(duplicateInitial.response.status, 409);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'retry-test' AND kind = 'initial'").get().count, 1);
  assert.equal((await request(worker, env, "/api/admin/games/retry-test/ranking", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/retry-test/publish", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 200);
  assert.equal((await request(worker, env, "/api/admin/games/retry-test/score", { method: "POST", headers: { Cookie: adminCookie } })).response.status, 409);

  const parallelPlayers = players;
  await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "parallel-test", title: "Parallel", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }) });
  const parallelRoster = await request(worker, env, "/api/admin/games/parallel-test/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: parallelPlayers }) });
  assert.equal(parallelRoster.payload.players.length, 9);
  assert.notEqual(parallelRoster.payload.players.find((player) => player.name === "Player 1").id, "p1");
  const parallelLineup = lineup.map((item) => ({ ...item, playerId: parallelRoster.payload.players.find((player) => player.name === item.playerName).id }));
  await request(worker, env, "/api/admin/games/parallel-test/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: parallelLineup }) });
  fixture.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), "parallel-test");
  const parallelScores = await Promise.all([
    request(worker, env, "/api/admin/games/parallel-test/score", { method: "POST", headers: { Cookie: adminCookie } }),
    request(worker, env, "/api/admin/games/parallel-test/score", { method: "POST", headers: { Cookie: adminCookie } })
  ]);
  const parallelScoreStatuses = parallelScores.map(({ response }) => response.status).sort();
  assert.ok(parallelScoreStatuses.join(",") === "200,200" || parallelScoreStatuses.join(",") === "200,409");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'parallel-test' AND kind = 'initial'").get().count, 1);

  const corrected = lineup.map((item) => ({ ...item }));
  [corrected[6].position, corrected[7].position] = [corrected[7].position, corrected[6].position];
  const parallelRescores = await Promise.all([
    request(worker, env, "/api/admin/games/retry-test/rescore", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: corrected, reason: "parallel-1" }) }),
    request(worker, env, "/api/admin/games/retry-test/rescore", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: corrected, reason: "parallel-2" }) })
  ]);
  const parallelRescoreStatuses = parallelRescores.map(({ response }) => response.status).sort();
  assert.ok(parallelRescoreStatuses.join(",") === "200,200" || parallelRescoreStatuses.join(",") === "200,409");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'retry-test' AND revision_number = 2 AND kind = 'rescore'").get().count, 1);
  assert.equal(fixture.database.prepare("SELECT current_lineup_revision FROM games WHERE id = 'retry-test'").get().current_lineup_revision, 2);
});
