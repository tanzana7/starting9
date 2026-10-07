import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
        statements.forEach((statement) => statement._execute());
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

async function request(worker, env, requestPath, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${requestPath}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

function cookie(result) {
  return result.cookie.split(";")[0];
}

async function adminSession(worker, env) {
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "phase2-token" },
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(login.response.status, 200);
  return cookie(login);
}

test("Phase 2の大会ランディング・日程・一括取込は同一competition境界で動作する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase2-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);

  const metadata = await request(worker, env, "/api/admin/competition", {
    method: "PUT",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: "asia-cs", displayName: "Asia CS 2026", shortName: "ACS26", startDate: "2026-11-01", endDate: "2026-11-30", status: "active", description: "International tournament" })
  });
  assert.equal(metadata.response.status, 200);
  assert.equal(metadata.payload.competition.displayName, "Asia CS 2026");

  for (const team of [
    { teamKey: "home", displayName: "Home", shortName: "H" },
    { teamKey: "away", displayName: "Away", shortName: "A" }
  ]) {
    const created = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify(team) });
    assert.equal(created.response.status, 201);
  }

  const importedGames = await request(worker, env, "/api/admin/games/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ games: [
      { id: "phase2-game-1", title: "Opening", gameDate: "2026-11-15", startAt: "2026-11-15T09:00:00+09:00", predictionDeadlineAt: "2026-11-15T08:00:00+09:00", homeTeamId: "home", awayTeamId: "away", venue: "Tokyo" },
      { id: "phase2-game-2", title: "Final", gameDate: "2026-11-16", startAt: "2026-11-16T09:00:00+09:00", predictionDeadlineAt: "2026-11-16T08:00:00+09:00", homeTeamId: "away", awayTeamId: "home", venue: "Osaka" }
    ] })
  });
  assert.equal(importedGames.response.status, 200);
  assert.equal(importedGames.payload.imported, 2);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, 2);

  const invalidGames = await request(worker, env, "/api/admin/games/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ games: [
      { id: "phase2-game-3", title: "Would be valid", gameDate: "2026-11-17", startAt: "2026-11-17T09:00:00+09:00", predictionDeadlineAt: "2026-11-17T08:00:00+09:00", homeTeamId: "home", awayTeamId: "away" },
      { id: "phase2-game-4", title: "Foreign", gameDate: "2026-11-18", startAt: "2026-11-18T09:00:00+09:00", predictionDeadlineAt: "2026-11-18T08:00:00+09:00", homeTeamId: "home", awayTeamId: "missing" }
    ] })
  });
  assert.equal(invalidGames.response.status, 409);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, 2);

  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  const players = Array.from({ length: 9 }, (_, index) => ({ id: `phase2-player-${index + 1}`, name: `Player ${index + 1}`, uniformNumber: String(index + 1), position: positions[index], teamId: "home" }));
  const importedPlayers = await request(worker, env, "/api/admin/players/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ gameId: "phase2-game-1", players })
  });
  assert.equal(importedPlayers.response.status, 200);
  assert.equal(importedPlayers.payload.imported, 9);

  const invalidPlayers = await request(worker, env, "/api/admin/players/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ gameId: "phase2-game-1", players: [{ id: "phase2-player-10", name: "New Player", uniformNumber: "10", position: "中", teamId: "home" }, { id: "phase2-player-11", name: "Wrong Team", uniformNumber: "11", position: "右", teamId: "missing" }] })
  });
  assert.equal(invalidPlayers.response.status, 409);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'phase2-game-1'").get().count, 9);
  const invalidPosition = await request(worker, env, "/api/admin/players/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ gameId: "phase2-game-1", players: [{ id: "phase2-player-12", name: "Invalid Position", uniformNumber: "12", position: "coach", teamId: "home" }] })
  });
  assert.equal(invalidPosition.response.status, 400);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'phase2-game-1'").get().count, 9);
  const gameDetail = await request(worker, env, "/api/games/phase2-game-1");
  assert.equal(gameDetail.payload.game.playersByTeam.home.length, 9);
  assert.equal(gameDetail.payload.game.playersByTeam.away.length, 0);

  const landing = await request(worker, env, "/api/competition");
  assert.equal(landing.response.status, 200);
  assert.equal(landing.payload.competition.id, "asia-cs");
  assert.deepEqual(landing.payload.games.map((game) => game.id), ["phase2-game-1", "phase2-game-2"]);
  assert.equal(landing.payload.nextGame.id, "phase2-game-1");
  const schedule = await request(worker, env, "/api/games?competitionId=asia-cs");
  assert.equal(schedule.payload.games.length, 2);
});

