import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import authWorker, { saveActualLineupForAutoScoring } from "../auth-worker.js";
import { createContestId, ensureGameContest } from "../backend/contest-identity.js";
import teamContext from "../frontend/shared/team-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const A2 = "0047_contest_scoped_predictions_lineups.sql";
const A2_SQL = fs.readFileSync(path.join(MIGRATIONS, A2), "utf8");

function migrationsThrough(name) {
  return fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql") && file <= name).sort();
}

function apply(database, through) {
  for (const file of migrationsThrough(through)) database.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
}

function seedLegacy(database, { gameId = "physical-f-m", home = "北海道日本ハムファイターズ", away = "千葉ロッテマリーンズ", prediction = true, lineup = true } = {}) {
  const now = "2026-10-19T00:00:00.000Z";
  database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES ('a2-user', 'a2-user', 'a2-user', 'hash', 'salt', 1, 'active', 'user', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO games
    (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
    VALUES (?, '2026-10-19', '2026-10-19T09:00:00.000Z', ?, ?, 'scheduled', ?, ?)`)
    .run(gameId, home, away, now, now);
  if (prediction) database.prepare(`INSERT INTO predictions
    (id, user_id, game_id, internal_game_id, prediction_json, schema_version, game_date, home_team, away_team,
     opponent_code, is_home, submitted_at, updated_at, score, max_score, scored_at, actual_lineup_json)
    VALUES ('legacy-prediction', 'a2-user', ?, ?, '{"lineup":[{"order":1,"player":"Legacy"}]}', 1,
      '2026-10-19', ?, ?, 'm', 1, ?, ?, 17, 99, ?, '[{"order":1,"player":"Actual"}]')`)
    .run(gameId, gameId, home, away, now, now, now);
  if (lineup) database.prepare(`INSERT INTO game_lineups
    (id, game_id, internal_game_id, actual_lineup_json, lineup_fingerprint, schema_version,
     lineup_detected_at, scoring_due_at, scoring_status, created_at, updated_at)
    VALUES ('legacy-lineup', ?, ?, '[{"order":1,"player":"Actual"}]', 'legacy-fingerprint', 1, ?, ?, 'pending', ?, ?)`)
    .run(gameId, gameId, now, now, now, now);
  return now;
}

function applyA2Transactional(database) {
  database.exec("BEGIN");
  try {
    database.exec(A2_SQL);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function d1(database) {
  return { prepare(sql) {
    const statement = database.prepare(sql);
    return { bind(...values) {
      return {
        first: async () => statement.get(...values),
        all: async () => ({ results: statement.all(...values) }),
        run: async () => ({ meta: { changes: Number(statement.run(...values).changes || 0) } })
      };
    } };
  } };
}

function authD1(database) {
  return {
    ...d1(database),
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function predictionPayload(team) {
  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  return { schemaVersion: 1, lineup: positions.map((position, index) => ({
    battingOrder: index + 1,
    playerName: `${team.shortName} Player ${index + 1}`,
    playerId: `${team.playerTeamId}-${index + 1}`,
    teamId: team.playerTeamId,
    teamCode: team.key,
    uniformNumber: String(index + 1),
    position
  })) };
}

async function authenticatedRequest(db, token, team, path, method, body, envOverrides = {}) {
  const response = await authWorker.fetch(new Request(`https://starting9.test${path}`, {
    method,
    headers: { Cookie: `s9_session=${token}`, Origin: "https://starting9.test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), {
    AUTH_DB: db,
    AUDIT_DB: db,
    ENVIRONMENT: "test",
    TEST_SITE_ID: "starting9-isolated-v1",
    TEST_WORKER_NAME: "starting9-test-auth",
    AUTH_ALLOWED_ORIGINS: "https://starting9.test",
    TARGET_TEAM_CONTEXT: team,
    ...envOverrides
  }, { waitUntil() {} });
  return { response, payload: await response.json() };
}

test("A2 fresh migration chain installs contest keys, FK guards and lookup indexes", () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, A2);
    assert.ok(database.prepare("PRAGMA table_info(predictions)").all().some((row) => row.name === "contest_id"));
    assert.ok(database.prepare("PRAGMA table_info(game_lineups)").all().some((row) => row.name === "contest_id"));
    const predictionIndexes = database.prepare("PRAGMA index_list(predictions)").all();
    const lineupIndexes = database.prepare("PRAGMA index_list(game_lineups)").all();
    assert.ok(predictionIndexes.some((row) => row.unique && row.origin === "u"));
    assert.ok(lineupIndexes.some((row) => row.unique && row.origin === "u"));
    assert.equal(predictionIndexes.some((row) => row.name === "idx_predictions_user_contest"), false);
    assert.equal(lineupIndexes.some((row) => row.name === "idx_game_lineups_contest"), false);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("legacy Fighters prediction and canonical lineup retain payload, score lineage and timestamps", () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, "0045_cron_heartbeat.sql");
    const now = seedLegacy(database);
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    const beforePrediction = { ...database.prepare("SELECT * FROM predictions WHERE id = 'legacy-prediction'").get() };
    const beforeLineup = { ...database.prepare("SELECT * FROM game_lineups WHERE id = 'legacy-lineup'").get() };
    const beforePredictionColumns = database.prepare("PRAGMA table_info(predictions)").all().map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    const beforeLineupColumns = database.prepare("PRAGMA table_info(game_lineups)").all().map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    const beforePredictionIndexes = database.prepare("PRAGMA index_list(predictions)").all().filter((row) => row.name.startsWith("idx_")).map((row) => row.name).sort();
    const beforeLineupIndexes = database.prepare("PRAGMA index_list(game_lineups)").all().filter((row) => row.name.startsWith("idx_")).map((row) => row.name).sort();
    database.prepare(`INSERT INTO game_lineup_revisions
      (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, reason, is_current,
       revision_id, internal_game_id, unresolved_player_count, is_final)
      VALUES ('physical-f-m', 1, '[{"player":"Revision"}]', 'revision-hash', 'manual', ?, 'legacy', 1,
       'physical-f-m:1', 'physical-f-m', 0, 1)`).run(now);
    applyA2Transactional(database);
    const prediction = database.prepare("SELECT * FROM predictions WHERE id = 'legacy-prediction'").get();
    const lineup = database.prepare("SELECT * FROM game_lineups WHERE id = 'legacy-lineup'").get();
    assert.equal(prediction.contest_id, createContestId("physical-f-m", "fighters"));
    assert.equal(prediction.prediction_json, beforePrediction.prediction_json);
    assert.equal(prediction.score, beforePrediction.score);
    assert.equal(prediction.max_score, beforePrediction.max_score);
    assert.equal(prediction.scored_at, beforePrediction.scored_at);
    assert.equal(prediction.submitted_at, now);
    assert.equal(prediction.updated_at, now);
    assert.equal(lineup.contest_id, createContestId("physical-f-m", "fighters"));
    assert.equal(lineup.actual_lineup_json, beforeLineup.actual_lineup_json);
    assert.equal(lineup.lineup_fingerprint, beforeLineup.lineup_fingerprint);
    assert.equal(lineup.created_at, now);
    assert.equal(lineup.updated_at, now);
    const revision = database.prepare("SELECT contest_id, internal_game_id, game_id, version, revision_id, actual_lineup_json, is_current, is_final FROM contest_lineup_revisions").get();
    assert.deepEqual({ ...revision }, {
      contest_id: createContestId("physical-f-m", "fighters"), internal_game_id: "physical-f-m", game_id: "physical-f-m",
      version: 1, revision_id: "physical-f-m:1", actual_lineup_json: '[{"player":"Revision"}]', is_current: 1, is_final: 1
    });
    const predictionColumns = database.prepare("PRAGMA table_info(predictions)").all().map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    const lineupColumns = database.prepare("PRAGMA table_info(game_lineups)").all().map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    assert.deepEqual(predictionColumns.filter((column) => column.name !== "contest_id"), beforePredictionColumns);
    assert.deepEqual(lineupColumns.filter((column) => column.name !== "contest_id"), beforeLineupColumns);
    assert.deepEqual(database.prepare("PRAGMA index_list(predictions)").all().filter((row) => row.name.startsWith("idx_")).map((row) => row.name).filter((name) => name !== "idx_predictions_legacy_test_identity").sort(), beforePredictionIndexes);
    assert.deepEqual(database.prepare("PRAGMA index_list(game_lineups)").all().filter((row) => row.name.startsWith("idx_")).map((row) => row.name).filter((name) => name !== "idx_game_lineups_legacy_test_game").sort(), beforeLineupIndexes);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("one user stores independent predictions and canonical lineups for both contests of one physical game", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const gameId = "33333333-2027-4000-8000-000000000001";
    apply(database, "0045_cron_heartbeat.sql");
    seedLegacy(database, { gameId, prediction: false, lineup: false });
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    applyA2Transactional(database);
    const db = d1(database);
    const fighters = await ensureGameContest(db, gameId, teamContext.FIGHTERS);
    const marines = await ensureGameContest(db, gameId, teamContext.MARINES);
    assert.equal(fighters.ok, true);
    assert.equal(marines.ok, true);
    assert.notEqual(fighters.contestId, marines.contestId);

    const insertPrediction = database.prepare(`INSERT INTO predictions
      (id, user_id, game_id, contest_id, internal_game_id, prediction_json, game_date, home_team, away_team,
       opponent_code, is_home, submitted_at, updated_at)
      VALUES (?, 'a2-user', ?, ?, ?, ?, '2026-10-19', 'F', 'M', ?, ?, 'now', 'now')`);
    insertPrediction.run("prediction-f", gameId, fighters.contestId, gameId, '{"lineup":["F"]}', "m", 1);
    insertPrediction.run("prediction-m", gameId, marines.contestId, gameId, '{"lineup":["M"]}', "f", 0);
    assert.throws(() => insertPrediction.run("prediction-f-duplicate", gameId, fighters.contestId, gameId, "{}", "m", 1), /UNIQUE constraint failed/);
    database.prepare(`INSERT INTO users
      (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
      VALUES ('other-user', 'other', 'other', 'hash', 'salt', 1, 'active', 'user', 'now', 'now')`).run();
    assert.throws(() => database.prepare(`INSERT INTO predictions
      (id,user_id,game_id,contest_id,internal_game_id,prediction_json,game_date,home_team,away_team,opponent_code,is_home,submitted_at,updated_at)
      VALUES ('wrong-game','other-user','other-game',?,'different-physical-game','{}','2026-10-19','F','M','m',1,'now','now')`)
      .run(fighters.contestId), /FOREIGN KEY constraint failed|PREDICTION_CONTEST_GAME_MISMATCH/);

    const detectedAt = new Date("2026-10-19T00:00:00.000Z");
    const fightersLineup = [{ battingOrder: 1, playerId: "F-1", playerName: "Fighters lineup" }];
    const marinesLineup = [{ battingOrder: 1, playerId: "M-1", playerName: "Marines lineup" }];
    const fightersSavedLineup = await saveActualLineupForAutoScoring(d1(database), gameId, fightersLineup, detectedAt, {
      internalGameId: gameId, contestId: fighters.contestId, targetTeam: teamContext.FIGHTERS,
      allowAfterStart: true, now: detectedAt
    });
    const marinesSavedLineup = await saveActualLineupForAutoScoring(d1(database), gameId, marinesLineup, detectedAt, {
      internalGameId: gameId, contestId: marines.contestId, targetTeam: teamContext.MARINES,
      allowAfterStart: true, now: detectedAt
    });
    assert.equal(fightersSavedLineup.contest_id, fighters.contestId);
    assert.equal(marinesSavedLineup.contest_id, marines.contestId);
    assert.deepEqual(database.prepare("SELECT contest_id, prediction_json FROM predictions WHERE user_id='a2-user' ORDER BY contest_id").all().map((row) => row.prediction_json), ['{"lineup":["F"]}', '{"lineup":["M"]}']);
    assert.deepEqual(database.prepare("SELECT contest_id, actual_lineup_json FROM game_lineups ORDER BY contest_id").all().map((row) => JSON.parse(row.actual_lineup_json)[0].playerName), ["Fighters lineup", "Marines lineup"]);

    database.prepare("UPDATE predictions SET prediction_json=? WHERE id='prediction-f'").run('{"lineup":["F2"]}');
    assert.equal(database.prepare("SELECT prediction_json FROM predictions WHERE id='prediction-m'").get().prediction_json, '{"lineup":["M"]}');
    database.prepare("DELETE FROM predictions WHERE contest_id=? AND user_id='a2-user'").run(fighters.contestId);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE id='prediction-m'").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("the real prediction API keeps one user's Fighters and Marines predictions independent for the same game", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, "0045_cron_heartbeat.sql");
    const gameId = "22222222-2027-4000-8000-000000000001";
    const now = seedLegacy(database, { gameId, prediction: false, lineup: false });
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    applyA2Transactional(database);
    database.prepare("UPDATE games SET game_date='2099-08-09', start_time='2099-08-09T05:00:00.000Z' WHERE internal_game_id=?")
      .run(gameId);
    const token = "a2-runtime-session";
    const tokenHash = createHash("sha256").update(token).digest("base64url");
    database.prepare("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,last_used_at) VALUES ('a2-session','a2-user',?,?,?,?)")
      .run(tokenHash, now, "2099-01-01T00:00:00.000Z", now);
    const db = authD1(database);
    const fightersContest = await ensureGameContest(db, gameId, teamContext.FIGHTERS);
    const marinesContest = await ensureGameContest(db, gameId, teamContext.MARINES);
    assert.notEqual(fightersContest.contestId, marinesContest.contestId);

    for (const [team, contest] of [[teamContext.FIGHTERS, fightersContest], [teamContext.MARINES, marinesContest]]) {
      const saved = await authenticatedRequest(db, token, team, "/api/predictions/current", "PUT", {
        internalGameId: gameId, contestId: contest.contestId, prediction: predictionPayload(team)
      });
      assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
      assert.equal(saved.payload.contestId, contest.contestId);
      const loaded = await authenticatedRequest(db, token, team,
        `/api/predictions/current?internalGameId=${gameId}&contestId=${contest.contestId}`, "GET");
      assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
      assert.equal(loaded.payload.prediction.lineup[0].teamCode, team.key);
    }

    const fightersUpdate = await authenticatedRequest(db, token, teamContext.FIGHTERS, "/api/predictions/current", "PUT", {
      internalGameId: gameId, contestId: fightersContest.contestId,
      prediction: { ...predictionPayload(teamContext.FIGHTERS), lineup: predictionPayload(teamContext.FIGHTERS).lineup.map((player, i) => i ? player : { ...player, playerName: "Fighters Updated" }) }
    });
    assert.equal(fightersUpdate.response.status, 200, JSON.stringify(fightersUpdate.payload));
    const rows = database.prepare("SELECT contest_id,prediction_json FROM predictions WHERE user_id='a2-user' ORDER BY contest_id").all();
    assert.equal(rows.length, 2);
    const byContest = new Map(rows.map((row) => [row.contest_id, JSON.parse(row.prediction_json)]));
    assert.equal(byContest.get(fightersContest.contestId).lineup[0].playerName, "Fighters Updated");
    assert.equal(byContest.get(marinesContest.contestId).lineup[0].teamCode, "marines");

    const removed = await authenticatedRequest(db, token, teamContext.FIGHTERS,
      `/api/predictions/current?internalGameId=${gameId}&contestId=${fightersContest.contestId}`, "DELETE");
    assert.equal(removed.response.status, 200, JSON.stringify(removed.payload));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE contest_id=?").get(marinesContest.contestId).count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
});

