import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { V3_TIMING } from "../backend/automation-v3/constants.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = path.join(root, "asia-cs/staging/phase4");
const migrationFiles = [
  "0001_asia_cs_mvp.sql",
  "0002_competition_and_formal_jobs.sql",
  "0003_review_hardening.sql",
  "0004_ranking-generation-snapshots.sql",
  "0005_publication-revision.sql",
  "0006_phase2-product.sql",
  "0007_phase2-roster-metadata.sql"
];
const migration = migrationFiles.map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8")).join("\n");

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

async function request(worker, env, pathName, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${pathName}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

function authCookie(result) {
  return result.cookie.split(";")[0];
}

function jsonOptions(method, cookie, body) {
  return {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

const stagingCompetition = JSON.parse(fs.readFileSync(path.join(stagingRoot, "competition.json"), "utf8"));
const stagingTeams = JSON.parse(fs.readFileSync(path.join(stagingRoot, "teams.json"), "utf8"));
const stagingGames = JSON.parse(fs.readFileSync(path.join(stagingRoot, "games.json"), "utf8"));
const bracketGames = JSON.parse(fs.readFileSync(path.join(stagingRoot, "bracket-games.template.json"), "utf8"));
const stagingPlayers = JSON.parse(fs.readFileSync(path.join(stagingRoot, "players.template.json"), "utf8"));

test("Phase 4A staging data has only official, production-safe facts", () => {
  assert.equal(stagingCompetition.status, "draft");
  assert.equal(stagingCompetition.readyForProduction, false);
  assert.deepEqual([stagingCompetition.startDate, stagingCompetition.endDate], ["2026-11-12", "2026-11-15"]);
  assert.equal(stagingCompetition.venue, "東京ドーム");
  assert.deepEqual(stagingTeams.map((team) => team.teamKey), ["jpn", "aus", "tpe", "kor"]);
  assert.equal(new Set(stagingTeams.map((team) => team.teamKey)).size, 4);
  assert.equal(stagingGames.length, 6);
  for (const game of stagingGames) {
    assert.equal(game.readyForProduction, false);
    assert.match(game.startAt, /\+09:00$/);
    assert.match(game.predictionDeadlineAt, /\+09:00$/);
    assert.equal(new Date(game.startAt).getTime() - new Date(game.predictionDeadlineAt).getTime(), V3_TIMING.predictionDeadlineMinutes * 60_000);
    assert.ok(new Date(game.predictionDeadlineAt).getTime() < new Date(game.startAt).getTime());
    assert.ok(stagingTeams.some((team) => team.teamKey === game.homeTeamId));
    assert.ok(stagingTeams.some((team) => team.teamKey === game.awayTeamId));
    assert.notEqual(game.homeTeamId, game.awayTeamId);
    assert.equal(game.startAt.slice(0, 10), game.gameDate);
  }
  for (const game of bracketGames) {
    assert.equal(game.readyForProduction, false);
    assert.equal(game.homeTeamId, null);
    assert.equal(game.awayTeamId, null);
    assert.equal(game.predictionDeadlineAt, null);
  }
  const template = fs.readFileSync(path.join(stagingRoot, "players.template.csv"), "utf8").trim().split(/\r?\n/);
  assert.equal(template[0], "team_key,player_id,player_name,club,registered_position,active");
  assert.equal(template.length, 16);
  assert.equal(stagingPlayers.readyForProduction, false);
  assert.equal(stagingPlayers.official, false);
  assert.equal(stagingPlayers.status, "provisional");
  assert.equal(stagingPlayers.teamKey, "jpn");
  assert.equal(stagingPlayers.players.length, 15);
  assert.equal(new Set(stagingPlayers.players.map((player) => player.id)).size, 15);
  assert.deepEqual(
    ["捕手", "内野手", "外野手"].map((position) => stagingPlayers.players.filter((player) => player.registeredPosition === position).length),
    [3, 7, 5]
  );
  for (const player of stagingPlayers.players) {
    assert.equal(player.active, true);
    assert.equal(player.teamKey, undefined);
    assert.ok(player.name);
    assert.ok(player.club);
    assert.equal(Object.hasOwn(player, "uniformNumber"), false);
    assert.equal(Object.hasOwn(player, "bat"), false);
    assert.equal(Object.hasOwn(player, "throw"), false);
  }
});

test("Phase 4A local rehearsal runs three synthetic games and protects ordering/completion", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase4-local-bootstrap", ALLOWED_ORIGIN: "https://asia-cs.test" };

  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": env.ADMIN_BOOTSTRAP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const adminLogin = await request(worker, env, "/api/auth/login", jsonOptions("POST", "", { username: "admin", password: "admin-password" }));
  const adminCookie = authCookie(adminLogin);
  const fanRegistration = await request(worker, env, "/api/auth/register", jsonOptions("POST", "", { username: "phase4-fan", password: "fan-password" }));
  const fanCookie = authCookie(fanRegistration);

  const competitionBody = {
    id: "apbc-phase4-local",
    displayName: "APBC 2026 local rehearsal",
    shortName: "APBC local",
    startDate: "2026-11-12",
    endDate: "2026-11-15",
    status: "draft",
    description: "TEST_ONLY synthetic Phase 4A rehearsal"
  };
  assert.equal((await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, competitionBody))).response.status, 200);
  for (const team of stagingTeams) {
    const result = await request(worker, env, "/api/admin/teams", jsonOptions("POST", adminCookie, {
      competitionId: competitionBody.id,
      teamKey: team.teamKey,
      displayName: team.displayName,
      shortName: team.shortName,
      countryCode: team.countryCode
    }));
    assert.equal(result.response.status, 201);
  }
  const activated = await request(worker, env, "/api/admin/competition", jsonOptions("PUT", adminCookie, { ...competitionBody, status: "active" }));
  assert.equal(activated.response.status, 200);

  const rehearsalGames = stagingGames.slice(0, 3).map((game, index) => ({
    id: `phase4-local-g${index + 1}`,
    title: `${game.title} TEST_ONLY`,
    gameDate: game.gameDate,
    startAt: game.startAt,
    // Keep the local rehearsal aligned with the shared Starting9 deadline contract.
    predictionDeadlineAt: new Date(new Date(game.startAt).getTime() - V3_TIMING.predictionDeadlineMinutes * 60_000).toISOString(),
    venue: game.venue,
    homeTeamId: game.homeTeamId,
    homeTeamName: stagingTeams.find((team) => team.teamKey === game.homeTeamId).displayName,
    awayTeamId: game.awayTeamId,
    awayTeamName: stagingTeams.find((team) => team.teamKey === game.awayTeamId).displayName
  }));
  const imported = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, { competitionId: competitionBody.id, games: rehearsalGames }));
  assert.equal(imported.response.status, 200);
  assert.equal(imported.payload.imported, 3);
  assert.deepEqual(fixture.database.prepare("SELECT competition_id, team_key FROM teams ORDER BY team_key").all().map((row) => [row.competition_id, row.team_key]), [["apbc-phase4-local", "aus"], ["apbc-phase4-local", "jpn"], ["apbc-phase4-local", "kor"], ["apbc-phase4-local", "tpe"]]);
  assert.deepEqual(fixture.database.prepare("SELECT id, competition_id, home_team_id, away_team_id FROM games ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "phase4-local-g1", competition_id: "apbc-phase4-local", home_team_id: "kor", away_team_id: "aus" },
    { id: "phase4-local-g2", competition_id: "apbc-phase4-local", home_team_id: "tpe", away_team_id: "jpn" },
    { id: "phase4-local-g3", competition_id: "apbc-phase4-local", home_team_id: "aus", away_team_id: "tpe" }
  ]);

  for (const [index, game] of rehearsalGames.entries()) {
    const homeTeam = fixture.database.prepare("SELECT id FROM teams WHERE competition_id = ? AND team_key = ?").get(competitionBody.id, game.homeTeamId);
    const players = Array.from({ length: 9 }, (_, playerIndex) => ({
      id: `${game.id}-p${playerIndex + 1}`,
      name: `TEST_ONLY ${game.id} Player ${playerIndex + 1}`,
      uniformNumber: String(playerIndex + 1),
      teamId: homeTeam.id,
      position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][playerIndex],
      active: true
    }));
    const lineup = players.map((player, playerIndex) => ({
      battingOrder: playerIndex + 1,
      playerId: player.id,
      playerName: player.name,
      position: player.position
    }));
    const roster = await request(worker, env, `/api/admin/games/${game.id}/players`, jsonOptions("POST", adminCookie, { players }));
    assert.equal(roster.response.status, 200, JSON.stringify(roster.payload));
    const saved = await request(worker, env, `/api/games/${game.id}/prediction`, jsonOptions("PUT", fanCookie, { lineup, teamId: homeTeam.id }));
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));

    const beforeClose = await request(worker, env, `/api/admin/games/${game.id}/score`, jsonOptions("POST", adminCookie, {}));
    assert.equal(beforeClose.response.status, 409);
    assert.equal(beforeClose.payload.code, "LINEUP_REQUIRED");
    const syntheticDeadline = new Date(Date.now() - 1_000).toISOString();
    fixture.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(syntheticDeadline, game.id);
    fixture.database.prepare("UPDATE predictions SET submitted_at = ? WHERE game_id = ?").run(new Date(Date.now() - 2_000).toISOString(), game.id);

    assert.equal((await request(worker, env, `/api/admin/games/${game.id}/lineup`, jsonOptions("POST", adminCookie, { lineup, teamId: homeTeam.id }))).response.status, 200);
    const scored = await request(worker, env, `/api/admin/games/${game.id}/score`, jsonOptions("POST", adminCookie, {}));
    assert.equal(scored.response.status, 200, JSON.stringify(scored.payload));
    const beforeRanking = await request(worker, env, `/api/admin/games/${game.id}/publish`, jsonOptions("POST", adminCookie, {}));
    assert.equal(beforeRanking.response.status, 409);
    assert.equal(beforeRanking.payload.code, "RANKING_INCOMPLETE");
    assert.equal((await request(worker, env, `/api/admin/games/${game.id}/ranking`, jsonOptions("POST", adminCookie, {}))).response.status, 200);
    assert.equal((await request(worker, env, `/api/admin/games/${game.id}/publish`, jsonOptions("POST", adminCookie, {}))).response.status, 200);
  }

  const ranking = await request(worker, env, `/api/rankings?competitionId=${competitionBody.id}`);
  assert.deepEqual(fixture.database.prepare("SELECT game_id, status, score, scored_revision FROM predictions ORDER BY game_id").all().map((row) => ({ ...row })), [
    { game_id: "phase4-local-g1", status: "scored", score: 99, scored_revision: 1 },
    { game_id: "phase4-local-g2", status: "scored", score: 99, scored_revision: 1 },
    { game_id: "phase4-local-g3", status: "scored", score: 99, scored_revision: 1 }
  ]);
  assert.equal(ranking.response.status, 200);
  assert.ok(ranking.payload.ranking[0], JSON.stringify(ranking.payload));
  assert.equal(ranking.payload.ranking[0].username, "phase4-fan");
  assert.equal(ranking.payload.ranking[0].gamesCount, 3);
  const bestNine = await request(worker, env, "/api/games/phase4-local-g3/best-nine");
  assert.equal(bestNine.response.status, 200);
  assert.equal(bestNine.payload.published, true);
  assert.equal(bestNine.payload.bestNine.length, 1);

  fixture.database.prepare("UPDATE competitions SET status = 'completed' WHERE id = ?").run(competitionBody.id);
  for (const action of ["score", "ranking", "publish"]) {
    const rejected = await request(worker, env, `/api/admin/games/phase4-local-g3/${action}`, jsonOptions("POST", adminCookie, {}));
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.payload.code, "COMPETITION_COMPLETED");
  }
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE status <> 'completed'").get().count, 0);
});
