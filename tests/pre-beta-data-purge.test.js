import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  executePreBetaPurge,
  previewPreBetaPurge,
  PRE_BETA_PURGE_CONFIRMATION,
  PRE_BETA_PURGE_PLAN_VERSION
} from "../backend/maintenance/pre-beta-data-purge.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_GAME = "old-game";
const FUTURE_GAME = "future-game";
const LIVE_GAME = "live-game";

function d1(database) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() { return { results: database.prepare(sql).all(...bindings) }; },
            async first() { return database.prepare(sql).get(...bindings); },
            async run() {
              const result = database.prepare(sql).run(...bindings);
              return { meta: { changes: Number(result.changes || 0) } };
            }
          };
        }
      };
    }
  };
}

function recordingD1(database, calls) {
  const base = d1(database);
  return {
    prepare(sql) {
      const statement = base.prepare(sql);
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return statement.bind(...bindings);
        }
      };
    }
  };
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(path.join(ROOT, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(ROOT, "migrations", file), "utf8"));
  }
  return database;
}

function insertGame(database, gameId, gameStatus, startTime) {
  database.prepare(`
    INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
    VALUES (?, ?, ?, 'fighters', 'hawks', ?, ?, ?)
  `).run(gameId, startTime.slice(0, 10), startTime, gameStatus, startTime, startTime);
}