test("nonparticipant and ambiguous legacy rows fail closed without partially applying A2", () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, "0045_cron_heartbeat.sql");
    seedLegacy(database, { gameId: "marines-only", home: "千葉ロッテマリーンズ", away: "福岡ソフトバンクホークス", prediction: false, lineup: false });
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    const now = "2026-10-19T00:00:00.000Z";
    database.prepare(`INSERT INTO predictions
      (id,user_id,game_id,internal_game_id,prediction_json,game_date,home_team,away_team,opponent_code,is_home,submitted_at,updated_at)
      VALUES ('unmapped','a2-user','marines-only','marines-only','{}','2026-10-19','M','H','h',1,?,?)`).run(now, now);
    const before = { ...database.prepare("SELECT * FROM predictions WHERE id='unmapped'").get() };
    assert.throws(() => applyA2Transactional(database), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT * FROM predictions WHERE id='unmapped'").get().game_id, before.game_id);
    assert.equal(database.prepare("PRAGMA table_info(predictions)").all().some((row) => row.name === "contest_id"), false);
  } finally { database.close(); }
});

test("a legacy lineup without a unique Fighters contest aborts A2 without partial table rebuild", () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, "0045_cron_heartbeat.sql");
    seedLegacy(database, { gameId: "marines-only-lineup", home: "千葉ロッテマリーンズ", away: "福岡ソフトバンクホークス", prediction: false, lineup: true });
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    const before = { ...database.prepare("SELECT * FROM game_lineups WHERE id='legacy-lineup'").get() };
    assert.throws(() => applyA2Transactional(database), /CHECK constraint failed/);
    assert.deepEqual({ ...database.prepare("SELECT * FROM game_lineups WHERE id='legacy-lineup'").get() }, before);
    assert.equal(database.prepare("PRAGMA table_info(game_lineups)").all().some((row) => row.name === "contest_id"), false);
  } finally { database.close(); }
});