test("完了済み大会は予想を停止し、管理概要は大会境界内だけを返す", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase2-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const fan = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "fan", password: "fan-password" }) });
  const fanCookie = cookie(fan);

  const teamA = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ teamKey: "team-a", displayName: "Team A", shortName: "A" }) });
  const teamB = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ teamKey: "team-b", displayName: "Team B", shortName: "B" }) });
  assert.equal(teamA.response.status, 201);
  assert.equal(teamB.response.status, 201);
  const game = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "completed-game", title: "Completed", gameDate: "2026-12-01", startAt: "2026-12-01T09:00:00+09:00", predictionDeadlineAt: "2026-12-01T08:00:00+09:00", homeTeamId: "team-a", homeTeamName: "Team A", awayTeamId: "team-b", awayTeamName: "Team B" }) });
  assert.equal(game.response.status, 201);

  const completed = await request(worker, env, "/api/admin/competition", { method: "PUT", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "asia-cs", displayName: "Asia CS", shortName: "ACS", status: "completed" }) });
  assert.equal(completed.response.status, 200);
  const prediction = await request(worker, env, "/api/games/completed-game/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup: [] }) });
  assert.equal(prediction.response.status, 409);
  assert.equal(prediction.payload.code, "COMPETITION_COMPLETED");
  const blockedEdit = await request(worker, env, "/api/admin/competition", { method: "PUT", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "asia-cs", displayName: "Changed", shortName: "Changed", status: "active" }) });
  assert.equal(blockedEdit.response.status, 409);

  const overview = await request(worker, env, "/api/admin/overview", { headers: { Cookie: adminCookie } });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.payload.competition.status, "completed");
  assert.deepEqual(overview.payload.games.map((item) => item.id), ["completed-game"]);
});

test("公開結果と大会Best Nineは公開済み現行ラインナップだけを参照する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ALLOWED_ORIGIN: "https://asia-cs.test" };
  const now = "2026-11-20T00:00:00.000Z";
  fixture.database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, role, status, created_at, updated_at)
    VALUES ('phase2-admin', 'phase2-admin', 'phase2-admin', 'hash', 'salt', 1, 'admin', 'active', ?, ?)`)
    .run(now, now);
  fixture.database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_source, game_date, start_at, prediction_deadline_at, status, publication_status, current_lineup_revision, created_at, updated_at)
    VALUES ('published-game', 'Published', 'ASIA_CS', 'asia-cs', 'manual', '2026-11-20', '2026-11-20T09:00:00.000Z', '2026-11-20T08:00:00.000Z', 'published', 'published', 1, ?, ?)`)
    .run(now, now);
  const publishedPlayers = Array.from({ length: 9 }, (_, index) => ({ id: `published-player-${index + 1}`, name: `Player ${index + 1}`, teamId: "home" }));
  fixture.database.prepare(`INSERT INTO players (id, game_id, name, uniform_number, team, team_id, active, created_at, updated_at)
    VALUES (?, 'published-game', ?, ?, 'Home', 'home', 1, ?, ?)`);
  for (const [index, player] of publishedPlayers.entries()) {
    fixture.database.prepare(`INSERT INTO players (id, game_id, name, uniform_number, team, team_id, active, created_at, updated_at)
      VALUES (?, 'published-game', ?, ?, 'Home', 'home', 1, ?, ?)`)
      .run(player.id, player.name, String(index + 1), now, now);
  }
  const publishedLineup = publishedPlayers.map((player, index) => ({ battingOrder: index + 1, playerId: player.id, playerName: player.name, position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index] }));
  fixture.database.prepare(`INSERT INTO lineup_revisions
    (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
    VALUES ('published-revision', 'published-game', 1, ?, 'fingerprint', 1, ?, 'phase2-admin', ?)`)
    .run(JSON.stringify(publishedLineup), now, now);

  const result = await request(worker, env, "/api/games/published-game/result");
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.officialLineup.length, 9);
  assert.equal(result.payload.officialLineup[0].playerName, "Player 1");
  const bestNine = await request(worker, env, "/api/best-nine?competitionId=asia-cs");
  assert.equal(bestNine.response.status, 200);
  assert.equal(bestNine.payload.publishedGameCount, 1);
  assert.equal(bestNine.payload.bestNine.length, 9);
  assert.equal(bestNine.payload.bestNine[0].selectionCount, 1);
});

