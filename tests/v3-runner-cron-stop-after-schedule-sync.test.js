import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async (...args) => ({ results: statement.all(...args) }),
        first: async (...args) => statement.get(...args),
        run: async (...args) => ({ meta: { changes: Number(statement.run(...args).changes || 0) } }),
        bind(...args) {
          return {
            all: async () => ({ results: statement.all(...args) }),
            first: async () => statement.get(...args),
            run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
          };
        }
      };
    }
  };
}

test("監査observerが停止しても、lineup_finalizeの計画・claim・executorは完走する", async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "022a8838-9e5c-4d64-88b7-7a8b43181aed";
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_identifiers (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, provider TEXT,
        identifier_type TEXT, identifier_value TEXT, updated_at TEXT
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
      INSERT INTO games VALUES (
        '${internalGameId}', '2026-08-12', '2026-08-12T09:00:00.000Z',
        'fighters', 'lions', NULL, 'unresolved', 'scheduled', 1, NULL
      );
      INSERT INTO game_identifiers VALUES (
        1, '${internalGameId}', 'npb', 'npb_game_code', 'f-l-19',
        '2026-08-11T09:35:22.583Z'
      );
      INSERT INTO game_automation_v3_state VALUES (
        '${internalGameId}', 'prediction_closed', '2026-08-12T08:00:00.000Z',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-08-12T08:00:00.000Z', '2026-08-12T08:00:00.000Z'
      );
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const now = new Date("2026-08-12T09:03:00.000Z");
    const result = await v3.runGameAutomationV3(env, now, {
      observerTimeoutMs: 5,
      onPlan: () => new Promise(() => {}),
      onSuccess: () => new Promise(() => {}),
      executeJob: async ({ job }) => ({
        status: "completed",
        stateBefore: job.job_type === "lineup_finalize" ? "prediction_closed" : "scheduled",
        stateAfter: job.job_type === "lineup_finalize" ? "lineup_ready" : "scheduled"
      })
    });
    const job = database.prepare(
      "SELECT job_type, status FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'lineup_finalize'"
    ).get(internalGameId);
    const state = database.prepare(
      "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1"
    ).get(internalGameId);
    assert.equal(result.mainPlan.planned.find((item) => item.plan?.jobType === "lineup_finalize")?.plan.jobType, "lineup_finalize");
    assert.equal(result.processed, 2);
    assert.equal(job.job_type, "lineup_finalize");
    assert.equal(job.status, "completed");
    assert.equal(state.state, "lineup_ready");
  } finally {
    database.close();
  }
});

test("f-l-19相当のidentity hydration後は18:02のlineup_finalizeを生成する", async () => {
  const game = {
    internalGameId: "022a8838-9e5c-4d64-88b7-7a8b43181aed",
    gameDate: "2026-08-12",
    startAt: "2026-08-12T09:00:00.000Z",
    gameStatus: "scheduled",
    isActive: 1,
    npbIdentityStatus: "resolved",
    npbGameCode: "f-l-19"
  };
  const plans = v3.getV3DuePlans(game, "prediction_closed", new Date("2026-08-12T09:02:00.000Z"));
  assert.deepEqual(plans.map((plan) => [plan.jobType, plan.scheduledSlotAt.toISOString()]), [
    ["lineup_finalize", "2026-08-12T09:02:00.000Z"]
  ]);
});

test("18:00開始試合は17:40/17:50/18:00をpollingし、18:02以後はfinalizeへ切り替える", () => {
  const game = {
    internalGameId: "022a8838-9e5c-4d64-88b7-7a8b43181aed",
    gameDate: "2026-08-12",
    startAt: "2026-08-12T09:00:00.000Z",
    gameStatus: "scheduled",
    isActive: 1,
    npbIdentityStatus: "resolved",
    npbGameCode: "f-l-19"
  };
  for (const slot of ["2026-08-12T08:40:00.000Z", "2026-08-12T08:50:00.000Z", "2026-08-12T09:00:00.000Z"]) {
    const plans = v3.getV3DuePlans(game, "prediction_closed", new Date(slot));
    assert.deepEqual(plans.map((plan) => [plan.jobType, plan.scheduledSlotAt.toISOString()]), [["lineup_fetch", slot]]);
  }
  const finalizePlans = v3.getV3DuePlans(game, "prediction_closed", new Date("2026-08-12T09:02:00.000Z"));
  assert.deepEqual(finalizePlans.map((plan) => [plan.jobType, plan.scheduledSlotAt.toISOString()]), [["lineup_finalize", "2026-08-12T09:02:00.000Z"]]);
});

test("scheduled runnerはschedule sync後もsummaryまたはfailed監査へ到達する契約を維持する", () => {
  const workerPath = path.join(root, "auth-worker.js");
  const source = fs.readFileSync(workerPath, "utf8");
  const runnerStart = source.indexOf("async function runScheduledGameAutomationV3");
  assert.notEqual(runnerStart, -1);
  const runner = source.slice(runnerStart);
  assert.match(runner, /runGameAutomationV3\(/);
  assert.match(runner, /eventType:\s*"cron_run_summary"/);
  assert.match(runner, /eventType:\s*"cron_run_failed"/);
});
