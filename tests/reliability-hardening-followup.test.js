import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { failGameScoringRevision, releaseStaleGameLineupScoringMarker } from "../auth-worker.js";

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
    }
  };
}

test("stale score executor cannot fail a revision after another claim succeeds", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, is_active INTEGER NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, status TEXT, claim_token TEXT, lease_expires_at TEXT, job_type TEXT
      );
      INSERT INTO game_scoring_revisions VALUES ('score-1', 'in_progress', 0, NULL);
      INSERT INTO game_jobs_v3 VALUES (1, 'claimed', 'token-b', '2099-01-01T00:00:00.000Z', 'score');
    `);

    const stale = await failGameScoringRevision(d1(database), {
      scoringRevisionId: "score-1",
      jobId: 1,
      claimToken: "token-a",
      now: new Date("2026-09-12T10:00:00.000Z")
    });
    assert.deepEqual(stale, { updated: false, stale: true });
    const pendingRevision = database.prepare("SELECT status, is_active FROM game_scoring_revisions WHERE id = 'score-1'").get();
    assert.equal(pendingRevision.status, "in_progress");
    assert.equal(pendingRevision.is_active, 0);

    database.prepare("UPDATE game_scoring_revisions SET status = 'completed', is_active = 1, completed_at = ? WHERE id = 'score-1'")
      .run("2026-09-12T10:01:00.000Z");
    const lateFailure = await failGameScoringRevision(d1(database), {
      scoringRevisionId: "score-1",
      jobId: 1,
      claimToken: "token-a",
      now: new Date("2026-09-12T10:02:00.000Z")
    });
    assert.deepEqual(lateFailure, { updated: false, stale: true });
    const completedRevision = database.prepare("SELECT status, is_active FROM game_scoring_revisions WHERE id = 'score-1'").get();
    assert.equal(completedRevision.status, "completed");
    assert.equal(completedRevision.is_active, 1);
  } finally {
    database.close();
  }
});

test("current score job may fail only an in-progress revision", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, is_active INTEGER NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, status TEXT, claim_token TEXT, lease_expires_at TEXT, job_type TEXT
      );
      INSERT INTO game_scoring_revisions VALUES ('score-2', 'in_progress', 0, NULL);
      INSERT INTO game_jobs_v3 VALUES (2, 'claimed', 'token-current', '2099-01-01T00:00:00.000Z', 'score');
    `);
    const result = await failGameScoringRevision(d1(database), {
      scoringRevisionId: "score-2",
      jobId: 2,
      claimToken: "token-current",
      now: new Date("2026-09-12T10:00:00.000Z")
    });
    assert.deepEqual(result, { updated: true, stale: false });
    assert.equal(database.prepare("SELECT status FROM game_scoring_revisions WHERE id = 'score-2'").get().status, "failed");
  } finally {
    database.close();
  }
});

test("same-job reclaim isolates marker release and failure even when reclaim occurs at UPDATE", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, scoring_status TEXT,
        scoring_started_at TEXT, last_error TEXT, updated_at TEXT);
      CREATE TABLE game_scoring_revisions (id TEXT PRIMARY KEY, status TEXT, is_active INTEGER, completed_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        status TEXT, claim_token TEXT, lease_expires_at TEXT);
      INSERT INTO game_lineups VALUES ('game-1', 'processing', '2026-09-12T09:00:00Z', NULL, NULL);
      INSERT INTO game_scoring_revisions VALUES ('score-1', 'in_progress', 0, NULL);
      INSERT INTO game_jobs_v3 VALUES (1, 'game-1', 'score', 'claimed', 'A', '2000-01-01T00:00:00Z');
    `);
    const old = { id: 1, claim_token: "A" };
    const at = new Date("2026-09-12T09:01:00Z");
    database.prepare("UPDATE game_jobs_v3 SET claim_token='B', lease_expires_at='2099-01-01T00:00:00Z' WHERE id=1").run();
    assert.equal(await releaseStaleGameLineupScoringMarker(d1(database), { internalGameId: "game-1", job: old, now: at }), false);
    assert.equal(database.prepare("SELECT scoring_status FROM game_lineups").get().scoring_status, "processing");
    assert.deepEqual(await failGameScoringRevision(d1(database), {
      scoringRevisionId: "score-1", internalGameId: "game-1", jobId: 1, claimToken: "A", now: at
    }), { updated: false, stale: true });
    assert.equal(database.prepare("SELECT status FROM game_scoring_revisions").get().status, "in_progress");

    database.prepare("UPDATE game_jobs_v3 SET claim_token='A' WHERE id=1").run();
    let reclaimed = false;
    const interleaved = {
      prepare(sql) {
        if (sql.startsWith("UPDATE game_scoring_revisions SET status = 'failed'")) {
          database.prepare("UPDATE game_jobs_v3 SET claim_token='B' WHERE id=1").run();
          reclaimed = true;
        }
        return d1(database).prepare(sql);
      }
    };
    assert.deepEqual(await failGameScoringRevision(interleaved, {
      scoringRevisionId: "score-1", internalGameId: "game-1", jobId: 1, claimToken: "A", now: at
    }), { updated: false, stale: true });
    assert.equal(reclaimed, true);
    database.prepare("UPDATE game_scoring_revisions SET status='completed', is_active=1 WHERE id='score-1'").run();
    assert.deepEqual(await failGameScoringRevision(d1(database), {
      scoringRevisionId: "score-1", internalGameId: "game-1", jobId: 1, claimToken: "A", now: at
    }), { updated: false, stale: true });
    assert.equal(database.prepare("SELECT status, is_active FROM game_scoring_revisions").get().is_active, 1);
    database.prepare("UPDATE game_jobs_v3 SET claim_token='A', lease_expires_at='2000-01-01T00:00:00Z' WHERE id=1").run();
    assert.equal(await releaseStaleGameLineupScoringMarker(d1(database), { internalGameId: "game-1", job: old, now: at }), false);
  } finally { database.close(); }
});