test("contest writes reject unknown or nonparticipant teams even if callers request an identity", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, "0045_cron_heartbeat.sql");
    seedLegacy(database, { prediction: false, lineup: false });
    database.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    applyA2Transactional(database);
    const db = d1(database);
    assert.equal((await ensureGameContest(db, "physical-f-m", teamContext.MARINES, "wrong-contest")).code, "CONTEST_GAME_MISMATCH");
    assert.equal((await ensureGameContest(db, "physical-f-m", { ...teamContext.MARINES, key: "unknown-team" })).code, "CONTEST_IDENTITY_REQUIRED");
    database.prepare("INSERT INTO contest_identity_teams(team_key) VALUES ('test-foxes')").run();
    const nonParticipant = teamContext.defineTeamContext({
      key: "test-foxes", slug: "test-foxes", displayName: "Test Foxes", shortName: "Foxes",
      playerTeamId: "TX", providerTeamCode: "tx", aliases: ["Test Foxes"],
      branding: { primary: "#774411", secondary: "#442211", accent: "#eebbaa", surface: "#fff5ee" }
    });
    assert.equal((await ensureGameContest(db, "physical-f-m", nonParticipant)).code, "CONTEST_TARGET_NOT_A_GAME_PARTICIPANT");
    assert.equal((await ensureGameContest(db, "physical-f-m", teamContext.MARINES)).ok, true);
  } finally { database.close(); }
});