test("完了済み大会は全ての管理mutationをサーバー側で拒否する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase2-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const fan = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "completed-fan", password: "fan-password" }) });
  const fanCookie = cookie(fan);
  for (const team of [
    { teamKey: "completed-home", displayName: "Completed Home", shortName: "CH" },
    { teamKey: "completed-away", displayName: "Completed Away", shortName: "CA" }
  ]) {
    assert.equal((await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify(team) })).response.status, 201);
  }
  assert.equal((await request(worker, env, "/api/admin/games", {
    method: "POST", headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: "completed-mutation-game", title: "Completed", gameDate: "2026-12-10", startAt: "2026-12-10T09:00:00+09:00", predictionDeadlineAt: "2026-12-10T08:00:00+09:00", homeTeamId: "completed-home", awayTeamId: "completed-away", homeTeamName: "Completed Home", awayTeamName: "Completed Away" })
  })).response.status, 201);
  assert.equal((await request(worker, env, "/api/admin/competition", { method: "PUT", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "asia-cs", displayName: "Asia CS", shortName: "ACS", status: "completed" }) })).response.status, 200);

  const attempts = [
    ["POST", "/api/admin/games/completed-mutation-game/players", { players: [{ id: "completed-player", name: "Player", teamId: "completed-home", position: "中", uniformNumber: "1" }] }],
    ["PUT", "/api/admin/games/completed-mutation-game/players/completed-player", { name: "Changed" }],
    ["POST", "/api/admin/games/completed-mutation-game/lineup", { lineup: [] }],
    ["POST", "/api/admin/games/completed-mutation-game/score", {}],
    ["POST", "/api/admin/games/completed-mutation-game/ranking", {}],
    ["POST", "/api/admin/games/completed-mutation-game/publish", {}],
    ["POST", "/api/admin/games/completed-mutation-game/rescore", { lineup: [] }]
  ];
  for (const [method, pathName, body] of attempts) {
    const result = await request(worker, env, pathName, { method, headers: { Cookie: adminCookie }, body: JSON.stringify(body) });
    assert.equal(result.response.status, 409, `${method} ${pathName}`);
    assert.equal(result.payload.code, "COMPETITION_COMPLETED", `${method} ${pathName}`);
  }

  for (const [pathName, body] of [
    ["/api/admin/players/import", { gameId: "completed-mutation-game", players: [{ id: "bulk-completed-player", name: "Bulk Player", position: "中", uniformNumber: "2", teamId: "completed-home" }] }],
    ["/api/admin/games/import", { competitionId: "asia-cs", games: [{ id: "bulk-completed-game", title: "Bulk", gameDate: "2026-12-11", startAt: "2026-12-11T09:00:00+09:00", predictionDeadlineAt: "2026-12-11T08:00:00+09:00", homeTeamId: "completed-home", awayTeamId: "completed-away" }] }]
  ]) {
    const result = await request(worker, env, pathName, { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify(body) });
    assert.equal(result.response.status, 409, pathName);
    assert.equal(result.payload.code, "COMPETITION_COMPLETED", pathName);
  }
  const prediction = await request(worker, env, "/api/games/completed-mutation-game/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup: [] }) });
  assert.equal(prediction.response.status, 409);
  assert.equal(prediction.payload.code, "COMPETITION_COMPLETED");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM players").get().count, 0);
});

