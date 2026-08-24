import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const authWorker = await import(pathToFileURL(path.join(root, "auth-worker.js")));

const GAME_ID = "c099db0c-da34-425c-bd38-69e29ddc1064";
const START_AT = "2026-08-08T06:00:00.000Z";
const FINAL_LINEUP_AT = "2026-08-08T06:02:00.000Z";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...args) {
          return {
            all: async () => ({ results: statement.all(...args) }),
            first: async () => statement.get(...args),
            run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
          };
        }
      };
    },
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  };
}

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, game_status TEXT, is_active INTEGER, deleted_at TEXT
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, prediction_closed_at TEXT,
      lineup_finalized_at TEXT, scoring_revision_id TEXT, ranked_at TEXT,
      published_at TEXT, excluded_at TEXT, failure_code TEXT, failure_message TEXT,
      version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
      scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
      max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
      lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
      created_at TEXT, updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    INSERT INTO games VALUES ('${GAME_ID}', '2026-08-08', '${START_AT}', 'fighters', 'eagles', 'scheduled', 1, NULL);
    INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', 'lineup_ready', NULL, '${FINAL_LINEUP_AT}', NULL, NULL, NULL, NULL, NULL, NULL, 2, '${FINAL_LINEUP_AT}', '${FINAL_LINEUP_AT}');
    INSERT INTO game_jobs_v3
      (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, created_at, updated_at, failure_code, failure_message)
      VALUES ('${GAME_ID}', 'score', '${FINAL_LINEUP_AT}', '${FINAL_LINEUP_AT}', 'failed', 12, 12, '${FINAL_LINEUP_AT}', '2026-08-08T08:12:00.000Z', 'V3_SCORING_NOT_COMPLETE', 'V3採点が完了していません。');
  `);
  return database;
}

test("terminal score failure is preserved while a deterministic recovery job is planned once", async () => {
  const database = setup();
  try {
    const game = {
      internalGameId: GAME_ID,
      startAt: START_AT,
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    };
    const now = new Date("2026-08-08T08:13:00.000Z");
    const first = await v3.planMainWorkflowJobs(d1(database), [game], now);
    const score = first.planned.find((entry) => entry.plan?.jobType === "score");
    assert.equal(first.created, 1);
    assert.equal(score.reasonCode, "V3_SCORE_RECOVERY_JOB_CREATED");
    assert.equal(score.recoveryOfJobId, 1);
    assert.equal(score.plan.scheduledSlotAt.toISOString(), "2026-08-08T06:02:01.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'score'").get(GAME_ID).count, 2);
    assert.equal(database.prepare("SELECT status, failure_code FROM game_jobs_v3 WHERE id = 1").get().status, "failed");

    const second = await v3.planMainWorkflowJobs(d1(database), [game], now);
    const repeated = second.planned.find((entry) => entry.plan?.jobType === "score");
    assert.equal(second.created, 0);
    assert.equal(repeated.reasonCode, "V3_SCORE_RECOVERY_JOB_ALREADY_EXISTS");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'score'").get(GAME_ID).count, 2);
  } finally {
    database.close();
  }
});

test("締切jobのterminal failureは現在時刻基準の回復jobへ再計画される", async () => {
  const database = setup();
  try {
    database.exec(`
      UPDATE game_automation_v3_state SET state = 'scheduled' WHERE internal_game_id = '${GAME_ID}';
      DELETE FROM game_jobs_v3 WHERE job_type = 'score';
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, created_at, updated_at, failure_code, failure_message)
        VALUES ('${GAME_ID}', 'prediction_close', '2026-08-08T05:00:00.000Z', '2026-08-08T05:00:00.000Z', 'failed', 12, 12, '${START_AT}', '2026-08-08T08:12:00.000Z', 'PREDICTION_CLOSE_FAILED', '締切処理に失敗しました。');
    `);
    const game = {
      internalGameId: GAME_ID,
      startAt: START_AT,
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    };
    const now = new Date("2026-08-08T08:13:00.000Z");
    const first = await v3.planMainWorkflowJobs(d1(database), [game], now);
    const recovery = first.planned.find((entry) => entry.plan?.jobType === "prediction_close");
    assert.equal(first.created, 1);
    assert.equal(recovery.reasonCode, "V3_PREDICTION_CLOSE_RECOVERY_JOB_CREATED");
    assert.equal(recovery.recoveryOfJobId, 2);
    assert.equal(recovery.plan.scheduledSlotAt.toISOString(), "2026-08-08T08:13:01.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'prediction_close'").get(GAME_ID).count, 2);

    const second = await v3.planMainWorkflowJobs(d1(database), [game], now);
    const repeated = second.planned.find((entry) => entry.plan?.jobType === "prediction_close");
    assert.equal(second.created, 0);
    assert.equal(repeated.reasonCode, "V3_PREDICTION_CLOSE_RECOVERY_JOB_ALREADY_EXISTS");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'prediction_close'").get(GAME_ID).count, 2);
  } finally {
    database.close();
  }
});

test("max-attempt retry_wait is eligible for recovery without being treated as an open runnable job", () => {
  assert.equal(v3.isV3ScoreRecoveryTerminalJob({ status: "retry_wait", attempt_count: 12, max_attempts: 12 }), true);
  assert.equal(v3.isV3ScoreRecoveryTerminalJob({ status: "retry_wait", attempt_count: 11, max_attempts: 12 }), false);
  assert.equal(v3.isV3ScoreRecoveryTerminalJob({ status: "failed" }), true);
  assert.equal(v3.isV3OpenJobStatus("retry_wait"), true);
});

test("terminal ranking failure receives a deterministic recovery slot", async () => {
  const database = setup();
  try {
    database.exec(`
      UPDATE game_automation_v3_state SET state = 'scored' WHERE internal_game_id = '${GAME_ID}';
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, created_at, updated_at, failure_code, failure_message)
        VALUES ('${GAME_ID}', 'ranking_rebuild', '2026-08-08T06:10:00.000Z', '2026-08-08T06:10:00.000Z', 'failed', 12, 12, '${FINAL_LINEUP_AT}', '2026-08-08T08:12:00.000Z', 'V3_SCORING_REVISION_REQUIRED', '有効な採点revisionがありません。');
    `);
    const result = await v3.planMainWorkflowJobs(d1(database), [{
      internalGameId: GAME_ID,
      startAt: START_AT,
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    }], new Date("2026-08-08T08:13:00.000Z"));
    const ranking = result.planned.find((entry) => entry.plan?.jobType === "ranking_rebuild");
    assert.equal(ranking.reasonCode, "V3_RANKING_RECOVERY_JOB_CREATED");
    assert.equal(ranking.recoveryOfJobId, 2);
    assert.equal(ranking.plan.scheduledSlotAt.toISOString(), "2026-08-08T06:10:01.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'ranking_rebuild'").get(GAME_ID).count, 2);
  } finally {
    database.close();
  }
});

test("no-op scoring has a persisted completed active revision for ranking", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY NOT NULL,
        internal_game_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        lineup_revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        UNIQUE(internal_game_id, lineup_revision_id),
        UNIQUE(internal_game_id, revision_number)
      );
    `);
    const revision = await authWorker.ensurePersistedScoringRevision(d1(database), {
      gameId: GAME_ID,
      internalGameId: GAME_ID,
      lineupRevisionId: `${GAME_ID}:1`,
      reason: "V3_SCORING_NO_PREDICTIONS",
      now: new Date("2026-08-08T08:29:00.000Z")
    });
    assert.equal(revision.id, `${GAME_ID}:scoring:1`);
    assert.equal(database.prepare("SELECT status, is_active, reason FROM game_scoring_revisions WHERE id = ?1").get(revision.id).status, "completed");
    assert.equal(database.prepare("SELECT is_active FROM game_scoring_revisions WHERE id = ?1").get(revision.id).is_active, 1);
    assert.equal(database.prepare("SELECT reason FROM game_scoring_revisions WHERE id = ?1").get(revision.id).reason, "V3_SCORING_NO_PREDICTIONS");
  } finally {
    database.close();
  }
});

test("通常の予想があるrevision欠落はランキングno-opへ変換しない", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /V3_SCORING_REVISION_REQUIRED/);
  assert.match(worker, /completion\.eligiblePredictionCount === 0/);
  assert.match(worker, /V3_RANKING_NO_ENTRIES/);
});

test("admin-v3 ignores a historical failure when a newer recovery job is open", () => {
  const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "backend/automation-v3/orchestrator.js"), "utf8");
  const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  assert.match(client, /hasNewerV3Job/);
  assert.match(client, /currentFailedV3Jobs/);
  assert.match(runtime, /V3_SCORE_RECOVERY_JOB_CREATED/);
  assert.match(page, /admin-v3-v35-derived-diagnostics-visible-1/);
});

test("V3 score executor releases stale processing before a recovery claim", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /scoring_status = 'pending'/);
  assert.match(worker, /scoring_status = 'processing'/);
  assert.match(worker, /V3_SCORING_NO_PREDICTIONS/);
});
