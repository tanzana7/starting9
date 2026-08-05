import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));

const GAME_ID = "12d554bb-ad25-44be-8159-0134c046dcee";
const START = "2026-08-04T09:00:00.000Z";

function game() {
  return { internalGameId: GAME_ID, startAt: START, gameStatus: "scheduled", isActive: 1, deletedAt: null };
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => {
          const result = statement.run(...params);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
        bind(...params) {
          return bound(...params);
        }
      };
    }
  };
}

test("V3はfeature flagが明示的に有効なときだけ起動する", () => {
  assert.equal(v3.isGameAutomationV3Enabled({}), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "false" }), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "true" }), true);
});

test("V3の派生時刻はDB startAtから固定され、外部IDを要求しない", () => {
  const schedule = v3.deriveV3Schedule(game());
  assert.equal(schedule.predictionDeadline.toISOString(), "2026-08-04T08:00:00.000Z");
  assert.equal(schedule.lineupPollingStart.toISOString(), "2026-08-04T08:10:00.000Z");
  assert.equal(schedule.finalLineupAt.toISOString(), "2026-08-04T09:02:00.000Z");
  assert.equal(schedule.publicationAt.toISOString(), "2026-08-04T09:10:00.000Z");
  assert.equal(v3.getV3DuePlan(game(), "scheduled", "2026-08-04T08:00:00.000Z").jobType, "prediction_close");
});

test("V3の状態機械は正常遷移だけを受け入れ、旧状態名を含めない", () => {
  assert.equal(v3.getV3AllowedTransitions("scheduled", "prediction_closed"), true);
  assert.equal(v3.getV3AllowedTransitions("prediction_closed", "lineup_ready"), true);
  assert.equal(v3.getV3AllowedTransitions("lineup_ready", "scored"), true);
  assert.equal(v3.getV3AllowedTransitions("scored", "ranked"), true);
  assert.equal(v3.getV3AllowedTransitions("ranked", "published"), true);
  assert.equal(v3.getV3AllowedTransitions("published", "scored"), false);
  assert.equal(v3.getV3AllowedTransitions("scheduled", "retrying"), false);
});

test("V3 job slot is unique and claim is atomic", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...args) { statements.push({ sql, args }); return { async run() { return { meta: { changes: 1 } }; }, async first() { return { id: 1, ...Object.fromEntries(args.map((value, index) => [`arg${index}`, value])) }; } }; } };
    }
  };
  const created = await v3.createV3Job(db, { internalGameId: GAME_ID, jobType: "lineup_fetch", scheduledSlotAt: START });
  assert.equal(created.created, true);
  assert.match(statements[0].sql, /INSERT OR IGNORE/);
  assert.match(statements[0].sql, /UNIQUE|game_jobs_v3/);
});

test("V3 runnerは同じDB行をprediction closeからpublishまで一度ずつ進める", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      const next = { prediction_close: "prediction_closed", lineup_finalize: "lineup_ready", score: "scored", ranking_rebuild: "ranked", publish: "published" }[job.job_type];
      const current = { prediction_close: "scheduled", lineup_finalize: "prediction_closed", score: "lineup_ready", ranking_rebuild: "scored", publish: "ranked" }[job.job_type];
      return { stateBefore: current, stateAfter: next || current, status: "completed" };
    };
    for (const at of ["2026-08-04T08:00:00.000Z", "2026-08-04T08:10:00.000Z", "2026-08-04T09:02:00.000Z", "2026-08-04T09:03:00.000Z", "2026-08-04T09:10:00.000Z", "2026-08-04T09:11:00.000Z"]) {
      await v3.runGameAutomationV3(env, new Date(at), { executeJob });
    }
    assert.deepEqual(executed, ["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "published");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 6);
  } finally {
    database.close();
  }
});

test("0029 is additive, has no backfill, and applies to an existing migration chain", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const files = fs.readdirSync(path.join(root, "migrations"))
      .filter((file) => /^00(?:0[1-9]|1[0-9]|2[0-8])_.*\.sql$/.test(file))
      .sort();
    for (const file of files) database.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
    database.exec(`INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'completed', '${START}', '${START}')`);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0029_game_automation_v3.sql"), "utf8"));
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('game_jobs_v3', 'game_automation_v3_state') ORDER BY name").all();
    assert.deepEqual(table.map((row) => row.name), ["game_automation_v3_state", "game_jobs_v3"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
    assert.equal(database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?1").get(GAME_ID).start_time, START);
  } finally {
    database.close();
  }
});