test("公開済み試合を含む完了大会は再実行を拒否し、公開成果物を変更しない", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase2-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const operatorId = fixture.database.prepare("SELECT id FROM users WHERE username = 'operator'").get().id;
  const now = "2026-12-20T00:00:00.000Z";
  fixture.database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_source, game_date, start_at, prediction_deadline_at, status, publication_status, current_lineup_revision, created_at, updated_at)
    VALUES ('completed-published-game', 'Completed Published', 'ASIA_CS', 'asia-cs', 'manual', '2026-12-20', '2026-12-20T09:00:00.000Z', '2026-12-20T08:00:00.000Z', 'published', 'published', 1, ?, ?)`)
    .run(now, now);
  const lineup = [{ battingOrder: 1, playerId: "completed-published-player", playerName: "Published Player", position: "中" }];
  fixture.database.prepare(`INSERT INTO lineup_revisions
    (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
    VALUES ('completed-published-revision', 'completed-published-game', 1, ?, 'completed-published-fingerprint', 1, ?, ?, ?)`)
    .run(JSON.stringify(lineup), now, operatorId, now);
  fixture.database.prepare(`INSERT INTO scoring_runs
    (id, game_id, revision_number, kind, processed_count, score_changed_count, started_at, completed_at, created_by)
    VALUES ('completed-published-score', 'completed-published-game', 1, 'initial', 0, 0, ?, ?, ?)`)
    .run(now, now, operatorId);
  fixture.database.prepare(`INSERT INTO competition_publication_state
    (competition_id, publication_revision, updated_at, last_publication_generation)
    VALUES ('asia-cs', 1, ?, '1')`).run(now);
  fixture.database.prepare(`INSERT INTO competition_ranking_generations
    (competition_id, generation, target_game_id, status, created_at, published_at, base_publication_revision)
    VALUES ('asia-cs', 1, 'completed-published-game', 'published', ?, ?, 0)`).run(now, now);
  fixture.database.prepare(`INSERT INTO competition_ranking_publications
    (competition_id, generation, updated_at) VALUES ('asia-cs', 1, ?)`).run(now);

  const beforeResult = await request(worker, env, "/api/games/completed-published-game/result");
  assert.equal(beforeResult.response.status, 200);
  const snapshot = () => ({
    game: fixture.database.prepare("SELECT status, publication_status, current_lineup_revision, updated_at FROM games WHERE id = 'completed-published-game'").get(),
    scoring: fixture.database.prepare("SELECT revision_number, completed_at FROM scoring_runs WHERE game_id = 'completed-published-game'").get(),
    publication: fixture.database.prepare("SELECT publication_revision, last_publication_generation FROM competition_publication_state WHERE competition_id = 'asia-cs'").get(),
    generation: fixture.database.prepare("SELECT status, published_at FROM competition_ranking_generations WHERE competition_id = 'asia-cs' AND generation = 1").get(),
    rankingPublication: fixture.database.prepare("SELECT generation, updated_at FROM competition_ranking_publications WHERE competition_id = 'asia-cs'").get()
  });
  const before = snapshot();
  const completed = await request(worker, env, "/api/admin/competition", {
    method: "PUT",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: "asia-cs", displayName: "Asia CS", shortName: "ACS", status: "completed" })
  });
  assert.equal(completed.response.status, 200);

  for (const pathName of [
    "/api/admin/games/completed-published-game/score",
    "/api/admin/games/completed-published-game/ranking",
    "/api/admin/games/completed-published-game/publish",
    "/api/admin/games/completed-published-game/rescore"
  ]) {
    const result = await request(worker, env, pathName, { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) });
    assert.equal(result.response.status, 409, pathName);
    assert.equal(result.payload.code, "COMPETITION_COMPLETED", pathName);
  }
  assert.deepEqual(snapshot(), before);
  const afterResult = await request(worker, env, "/api/games/completed-published-game/result");
  assert.deepEqual(afterResult.payload, beforeResult.payload);
});

test("scoredで未公開の本人predictionは採点結果を返さず、公開後だけ返す", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ASIA_CS_LOCAL_AUTH: "true", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const fan = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "prediction-reader", password: "fan-password" }) });
  const now = "2026-12-12T00:00:00.000Z";
  fixture.database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_source, game_date, start_at, prediction_deadline_at, status, publication_status, current_lineup_revision, created_at, updated_at)
    VALUES ('pending-result-game', 'Pending Result', 'ASIA_CS', 'asia-cs', 'manual', '2026-12-12', '2026-12-12T09:00:00.000Z', '2026-12-12T08:00:00.000Z', 'open', 'pending', 3, ?, ?)`)
    .run(now, now);
  fixture.database.prepare(`INSERT INTO predictions
    (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES ('pending-prediction', ?, 'pending-result-game', '[]', ?, ?, 'submitted', NULL, NULL, NULL, NULL, NULL, 0)`)
    .run(fan.payload.user.id, now, now);

  const assertHidden = async () => {
    const result = await request(worker, env, "/api/games/pending-result-game/prediction", { headers: { Cookie: cookie(fan) } });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.prediction.lineup, []);
    assert.equal(Object.hasOwn(result.payload.prediction, "score"), false);
    assert.equal(Object.hasOwn(result.payload.prediction, "maxScore"), false);
    assert.equal(Object.hasOwn(result.payload.prediction, "scoredRevision"), false);
    assert.equal(Object.hasOwn(result.payload.prediction, "actualLineup"), false);
  };
  await assertHidden();

  fixture.database.prepare("UPDATE games SET status = 'closed' WHERE id = 'pending-result-game'").run();
  await assertHidden();

  fixture.database.prepare(`UPDATE predictions
    SET status = 'scored', score = 77, max_score = 99, scored_revision = 3,
        actual_lineup_json = '[{"playerId":"official-player","position":"中"}]', scored_at = ?
    WHERE id = 'pending-prediction'`).run(now);
  fixture.database.prepare("UPDATE games SET status = 'scored' WHERE id = 'pending-result-game'").run();
  await assertHidden();

  fixture.database.prepare("UPDATE games SET status = 'published', publication_status = 'published' WHERE id = 'pending-result-game'").run();
  const after = await request(worker, env, "/api/games/pending-result-game/prediction", { headers: { Cookie: cookie(fan) } });
  assert.equal(after.response.status, 200);
  assert.equal(after.payload.prediction.score, 77);
  assert.equal(after.payload.prediction.maxScore, 99);
  assert.equal(after.payload.prediction.scoredRevision, 3);
  assert.deepEqual(after.payload.prediction.actualLineup, [{ playerId: "official-player", position: "中" }]);
});

