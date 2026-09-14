import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createScoreAttempt,
  stageScorePrediction,
  markScoreAttemptReady,
  commitScoreAttempt
} from "../backend/automation-v3/score-attempts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        }
      };
    },
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

function createExistingSchema() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE games (internal_game_id TEXT PRIMARY KEY);
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT, status TEXT,
      claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
      failure_code TEXT, failure_message TEXT, updated_at TEXT
    );
    CREATE TABLE game_lineups (
      internal_game_id TEXT PRIMARY KEY, game_id TEXT, final_lineup_revision_id TEXT,
      lineup_fingerprint TEXT, scoring_status TEXT, scored_at TEXT,
      scoring_started_at TEXT, last_error TEXT, processed_predictions INTEGER,
      perfect_count INTEGER, new_perfect_achievers INTEGER,
      scoring_lineup_revision_id TEXT, scoring_revision INTEGER, scored_by TEXT,
      updated_at TEXT
    );
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT, game_id TEXT, revision_id TEXT, version INTEGER,
      is_current INTEGER, is_final INTEGER
    );
    CREATE TABLE game_scoring_revisions (
      id TEXT PRIMARY KEY, internal_game_id TEXT, game_id TEXT,
      revision_number INTEGER, lineup_revision_id TEXT, status TEXT,
      reason TEXT, created_by TEXT, created_at TEXT, completed_at TEXT,
      is_active INTEGER, UNIQUE(internal_game_id, lineup_revision_id)
    );
    CREATE TABLE prediction_score_revisions (
      id TEXT PRIMARY KEY, prediction_id TEXT, game_id TEXT, internal_game_id TEXT,
      is_test_prediction INTEGER, scoring_revision INTEGER, lineup_revision_id TEXT,
      score INTEGER, max_score INTEGER, actual_lineup_json TEXT, scored_at TEXT,
      scored_by TEXT, created_at TEXT
    );
    CREATE TABLE predictions (
      id TEXT PRIMARY KEY, internal_game_id TEXT, game_id TEXT, is_test_prediction INTEGER,
      score INTEGER, max_score INTEGER, status TEXT, scored_at TEXT,
      actual_lineup_json TEXT, scoring_status TEXT, scoring_exclusion_reason TEXT,
      scored_lineup_revision_id TEXT, scoring_revision INTEGER, scored_by TEXT,
      updated_at TEXT
    );
    CREATE TABLE ranking_test_predictions (
      internal_game_id TEXT, slot INTEGER, prediction_json TEXT, status TEXT,
      score INTEGER, max_score INTEGER, lineup_revision_id TEXT,
      scoring_revision_id TEXT, scored_at TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY (internal_game_id, slot)
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, scoring_revision_id TEXT,
      version INTEGER, failure_code TEXT, failure_message TEXT,
      prediction_closed_at TEXT, lineup_finalized_at TEXT, ranked_at TEXT,
      published_at TEXT, excluded_at TEXT, updated_at TEXT
    );
  `);
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0041_score_attempt_fencing.sql"), "utf8"));
  return database;
}

function insertGame(database, id, jobId, token) {
  const lease = "2099-01-01T00:00:00.000Z";
  database.prepare("INSERT INTO games (internal_game_id) VALUES (?)").run(id);
  database.prepare("INSERT INTO game_jobs_v3 (id, internal_game_id, job_type, status, claim_token, lease_expires_at) VALUES (?, ?, 'score', 'claimed', ?, ?)").run(jobId, id, token, lease);
  database.prepare("INSERT INTO game_lineups (internal_game_id, game_id, final_lineup_revision_id, lineup_fingerprint, scoring_status) VALUES (?, ?, ?, 'fp', 'pending')").run(id, id, `${id}:1`);
  database.prepare("INSERT INTO game_lineup_revisions (internal_game_id, game_id, revision_id, version, is_current, is_final) VALUES (?, ?, ?, 1, 1, 1)").run(id, id, `${id}:1`);
  database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state, version) VALUES (?, 'lineup_ready', 0)").run(id);
  database.prepare("INSERT INTO predictions (id, internal_game_id, game_id, is_test_prediction, status, scoring_status) VALUES (?, ?, ?, 0, 'submitted', 'pending')").run(`${id}:prediction`, id, id);
}

async function stageReadyAttempt(database, { attemptId, gameId, jobId, token }) {
  const db = d1(database);
  await createScoreAttempt(db, {
    attemptId, internalGameId: gameId, gameId,
    canonicalLineupRevisionId: `${gameId}:1`, scoringLineupRevisionId: `${gameId}:1`,
    lineupFingerprint: "fp", jobId, claimToken: token, expectedPredictionCount: 1,
    expectedTestCount: 0, scoringRevisionId: `${gameId}:score:1`, scoringRevisionNumber: 1,
    actualLineupJson: "[]", createdAt: "2026-09-14T00:00:00.000Z"
  });
  await stageScorePrediction(db, attemptId, {
    id: `${gameId}:prediction`, outcome: "scored",
    score: { total: 90 }, counts: { player: 9, order: 9, position: 9, perfect: 0 }
  });
  assert.equal(await markScoreAttemptReady(db, attemptId, new Date("2026-09-14T00:01:00.000Z")), true);
  return db;
}

test("0041 is additive, applies to an existing schema, and does not backfill", () => {
  const migration = fs.readFileSync(path.join(ROOT, "migrations", "0041_score_attempt_fencing.sql"), "utf8");
  assert.doesNotMatch(migration, /^\s*(UPDATE|INSERT)\b/m);
  const database = createExistingSchema();
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'score_attempt%'").all();
    assert.deepEqual(new Set(tables.map((row) => row.name)), new Set(["score_attempts", "score_attempt_prediction_rows", "score_attempt_test_rows"]));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM score_attempts").get().count, 0);
    assert.equal(database.prepare("SELECT name FROM pragma_table_info('predictions') WHERE name = 'scored_attempt_id'").get().name, "scored_attempt_id");
  } finally {
    database.close();
  }
});

test("atomic activation commits the formal score, lineage, TEST set, state, and job together", async () => {
  const database = createExistingSchema();
  try {
    const gameId = "game-atomic-1";
    const token = "claim-a";
    insertGame(database, gameId, 1, token);
    const db = await stageReadyAttempt(database, { attemptId: "attempt-a", gameId, jobId: 1, token });
    const result = await commitScoreAttempt(db, {
      attemptId: "attempt-a", jobId: 1, claimToken: token, internalGameId: gameId,
      gameId, canonicalLineupRevisionId: `${gameId}:1`, scoringLineupRevisionId: `${gameId}:1`,
      scoringRevisionId: `${gameId}:score:1`, scoringRevisionNumber: 1,
      processed: 1, perfectCount: 0, now: new Date("2026-09-14T00:02:00.000Z")
    });
    assert.equal(result.committed, true);
    assert.equal(database.prepare("SELECT status FROM score_attempts WHERE attempt_id = ?").get("attempt-a").status, "committed");
    assert.equal(database.prepare("SELECT status, score, scored_attempt_id FROM predictions WHERE id = ?").get(`${gameId}:prediction`).status, "scored");
    assert.equal(database.prepare("SELECT scored_attempt_id FROM predictions WHERE id = ?").get(`${gameId}:prediction`).scored_attempt_id, "attempt-a");
    assert.equal(database.prepare("SELECT committed_attempt_id FROM game_scoring_revisions WHERE id = ?").get(`${gameId}:score:1`).committed_attempt_id, "attempt-a");
    assert.equal(database.prepare("SELECT state, scoring_revision_id FROM game_automation_v3_state WHERE internal_game_id = ?").get(gameId).state, "scored");
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id = 1").get().status, "completed");
  } finally {
    database.close();
  }
});

test("stale token cannot activate or alter formal current, and same job with a new token gets a separate attempt", async () => {
  const database = createExistingSchema();
  try {
    const gameId = "game-atomic-2";
    insertGame(database, gameId, 2, "claim-a");
    const db = await stageReadyAttempt(database, { attemptId: "attempt-stale", gameId, jobId: 2, token: "claim-a" });
    const secondAttempt = await createScoreAttempt(db, {
      attemptId: "attempt-b", internalGameId: gameId, gameId,
      canonicalLineupRevisionId: `${gameId}:1`, scoringLineupRevisionId: `${gameId}:1`,
      lineupFingerprint: "fp", jobId: 2, claimToken: "claim-b", expectedPredictionCount: 0,
      expectedTestCount: 0, scoringRevisionId: `${gameId}:score:2`, scoringRevisionNumber: 2,
      actualLineupJson: "[]", createdAt: "2026-09-14T00:03:00.000Z"
    });
    assert.equal(secondAttempt, "attempt-b");
    database.prepare("UPDATE game_jobs_v3 SET claim_token = ? WHERE id = 2").run("claim-b");
    const result = await commitScoreAttempt(db, {
      attemptId: "attempt-stale", jobId: 2, claimToken: "claim-a", internalGameId: gameId,
      gameId, canonicalLineupRevisionId: `${gameId}:1`, scoringLineupRevisionId: `${gameId}:1`,
      scoringRevisionId: `${gameId}:score:1`, scoringRevisionNumber: 1,
      processed: 1, perfectCount: 0, now: new Date("2026-09-14T00:04:00.000Z")
    });
    assert.equal(result.committed, false);
    assert.equal(result.stale, true);
    assert.equal(database.prepare("SELECT status FROM score_attempts WHERE attempt_id = 'attempt-stale'").get().status, "ready");
    assert.equal(database.prepare("SELECT score, scored_attempt_id FROM predictions WHERE id = ?").get(`${gameId}:prediction`).score, null);
    assert.equal(database.prepare("SELECT status, claim_token FROM game_jobs_v3 WHERE id = 2").get().status, "claimed");
  } finally {
    database.close();
  }
});