function insertRankingGame(database, gameId, status = "scored") {
  database.prepare(`
    INSERT INTO ranking_games (
      game_id, internal_game_id, game_date, is_ranking_eligible, game_status,
      is_test_game, publication_status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 0, 'published', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run(gameId, gameId, gameId === OLD_GAME ? "2026-09-10" : "2026-09-20", status);
}

function insertPrediction(database, gameId) {
  database.prepare(`
    INSERT INTO predictions (
      id, user_id, game_id, internal_game_id, prediction_json, schema_version,
      game_date, home_team, away_team, opponent_code, is_home, submitted_at,
      updated_at, status, score, max_score, scored_at, is_test_prediction, scoring_status
    ) VALUES (?, 'user-1', ?, ?, '{}', 1, ?, 'fighters', 'hawks', 'h', 1,
      '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', 'scored', 80, 99,
      '2026-09-10T00:00:00.000Z', 0, 'scored')
  `).run(`prediction-${gameId}`, gameId, gameId, gameId === OLD_GAME ? "2026-09-10" : "2026-09-20");
}

function insertDependentRows(database) {
  database.prepare(`
    INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, completed_at, created_at, updated_at)
    VALUES (?, 'score', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', 'completed', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')
  `).run(OLD_GAME);
  const jobId = database.prepare("SELECT id FROM game_jobs_v3 WHERE internal_game_id = ?").get(OLD_GAME).id;
  database.prepare(`
    INSERT INTO score_attempts (
      attempt_id, internal_game_id, game_id, canonical_lineup_revision_id,
      scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id, claim_token,
      status, expected_prediction_count, scoring_revision_id, scoring_revision_number,
      actual_lineup_json, created_at
    ) VALUES ('attempt-old', ?, ?, 'old-game:1', 'old-game:1', 'fp', ?, 'token',
      'committed', 1, 'score-revision-old', 1, '[]', '2026-09-10T00:00:00.000Z')
  `).run(OLD_GAME, OLD_GAME, jobId);
  database.prepare(`
    INSERT INTO score_attempt_prediction_rows (
      attempt_id, prediction_id, outcome, total_score, max_score
    ) VALUES ('attempt-old', 'prediction-old-game', 'scored', 80, 99)
  `).run();
  database.prepare(`
    INSERT INTO game_lineup_revisions (
      game_id, version, actual_lineup_json, lineup_fingerprint, source,
      created_at, reason, is_current, revision_id, internal_game_id, is_final
    ) VALUES (?, 1, '[]', 'fp', 'manual', '2026-09-10T00:00:00.000Z', 'test', 1, 'old-game:1', ?, 1)
  `).run(OLD_GAME, OLD_GAME);
  database.prepare(`
    INSERT INTO game_scoring_revisions (
      id, internal_game_id, game_id, revision_number, lineup_revision_id,
      status, reason, created_by, created_at, is_active
    ) VALUES ('score-revision-old', ?, ?, 1, 'old-game:1', 'completed', 'test', 'test', '2026-09-10T00:00:00.000Z', 1)
  `).run(OLD_GAME, OLD_GAME);
  database.prepare(`
    INSERT INTO user_achievements (id, user_id, achievement_id, earned_at, source, created_at)
    VALUES ('achievement-old', 'user-1', 'achievement_first_prediction', '2026-09-10T00:00:00.000Z', 'development', '2026-09-10T00:00:00.000Z')
  `).run();
}

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

test("pre-beta purge deletes only completed pre-release lineage and is safely repeatable", async () => {
  const database = createDatabase();
  insertGame(database, OLD_GAME, "completed", "2026-09-10T10:00:00.000Z");
  insertGame(database, FUTURE_GAME, "scheduled", "2026-09-20T10:00:00.000Z");
  insertGame(database, LIVE_GAME, "scheduled", "2026-09-17T10:00:00.000Z");
  database.prepare("INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES ('user-1', 'user', 'user', 'hash', 'salt', 1, '2026-09-01', '2026-09-01')").run();
  database.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at) VALUES ('session-1', 'user-1', 'token-hash', '2026-09-01', '2099-01-01', '2026-09-01')").run();
  insertRankingGame(database, OLD_GAME);
  insertPrediction(database, OLD_GAME);
  insertPrediction(database, FUTURE_GAME);
  insertDependentRows(database);

  const adapter = d1(database);
  const plan = await previewPreBetaPurge(adapter);
  assert.deepEqual(plan.internalGameIds, [OLD_GAME]);
  assert.equal(plan.activeJobs.gameJobs, 0);
  assert.equal(plan.counts.predictions, 1);
  assert.equal(plan.counts.user_achievements, 1);
  assert.equal(plan.version, PRE_BETA_PURGE_PLAN_VERSION);

  const result = await executePreBetaPurge(adapter, {
    planHash: plan.planHash,
    confirmation: PRE_BETA_PURGE_CONFIRMATION
  });
  assert.equal(result.deleted.predictions, 1);
  assert.equal(result.deleted.user_achievements, 1);
  assert.equal(result.remainingTotal, 0);
  assert.equal(count(database, "users"), 1);
  assert.equal(count(database, "sessions"), 1);
  assert.equal(count(database, "predictions"), 1);
  assert.equal(database.prepare("SELECT game_id FROM predictions").get().game_id, FUTURE_GAME);
  assert.equal(count(database, "game_lineups"), 0);
  assert.equal(count(database, "game_jobs_v3"), 0);
  assert.equal(count(database, "games"), 3);

  const repeated = await executePreBetaPurge(adapter, {
    planHash: plan.planHash,
    confirmation: PRE_BETA_PURGE_CONFIRMATION
  });
  assert.equal(repeated.deletedTotal, 0);
  assert.equal(count(database, "users"), 1);
  assert.equal(count(database, "sessions"), 1);
  assert.equal(count(database, "predictions"), 1);
});

test("pre-beta purge refuses a target plan with active jobs", async () => {
  const database = createDatabase();
  insertGame(database, OLD_GAME, "completed", "2026-09-10T10:00:00.000Z");
  insertRankingGame(database, OLD_GAME);
  database.prepare(`
    INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, created_at, updated_at)
    VALUES (?, 'ranking_rebuild', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', 'retry_wait', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')
  `).run(OLD_GAME);
  const adapter = d1(database);
  const plan = await previewPreBetaPurge(adapter);
  await assert.rejects(
    executePreBetaPurge(adapter, { planHash: plan.planHash, confirmation: PRE_BETA_PURGE_CONFIRMATION }),
    /PRE_BETA_PURGE_ACTIVE_JOBS/
  );
});

test("empty pre-beta target is a safe no-op instead of an empty-scope error", async () => {
  const database = createDatabase();
  const plan = await previewPreBetaPurge(d1(database));
  assert.deepEqual(plan.targetGames, []);
  assert.equal(plan.counts.score_attempt_prediction_rows, 0);
  assert.equal(plan.counts.score_attempt_test_rows, 0);
  assert.equal(plan.counts.score_attempts, 0);
  assert.equal(plan.totalRows, 0);
});

test("completed game without score-attempt rows remains a valid zero-count target", async () => {
  const database = createDatabase();
  insertGame(database, OLD_GAME, "completed", "2026-09-10T10:00:00.000Z");
  const plan = await previewPreBetaPurge(d1(database));
  assert.deepEqual(plan.internalGameIds, [OLD_GAME]);
  assert.equal(plan.counts.score_attempt_prediction_rows, 0);
  assert.equal(plan.counts.score_attempt_test_rows, 0);
  assert.equal(plan.counts.score_attempts, 0);
});

test("scored ranking evidence is selected even when the schedule row is still scheduled", async () => {
  const database = createDatabase();
  insertGame(database, OLD_GAME, "scheduled", "2026-09-10T10:00:00.000Z");
  insertRankingGame(database, OLD_GAME);
  const plan = await previewPreBetaPurge(d1(database));
  assert.deepEqual(plan.internalGameIds, [OLD_GAME]);
  assert.equal(plan.targetGames.some((row) => row.source === "scored_ranking_game"), true);
});

test("legacy scored ranking evidence can safely target game-id tables without inferring an internal id", async () => {
  const database = createDatabase();
  database.prepare(`
    INSERT INTO ranking_games (
      game_id, is_ranking_eligible, game_date, game_status, is_test_game,
      publication_status, created_at, updated_at
    ) VALUES ('legacy-game', 1, '2026-07-22', 'scored', 0, 'published', '2026-09-01', '2026-09-01')
  `).run();
  const plan = await previewPreBetaPurge(d1(database));
  assert.equal(plan.gameIds.includes("legacy-game"), true);
  assert.deepEqual(plan.internalGameIds, []);
  assert.equal(plan.counts.predictions, 0);
  assert.equal(plan.counts.game_lineups, 0);
  assert.equal(plan.counts.game_jobs_v3, 0);
});

test("target row without both identifiers is rejected instead of widening the purge", async () => {
  const invalidTargetDb = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes("FROM games")) {
                return { results: [{ game_id: null, internal_game_id: null, game_date: "2026-09-10", start_time: "2026-09-10T10:00:00.000Z" }] };
              }
              return { results: [] };
            },
            async first() { return { count: 0 }; }
          };
        }
      };
    }
  };
  await assert.rejects(
    previewPreBetaPurge(invalidTargetDb),
    /PRE_BETA_PURGE_TARGET_IDS_UNAVAILABLE/
  );
});

test("dry-run bounds every query at 100 bindings for 99, 100, 101, and 200 targets", async () => {
  for (const targetCount of [99, 100, 101, 200]) {
    const database = createDatabase();
    for (let index = 0; index < targetCount; index += 1) {
      const gameId = `bulk-game-${targetCount}-${index}`;
      database.prepare(`
        INSERT INTO ranking_games (
          game_id, internal_game_id, is_ranking_eligible, game_date, game_status,
          is_test_game, publication_status, created_at, updated_at
        ) VALUES (?, ?, 1, '2026-09-10', 'scored', 0, 'published', '2026-09-01', '2026-09-01')
      `).run(gameId, gameId);
    }
    const calls = [];
    const plan = await previewPreBetaPurge(recordingD1(database, calls));
    assert.equal(plan.targetGames.length, targetCount);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(({ bindings }) => bindings.length <= 100));
    assert.ok(calls.every(({ sql }) => !/\?101|\?102|\?200/.test(sql)));
  }
});