test("manualとbulkの選手metadataは保存・更新・CSV取込で同じ形を保つ", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "phase2-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const teamIds = {};
  for (const team of [
    { teamKey: "metadata-home", displayName: "Metadata Home", shortName: "MH" },
    { teamKey: "metadata-away", displayName: "Metadata Away", shortName: "MA" }
  ]) {
    const result = await request(worker, env, "/api/admin/teams", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify(team) });
    teamIds[team.teamKey] = result.payload.team.id;
  }
  const createGame = async (id, date) => request(worker, env, "/api/admin/games", {
    method: "POST", headers: { Cookie: adminCookie },
    body: JSON.stringify({ id, title: id, gameDate: date, startAt: `${date}T09:00:00+09:00`, predictionDeadlineAt: `${date}T08:00:00+09:00`, homeTeamId: "metadata-home", awayTeamId: "metadata-away", homeTeamName: "Metadata Home", awayTeamName: "Metadata Away" })
  });
  assert.equal((await createGame("manual-metadata-game", "2026-12-13")).response.status, 201);
  assert.equal((await createGame("bulk-metadata-game", "2026-12-14")).response.status, 201);

  const metadata = { position: "中", uniformNumber: "7", bat: "R", throw: "L", active: true, teamId: teamIds["metadata-home"] };
  const manual = await request(worker, env, "/api/admin/games/manual-metadata-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: [{ id: "manual-metadata-player", name: "Manual Player", ...metadata }] }) });
  assert.equal(manual.response.status, 200);
  assert.deepEqual(manual.payload.players.find((player) => player.id === "manual-metadata-player"), { id: "manual-metadata-player", gameId: "manual-metadata-game", name: "Manual Player", uniformNumber: "7", team: "Metadata Home", club: "Metadata Home", teamId: teamIds["metadata-home"], registeredPosition: "中", position: "中", bat: "R", throw: "L", active: true });

  const updated = await request(worker, env, "/api/admin/games/manual-metadata-game/players/manual-metadata-player", { method: "PUT", headers: { Cookie: adminCookie }, body: JSON.stringify({ name: "Manual Updated", position: "右", uniformNumber: "8", bat: "L", throw: "R", active: false, teamId: teamIds["metadata-home"] }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.player.position, "右");
  assert.equal(updated.payload.player.uniformNumber, "8");
  assert.equal(updated.payload.player.bat, "L");
  assert.equal(updated.payload.player.throw, "R");
  assert.equal(updated.payload.player.active, false);

  const bulk = await request(worker, env, "/api/admin/players/import", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ gameId: "bulk-metadata-game", players: [{ id: "bulk-metadata-player", name: "Bulk Player", ...metadata }] }) });
  assert.equal(bulk.response.status, 200);
  const bulkPlayer = bulk.payload.players.find((player) => player.id === "bulk-metadata-player");
  assert.equal(bulkPlayer.position, "中");
  assert.equal(bulkPlayer.registeredPosition, "中");
  assert.equal(bulkPlayer.club, "Metadata Home");
  assert.equal(bulkPlayer.uniformNumber, "7");
  assert.equal(bulkPlayer.bat, "R");
  assert.equal(bulkPlayer.throw, "L");
  assert.equal(bulkPlayer.active, true);
  assert.deepEqual(
    [bulkPlayer.uniformNumber, bulkPlayer.position, bulkPlayer.bat, bulkPlayer.throw, bulkPlayer.active],
    ["7", "中", "R", "L", true]
  );

  const invalidManual = await request(worker, env, "/api/admin/games/manual-metadata-game/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players: [{ id: "invalid-position-player", name: "Invalid Position", position: "監督", teamId: "metadata-home" }] }) });
  assert.equal(invalidManual.response.status, 400);
  assert.equal(invalidManual.payload.code, "PLAYER_METADATA_INVALID");

  const countBeforeInvalidCsv = fixture.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'bulk-metadata-game'").get().count;
  for (const csv of [
    "id,name,position,teamId\ninvalid-inline,a\"b,中," + teamIds["metadata-home"],
    "id,name,position,teamId\ninvalid-trailing,\"abc\"x,中," + teamIds["metadata-home"],
    "id,name,position,teamId\ninvalid-unclosed,\"abc,中," + teamIds["metadata-home"],
    "id,name,position,teamId\ninvalid-triple,\"\"\"abc\"x,中," + teamIds["metadata-home"]
  ]) {
    const invalidCsv = await request(worker, env, "/api/admin/players/import", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ gameId: "bulk-metadata-game", csv }) });
    assert.equal(invalidCsv.response.status, 400);
    assert.equal(invalidCsv.payload.code, "CSV_INVALID");
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'bulk-metadata-game'").get().count, countBeforeInvalidCsv);
  }

  const emptyQuotedCsv = `id,name,uniformNumber,position,teamId,bat,throw\r\nempty-quoted-player,Empty Quoted,11,中,${teamIds["metadata-home"]},"",""\r\n`;
  const emptyQuotedResult = await request(worker, env, "/api/admin/players/import", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ gameId: "bulk-metadata-game", csv: emptyQuotedCsv }) });
  assert.equal(emptyQuotedResult.response.status, 200);
  const emptyQuotedPlayer = emptyQuotedResult.payload.players.find((player) => player.id === "empty-quoted-player");
  assert.equal(emptyQuotedPlayer.bat, null);
  assert.equal(emptyQuotedPlayer.throw, null);

  const csv = `\uFEFFid,name,uniformNumber,position,teamId,bat,throw\r\ncsv-metadata-player,"Tanaka, Jr.\n""The Captain""",10,中,${teamIds["metadata-home"]},R,L\r\n\r\n`;
  const csvResult = await request(worker, env, "/api/admin/players/import", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ gameId: "bulk-metadata-game", csv }) });
  assert.equal(csvResult.response.status, 200);
  const csvPlayer = csvResult.payload.players.find((player) => player.id === "csv-metadata-player");
  assert.equal(csvPlayer.name, "Tanaka, Jr.\n\"The Captain\"");
  assert.equal(csvPlayer.position, "中");

  const registeredPositionCsv = `team_key,player_id,player_name,club,registered_position,active\nmetadata-home,apbc-roster-player,APBC Roster Player,DeNA,外野手,1\n`;
  const registeredPositionResult = await request(worker, env, "/api/admin/players/import", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ gameId: "bulk-metadata-game", csv: registeredPositionCsv }) });
  assert.equal(registeredPositionResult.response.status, 200);
  const registeredPositionPlayer = registeredPositionResult.payload.players.find((player) => player.id === "apbc-roster-player");
  assert.deepEqual(
    {
      club: registeredPositionPlayer.club,
      registeredPosition: registeredPositionPlayer.registeredPosition,
      position: registeredPositionPlayer.position
    },
    { club: "DeNA", registeredPosition: "外野手", position: "外野手" }
  );
});

