import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/asia-cs-japan-synthetic-players.json"), "utf8"));
const migration = fs.readdirSync(path.join(root, "asia-cs/migrations"))
  .filter((file) => /^\d+_.*\.sql$/.test(file))
  .sort()
  .map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8"))
  .join("\n");

function createD1Adapter(database) {
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
        for (const statement of statements) statement._execute();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, DB: createD1Adapter(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test" };
}

async function request(worker, env, endpoint, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${endpoint}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

function cookie(response) {
  return response.cookie.split(";")[0];
}

function jsonOptions(method, sessionCookie, body) {
  return {
    method,
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function tokyoParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return values;
}

function tokyoIso(date) {
  const values = tokyoParts(date);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00+09:00`;
}

function lineupForPlayers(playersById, ids, overrides = {}) {
  return ids.map((id, index) => ({
    battingOrder: index + 1,
    playerId: id,
    playerName: playersById.get(id).name,
    position: overrides[id] || playersById.get(id).position
  }));
}

test("Asia CS Japan synthetic local E2E: roster → prediction → score → ranking → publish", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const local = createFixture();
  const env = {
    ...local,
    ADMIN_BOOTSTRAP_TOKEN: "synthetic-e2e-bootstrap",
    ALLOWED_ORIGIN: "https://asia-cs.test"
  };
  const competitionId = "ASIA-CS-JAPAN-E2E";
  const gameId = "asia-cs-japan-e2e-01";

  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": env.ADMIN_BOOTSTRAP_TOKEN },
    body: JSON.stringify({ username: "synthetic-admin", password: "synthetic-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const adminLogin = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "synthetic-admin", password: "synthetic-admin-password" })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = cookie(adminLogin);

  const users = [];
  for (const username of ["synthetic-fan-a", "synthetic-fan-b", "synthetic-fan-c"]) {
    const registration = await request(worker, env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password: `${username}-password` })
    });
    assert.equal(registration.response.status, 201);
    users.push({ username, cookie: cookie(registration) });
  }

  const competition = await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, {
    id: competitionId,
    displayName: "Asia CS Japan Synthetic E2E",
    shortName: "JPN E2E",
    status: "draft"
  }));
  assert.equal(competition.response.status, 200);
  assert.equal(competition.payload.competition.status, "draft");

  const japan = await request(worker, env, "/api/admin/teams", jsonOptions("POST", adminCookie, {
    competitionId,
    teamKey: "team-jpn",
    displayName: "Japan Synthetic",
    shortName: "JPN-T",
    countryCode: "JPN"
  }));
  const opponent = await request(worker, env, "/api/admin/teams", jsonOptions("POST", adminCookie, {
    competitionId,
    teamKey: "team-kor",
    displayName: "Opponent Synthetic",
    shortName: "OPP",
    countryCode: "TST"
  }));
  assert.equal(japan.response.status, 201);
  assert.equal(opponent.response.status, 201);
  const japanTeamId = japan.payload.team.id;

  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const deadline = new Date(Date.now() + 60 * 60 * 1000);
  const game = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, {
    id: gameId,
    title: "Japan Synthetic vs Opponent Synthetic",
    competitionId,
    gameDate: tokyoParts(start).year + "-" + tokyoParts(start).month + "-" + tokyoParts(start).day,
    startAt: tokyoIso(start),
    predictionDeadlineAt: tokyoIso(deadline),
    homeTeamId: "team-jpn",
    homeTeamName: "Japan Synthetic",
    awayTeamId: "team-kor",
    awayTeamName: "Opponent Synthetic"
  }));
  assert.equal(game.response.status, 201);
  assert.equal(game.payload.game.competitionId, competitionId);
  assert.equal(game.payload.game.homeTeam.id, "team-jpn");
  assert.equal(game.payload.game.awayTeam.id, "team-kor");

  const imported = await request(worker, env, "/api/admin/players/import", jsonOptions("POST", adminCookie, {
    gameId,
    players: fixture.players.map((player) => ({ ...player, teamId: fixture.teamKey }))
  }));
  assert.equal(imported.response.status, 200);
  assert.equal(imported.payload.imported, 15);
  assert.equal(imported.payload.players.length, 15);
  assert.equal(new Set(imported.payload.players.map((player) => player.uniformNumber)).size, 15);
  assert.ok(imported.payload.players.every((player) => player.active === true && player.teamId === japanTeamId));
  assert.ok(imported.payload.players.every((player) => /^TEST-JPN-\d{2}$/.test(player.name)));
  assert.equal(imported.payload.players.filter((player) => ["捕"].includes(player.position)).length, 2);
  assert.equal(imported.payload.players.filter((player) => ["一", "二", "三", "遊"].includes(player.position)).length, 8);
  assert.equal(imported.payload.players.filter((player) => ["左", "中", "右"].includes(player.position)).length, 5);

  const duplicateImport = await request(worker, env, "/api/admin/players/import", jsonOptions("POST", adminCookie, {
    gameId,
    players: fixture.players.map((player) => ({ ...player, teamId: fixture.teamKey }))
  }));
  assert.equal(duplicateImport.response.status, 200);
  assert.equal(duplicateImport.payload.imported, 15);
  assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = ?").get(gameId).count, 15);

  const invalidBefore = local.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = ?").get(gameId).count;
  const invalidImport = await request(worker, env, "/api/admin/players/import", jsonOptions("POST", adminCookie, {
    gameId,
    players: [{ ...fixture.players[0], id: "jp-test-invalid", name: "TEST-JPN-INVALID", teamId: "team-unknown" }]
  }));
  assert.equal(invalidImport.response.status, 409);
  assert.equal(invalidImport.payload.code, "TEAM_NOT_IN_COMPETITION");
  assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = ?").get(gameId).count, invalidBefore);

  const publicGame = await request(worker, env, `/api/games/${gameId}`);
  assert.equal(publicGame.response.status, 200);
  assert.equal(publicGame.payload.game.players.length, 15);
  assert.deepEqual(publicGame.payload.game.players.map((player) => player.id).sort(), fixture.players.map((player) => player.id).sort());

  const playersById = new Map(imported.payload.players.map((player) => [player.id, player]));
  const officialIds = ["jp-test-01", "jp-test-03", "jp-test-05", "jp-test-07", "jp-test-09", "jp-test-11", "jp-test-13", "jp-test-14", "jp-test-15"];
  const officialLineup = lineupForPlayers(playersById, officialIds, {
    "jp-test-01": "捕", "jp-test-03": "一", "jp-test-05": "二", "jp-test-07": "三",
    "jp-test-09": "遊", "jp-test-11": "左", "jp-test-13": "中", "jp-test-14": "右", "jp-test-15": "指"
  });
  const benchIds = fixture.players.map((player) => player.id).filter((id) => !officialIds.includes(id));
  assert.equal(officialLineup.length, 9);
  assert.equal(benchIds.length, 6);

  const predictionA = officialLineup.map((item) => ({ ...item }));
  const predictionB = officialLineup.map((item) => ({ ...item }));
  [predictionB[0].battingOrder, predictionB[1].battingOrder] = [predictionB[1].battingOrder, predictionB[0].battingOrder];
  const predictionC = officialLineup.map((item) => ({ ...item }));
  predictionC[0] = { ...predictionC[0], playerId: "jp-test-02", playerName: playersById.get("jp-test-02").name, position: "指" };
  predictionC[8] = { ...predictionC[8], playerId: "jp-test-15", playerName: playersById.get("jp-test-15").name, position: "捕" };
  const predictions = [predictionA, predictionB, predictionC];
  for (const [index, user] of users.entries()) {
    const saved = await request(worker, env, `/api/games/${gameId}/prediction`, jsonOptions("PUT", user.cookie, { lineup: predictions[index], teamId: "team-jpn" }));
    assert.equal(saved.response.status, 200, user.username);
    assert.equal(saved.payload.prediction.lineup.length, 9);
  }

  const duplicatePrediction = predictionA.map((item) => ({ ...item }));
  duplicatePrediction[8] = { ...duplicatePrediction[8], playerId: duplicatePrediction[0].playerId, playerName: duplicatePrediction[0].playerName };
  const duplicateResult = await request(worker, env, `/api/games/${gameId}/prediction`, jsonOptions("PUT", users[0].cookie, { lineup: duplicatePrediction, teamId: "team-jpn" }));
  assert.equal(duplicateResult.response.status, 400);
  assert.equal(duplicateResult.payload.code, "DUPLICATE_PLAYER");
  const teamMismatch = await request(worker, env, `/api/games/${gameId}/prediction`, jsonOptions("PUT", users[0].cookie, { lineup: predictionA, teamId: "team-kor" }));
  assert.equal(teamMismatch.response.status, 409);
  assert.equal(teamMismatch.payload.code, "LINEUP_TEAM_MISMATCH");

  const lineup = await request(worker, env, `/api/admin/games/${gameId}/lineup`, jsonOptions("POST", adminCookie, { teamId: "team-jpn", lineup: officialLineup }));
  assert.equal(lineup.response.status, 200);
  assert.equal(lineup.payload.lineupRevision.revision, 1);
  assert.equal(local.database.prepare("SELECT status FROM games WHERE id = ?").get(gameId).status, "lineup_confirmed");

  const beforeCloseScore = await request(worker, env, `/api/admin/games/${gameId}/score`, jsonOptions("POST", adminCookie, {}));
  assert.equal(beforeCloseScore.response.status, 409);
  assert.equal(beforeCloseScore.payload.code, "PREDICTION_OPEN");
  assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = ?").get(gameId).count, 0);

  const closedAt = new Date(Date.now() - 10_000).toISOString();
  const submittedAt = new Date(Date.now() - 20_000).toISOString();
  local.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(closedAt, gameId);
  local.database.prepare("UPDATE predictions SET submitted_at = ? WHERE game_id = ?").run(submittedAt, gameId);

  const unpublishedPrediction = await request(worker, env, `/api/games/${gameId}/prediction`, { headers: { Cookie: users[0].cookie } });
  assert.equal(unpublishedPrediction.response.status, 200);
  assert.equal(unpublishedPrediction.payload.prediction.status, "submitted");
  assert.equal(Object.prototype.hasOwnProperty.call(unpublishedPrediction.payload.prediction, "score"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(unpublishedPrediction.payload.prediction, "actualLineup"), false);

  const score = await request(worker, env, `/api/admin/games/${gameId}/score`, jsonOptions("POST", adminCookie, {}));
  assert.equal(score.response.status, 200);
  assert.equal(score.payload.scored, 3);
  assert.equal(score.payload.scoreChangedCount, 3);
  const scoreRows = local.database.prepare("SELECT u.username, p.score, p.max_score, p.status FROM predictions p JOIN users u ON u.id = p.user_id WHERE p.game_id = ? ORDER BY u.username").all(gameId);
  assert.deepEqual(scoreRows.map((row) => [row.username, row.score, row.max_score, row.status]), [
    ["synthetic-fan-a", 99, 99, "scored"],
    ["synthetic-fan-b", 91, 99, "scored"],
    ["synthetic-fan-c", 85, 99, "scored"]
  ]);
  // The canonical Starting9 contract is 99 points: player 45 + order 27 +
  // position 18 + exact-match bonus 9. Asia CS deliberately reuses it.
  assert.ok(scoreRows.every((row) => Number(row.score) >= 0 && Number(row.score) <= 99));
  assert.ok(scoreRows.every((row) => Number(row.max_score) === 99));
  assert.equal(local.database.prepare("SELECT status FROM games WHERE id = ?").get(gameId).status, "scored");
  assert.equal((await request(worker, env, `/api/games/${gameId}/result`)).response.status, 404);

  const beforeRanking = await request(worker, env, `/api/admin/games/${gameId}/publish`, jsonOptions("POST", adminCookie, {}));
  assert.equal(beforeRanking.response.status, 409);
  assert.equal(beforeRanking.payload.code, "RANKING_INCOMPLETE");
  assert.deepEqual((await request(worker, env, `/api/rankings?competitionId=${competitionId}`)).payload.ranking, []);

  const ranking = await request(worker, env, `/api/admin/games/${gameId}/ranking`, jsonOptions("POST", adminCookie, {}));
  assert.equal(ranking.response.status, 200);
  assert.equal(ranking.payload.rows, 3);
  assert.deepEqual((await request(worker, env, `/api/rankings?competitionId=${competitionId}`)).payload.ranking, []);

  const published = await request(worker, env, `/api/admin/games/${gameId}/publish`, jsonOptions("POST", adminCookie, {}));
  assert.equal(published.response.status, 200);
  const publicRanking = await request(worker, env, `/api/rankings?competitionId=${competitionId}`);
  assert.equal(publicRanking.response.status, 200);
  assert.deepEqual(publicRanking.payload.ranking.map((row) => [row.rank, row.username, row.score, row.gamesCount]), [
    [1, "synthetic-fan-a", 99, 1],
    [2, "synthetic-fan-b", 91, 1],
    [3, "synthetic-fan-c", 85, 1]
  ]);

  const result = await request(worker, env, `/api/games/${gameId}/result`, { headers: { Cookie: users[0].cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.game.competitionId, competitionId);
  assert.deepEqual(result.payload.officialLineup.map((item) => item.playerId), officialIds);
  assert.equal(result.payload.prediction.score, 99);
  assert.equal(result.payload.prediction.maxScore, 99);
  assert.deepEqual(result.payload.prediction.breakdown, {
    player: { hits: 9, points: 45, max: 45 },
    order: { hits: 9, points: 27, max: 27 },
    position: { hits: 9, points: 18, max: 18 },
    perfect: { hits: 9, points: 9, max: 9 },
    total: 99
  });
  for (const [index, expected] of [[1, { score: 91, playerHits: 9, orderHits: 7, positionHits: 9, perfectHits: 7 }], [2, { score: 85, playerHits: 8, orderHits: 8, positionHits: 7, perfectHits: 7 }]]) {
    const otherResult = await request(worker, env, `/api/games/${gameId}/result`, { headers: { Cookie: users[index].cookie } });
    const prediction = otherResult.payload.prediction;
    assert.equal(prediction.maxScore, 99);
    assert.ok(prediction.score >= 0 && prediction.score <= prediction.maxScore);
    assert.equal(prediction.breakdown.player.hits, expected.playerHits);
    assert.equal(prediction.breakdown.order.hits, expected.orderHits);
    assert.equal(prediction.breakdown.position.hits, expected.positionHits);
    assert.equal(prediction.breakdown.perfect.hits, expected.perfectHits);
    assert.equal(prediction.score, expected.score);
    assert.equal(prediction.breakdown.total, prediction.breakdown.player.points + prediction.breakdown.order.points + prediction.breakdown.position.points + prediction.breakdown.perfect.points);
  }
  const publishedPrediction = await request(worker, env, `/api/games/${gameId}/prediction`, { headers: { Cookie: users[0].cookie } });
  assert.equal(publishedPrediction.response.status, 200);
  assert.equal(publishedPrediction.payload.prediction.score, 99);
  assert.deepEqual(publishedPrediction.payload.prediction.actualLineup, officialLineup);

  const bestNine = await request(worker, env, `/api/games/${gameId}/best-nine`);
  assert.equal(bestNine.response.status, 200);
  assert.equal(bestNine.payload.published, true);
  assert.equal(bestNine.payload.totalCount, 3);
  assert.equal(bestNine.payload.bestNine.length, 3);
  assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ? AND status = 'completed'").get(gameId).count, 4);
  assert.ok(local.database.prepare("SELECT 1 FROM formal_jobs WHERE game_id = ? AND job_type = 'prediction_close' AND status = 'completed'").get(gameId));
  assert.ok(local.database.prepare("SELECT 1 FROM formal_jobs WHERE game_id = ? AND job_type = 'score' AND status = 'completed'").get(gameId));
  assert.ok(local.database.prepare("SELECT 1 FROM formal_jobs WHERE game_id = ? AND job_type = 'ranking_rebuild' AND status = 'completed'").get(gameId));
  assert.ok(local.database.prepare("SELECT 1 FROM formal_jobs WHERE game_id = ? AND job_type = 'publish' AND status = 'completed'").get(gameId));
  assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ? AND job_type NOT IN ('prediction_close', 'score', 'ranking_rebuild', 'publish')").get(gameId).count, 0);
});

test("Japan synthetic fixture is explicitly test-only and contains no official player names", () => {
  assert.equal(fixture.testOnly, true);
  assert.equal(fixture.official, false);
  assert.equal(fixture.players.length, 15);
  assert.ok(fixture.players.every((player) => /^TEST-JPN-\d{2}$/.test(player.name)));
  assert.doesNotMatch(JSON.stringify(fixture), /大谷|山本|村上|佐々木|鈴木/);
});
