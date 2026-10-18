import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestTeamWorker } from "../tooling/test-site/worker.js";
import { assertDistinctTestTeamIdentity, TEST_TEAMS, testTeamFixture } from "../tooling/test-site/teams.js";
import teamContext from "../frontend/shared/team-context.js";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bind = (...args) => ({
        all: async () => ({ results: statement.all(...args) }), first: async () => statement.get(...args),
        run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.run()); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    }
  };
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  const audit = new DatabaseSync(":memory:");
  for (const [directory, db] of [["migrations", database], ["migrations-audit", audit]]) {
    for (const file of fs.readdirSync(new URL(`../${directory}/`, import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(fs.readFileSync(new URL(`../${directory}/${file}`, import.meta.url), "utf8"));
    }
  }
  const now = new Date().toISOString();
  const token = "multi-team-synthetic-session";
  const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
  database.prepare(`INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES ('team-test-user', 'teamtest', 'teamtest', 'test', 'test', 1, 'active', 'admin', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES ('team-test-session', 'team-test-user', ?, ?, '2099-01-01T00:00:00.000Z', ?)`).run(tokenHash, now, now);
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.test-auth.jsonc", import.meta.url)));
  const env = { ...config.vars, AUTH_DB: d1(database), AUDIT_DB: d1(audit) };
  async function request(team, path, body, method = body === undefined ? "GET" : "POST") {
    const response = await createTestTeamWorker(team).fetch(new Request(`https://starting9-test-auth.internal${path}`, {
      method, headers: { Cookie: `s9_session=${token}`, Origin: "https://starting9-test.pages.dev", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env, { waitUntil() {} });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  }
  return { database, audit, request };
}

test("isolated teams keep distinct games/rosters/predictions and use the formal publish pipeline three times", async () => {
  const f = await fixture();
  try {
    for (let round = 0; round < 3; round++) {
      const a = await f.request("fighters", "/api/test/reset", {});
      const b = await f.request("foxes", "/api/test/reset", {});
      assert.notEqual(a.game.internalGameId, b.game.internalGameId);
      for (const key of ["fighters", "foxes"]) {
        const { team, internalGameId } = testTeamFixture(key);
        const publicGames = await f.request(key, "/api/public/games");
        const selected = publicGames.games.filter((entry) => entry.internalGameId === internalGameId);
        assert.equal(selected.length, 1);
        assert.equal(selected[0].homeTeam, team.key);
        assert.equal(selected[0].homeTeamName, team.shortName);
        assert.match(selected[0].displayLabel, new RegExp(team.shortName));
        assert.equal(selected[0].awayTeam, "marines");
        const roster = await f.request(key, `/api/game-day-roster?internalGameId=${internalGameId}`);
        assert.equal(roster.players.length, 15);
        assert.ok(roster.players.every((player) => player.teamCode === team.key && player.teamId === team.playerTeamId));
        const probable = await f.request(key, `/api/probable-starter?internalGameId=${internalGameId}`);
        assert.equal(probable.internalGameId, internalGameId);
        assert.equal(probable.homeTeam, team.key);
        assert.equal(probable.awayTeam, "marines");
        assert.equal(probable.dataStatus, "unannounced");
        const lineup = roster.players.slice(0, 9).map((player, index) => ({
          playerId: player.playerId, playerName: player.name, uniformNumber: player.uniformNumber,
          teamCode: team.key, teamId: team.playerTeamId, battingOrder: index + 1,
          position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
        }));
        await f.request(key, "/api/predictions/current", { internalGameId, prediction: { schemaVersion: 1, lineup } }, "PUT");
        const result = await f.request(key, "/api/test/scenario", { scenario: "published" });
        assert.equal(result.game.state, "published");
        assert.equal(result.game.publication_status, "published");
        const resultHistory = await f.request(key, "/api/results/games");
        assert.ok(resultHistory.games.some((entry) => entry.internalGameId === internalGameId));
        const resultDetail = await f.request(key, `/api/results/games/${internalGameId}`);
        assert.equal(resultDetail.internalGameId, internalGameId);
        assert.equal(resultDetail.totalScore, 99);
        const predictions = f.database.prepare("SELECT prediction_json, score FROM predictions WHERE internal_game_id = ?").all(internalGameId);
        assert.equal(predictions.length, 1);
        assert.equal(predictions[0].score, 99);
        assert.ok(JSON.parse(predictions[0].prediction_json).lineup.every((player) => player.teamCode === team.key));
      }
    }
  } finally { f.database.close(); f.audit.close(); }
});

test("synthetic Team B detects identity, selector, roster, and branding regressions", () => {
  assert.equal(assertDistinctTestTeamIdentity(), true);
  assert.throws(() => assertDistinctTestTeamIdentity({
    ...TEST_TEAMS, foxes: teamContext.defineTeamContext({ ...TEST_TEAMS.foxes, providerTeamCode: TEST_TEAMS.fighters.providerTeamCode })
  }), /distinct team identities/);

  const foxesGame = { homeTeam: TEST_TEAMS.foxes.key, awayTeam: "marines" };
  assert.equal(teamContext.gameSide(foxesGame, TEST_TEAMS.foxes), "home");
  assert.equal(teamContext.gameSide(foxesGame, TEST_TEAMS.fighters), null);

  const foxRoster = [{ teamCode: TEST_TEAMS.fighters.key, teamId: TEST_TEAMS.fighters.playerTeamId }];
  assert.equal(foxRoster.every((player) => player.teamCode === TEST_TEAMS.foxes.key
    && player.teamId === TEST_TEAMS.foxes.playerTeamId), false);

  const variables = new Map();
  const element = { style: { setProperty: (name, value) => variables.set(name, value) } };
  teamContext.applyBranding(element, TEST_TEAMS.foxes);
  const foxesPrimary = variables.get("--fighters-blue");
  teamContext.applyBranding(element, TEST_TEAMS.fighters);
  assert.notEqual(foxesPrimary, variables.get("--fighters-blue"));
});