test("大会Best Nineは未公開試合と別competitionを混ぜず、公開後にだけ更新する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ALLOWED_ORIGIN: "https://asia-cs.test" };
  const now = "2026-12-15T00:00:00.000Z";
  fixture.database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, role, status, created_at, updated_at)
    VALUES ('phase2-reviewer', 'phase2-reviewer', 'phase2-reviewer', 'hash', 'salt', 1, 'admin', 'active', ?, ?)`)
    .run(now, now);
  fixture.database.prepare(`INSERT INTO competitions (id, competition_type, display_name, short_name, status, created_at, updated_at)
    VALUES ('other-competition', 'ASIA_CS', 'Other', 'Other', 'active', ?, ?)`)
    .run(now, now);
  const insertGame = (id, competitionId, status, publicationStatus) => fixture.database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_source, game_date, start_at, prediction_deadline_at, status, publication_status, current_lineup_revision, created_at, updated_at)
    VALUES (?, ?, 'ASIA_CS', ?, 'manual', '2026-12-15', '2026-12-15T09:00:00.000Z', '2026-12-15T08:00:00.000Z', ?, ?, 1, ?, ?)`)
    .run(id, id, competitionId, status, publicationStatus, now, now);
  const insertLineup = (gameId, playerId, playerName) => {
    fixture.database.prepare(`INSERT INTO players (id, game_id, name, uniform_number, team, team_id, position, active, created_at, updated_at)
      VALUES (?, ?, ?, '1', 'Home', NULL, '中', 1, ?, ?)`)
      .run(playerId, gameId, playerName, now, now);
    fixture.database.prepare(`INSERT INTO lineup_revisions (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
      VALUES (?, ?, 1, ?, 'fingerprint', 1, ?, 'phase2-reviewer', ?)`)
      .run(`${gameId}-revision`, gameId, JSON.stringify([{ battingOrder: 1, playerId, playerName, position: "中" }]), now, now);
  };
  insertGame("asia-published", "asia-cs", "published", "published");
  insertGame("asia-pending", "asia-cs", "scored", "pending");
  insertGame("other-published", "other-competition", "published", "published");
  insertLineup("asia-published", "asia-published-player", "Published Player");
  insertLineup("asia-pending", "asia-pending-player", "Pending Player");
  insertLineup("other-published", "other-player", "Other Competition Player");

  const before = await request(worker, env, "/api/best-nine?competitionId=asia-cs");
  assert.deepEqual(before.payload.bestNine.map((row) => row.player), ["Published Player"]);
  assert.equal(before.payload.publishedGameCount, 1);
  fixture.database.prepare("UPDATE games SET status = 'published', publication_status = 'published' WHERE id = 'asia-pending'").run();
  const after = await request(worker, env, "/api/best-nine?competitionId=asia-cs");
  assert.deepEqual(after.payload.bestNine.map((row) => row.player).sort(), ["Pending Player", "Published Player"].sort());
  assert.equal(after.payload.publishedGameCount, 2);
  const other = await request(worker, env, "/api/best-nine?competitionId=other-competition");
  assert.deepEqual(other.payload.bestNine.map((row) => row.player), ["Other Competition Player"]);
});
