import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { reconcileV3ManualFinalLineupState } from "../auth-worker.js";
import { planV3MainJobs } from "../backend/automation-v3/orchestrator.js";

const GAME_ID = "3c270103-abdf-4f89-bd09-b79c4372dac1";
const START_AT = "2026-09-05T09:00:00.000Z";
const NOW = new Date("2026-09-05T10:01:00.000Z");

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
        bind(...parameters) {
          return {
            all: async () => ({ results: statement.all(...parameters) }),
            first: async () => statement.get(...parameters),
            run: async () => {
              const result = statement.run(...parameters);
              return { meta: { changes: Number(result.changes || 0) } };
            }
          };
        }
      };
    }
  };
}

function lineup() {
  return JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index],
    playerId: `F-${index + 1}`,
    playerName: `Fighter ${index + 1}`
  })));
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT,
      is_active INTEGER, deleted_at TEXT
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
      prediction_closed_at TEXT, lineup_finalized_at TEXT, ranked_at TEXT,
      published_at TEXT, excluded_at TEXT, failure_code TEXT, failure_message TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
      scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
      max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
      lease_expires_at TEXT, completed_at TEXT, failure_code TEXT,
      failure_message TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT, is_final INTEGER, actual_lineup_json TEXT, version INTEGER,
      source TEXT, game_id TEXT, revision_id TEXT, is_current INTEGER
    );
    CREATE TABLE game_lineups (
      id TEXT, game_id TEXT, internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT,
      lineup_fingerprint TEXT, schema_version INTEGER, lineup_detected_at TEXT,
      scoring_due_at TEXT, scoring_started_at TEXT, scored_at TEXT,
      scoring_status TEXT, scoring_attempts INTEGER, last_error TEXT,
      processed_predictions INTEGER, perfect_count INTEGER, new_perfect_achievers INTEGER,
      lineup_source TEXT, publication_status TEXT, published_at TEXT,
      final_lineup_revision_id TEXT, finalized_at TEXT, finalized_by TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE ranking_games (
      internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT
    );
    CREATE TABLE ranking_reflection_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
      ranking_update_revision INTEGER, status TEXT
    );
    INSERT INTO games VALUES (
      '${GAME_ID}', '2026-09-05', '${START_AT}', 'eagles', 'fighters', 'e-f-21',
      'scheduled', 1, NULL
    );
    INSERT INTO game_automation_v3_state (
      internal_game_id, state, version, created_at, updated_at
    ) VALUES (
      '${GAME_ID}', 'prediction_closed', 1, '${START_AT}', '${START_AT}'
    );
    INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 1, '${lineup()}', 1, 'manual-revision', '${GAME_ID}', '${GAME_ID}:1', 1);
    INSERT INTO game_lineups (
      id, game_id, internal_game_id, actual_lineup_json, lineup_fingerprint,
      lineup_source, scoring_status, publication_status
    ) VALUES ('lineup-1', '${GAME_ID}', '${GAME_ID}', '${lineup()}', 'fingerprint', 'manual', 'pending', 'pending');
    INSERT INTO ranking_games VALUES ('${GAME_ID}', 'pending', NULL);
  `);
  return { database, db: d1(database) };
}

test("V4 manual final lineupはfetch disabledでもformal Cronのscoring jobへ継続する", async () => {
  const { database, db } = fixture();
  try {
    const result = await planV3MainJobs(db, [{
      internalGameId: GAME_ID,
      gameDate: "2026-09-05",
      startAt: START_AT,
      homeTeam: "eagles",
      awayTeam: "fighters",
      npbGameCode: "e-f-21",
      npbIdentityStatus: "resolved",
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    }], NOW, { disabledStages: ["roster_fetch", "lineup_fetch"] });

    const scorePlan = result.planned.find((entry) => entry.plan?.jobType === "score");
    const scoreDiagnostic = result.diagnostics.find((entry) => entry.stage === "scoring");
    const scoreJob = database.prepare(
      "SELECT job_type, status FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'score'"
    ).get(GAME_ID);
    assert.equal(scorePlan?.created, true, JSON.stringify(result));
    assert.equal(scoreJob?.job_type, "score");
    assert.equal(scoreJob?.status, "pending");
    assert.equal(scoreDiagnostic?.stateMismatch, true);
    assert.equal(result.planned.some((entry) => entry.plan?.jobType === "lineup_fetch"), false);
    assert.equal(result.planned.some((entry) => entry.plan?.jobType === "roster_fetch"), false);
  } finally {
    database.close();
  }
});

test("V4 manual scoring後もranking_reflectとpublishのformal plannerへ継続する", async () => {
  const { database, db } = fixture();
  try {
    database.prepare(
      "UPDATE game_automation_v3_state SET state = 'scored' WHERE internal_game_id = ?1"
    ).run(GAME_ID);
    database.prepare(
      "UPDATE game_lineups SET scoring_status = 'scored', scored_at = ?1 WHERE internal_game_id = ?2"
    ).run(NOW.toISOString(), GAME_ID);

    const rankingPlan = await planV3MainJobs(db, [{
      internalGameId: GAME_ID,
      gameDate: "2026-09-05",
      startAt: START_AT,
      homeTeam: "eagles",
      awayTeam: "fighters",
      npbGameCode: "e-f-21",
      npbIdentityStatus: "resolved",
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    }], NOW, { disabledStages: ["roster_fetch", "lineup_fetch"] });
    assert.equal(rankingPlan.planned.find((entry) => entry.plan?.jobType === "ranking_rebuild")?.created, true);

    database.prepare(
      "UPDATE game_automation_v3_state SET state = 'ranked' WHERE internal_game_id = ?1"
    ).run(GAME_ID);
    database.prepare(
      "INSERT INTO ranking_reflection_revisions (internal_game_id, ranking_update_revision, status) VALUES (?1, 1, 'reflected')"
    ).run(GAME_ID);
    const publishPlan = await planV3MainJobs(db, [{
      internalGameId: GAME_ID,
      gameDate: "2026-09-05",
      startAt: START_AT,
      homeTeam: "eagles",
      awayTeam: "fighters",
      npbGameCode: "e-f-21",
      npbIdentityStatus: "resolved",
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    }], NOW, { disabledStages: ["roster_fetch", "lineup_fetch"] });
    assert.equal(publishPlan.planned.find((entry) => entry.plan?.jobType === "publish")?.created, true);
  } finally {
    database.close();
  }
});

test("V4 state mismatchはmanual final artifactを検証してscore前にlineup_readyへ同期する", async () => {
  const { database, db } = fixture();
  try {
    const result = await reconcileV3ManualFinalLineupState(
      db,
      GAME_ID,
      "prediction_closed",
      NOW
    );
    const state = database.prepare(
      "SELECT state, version FROM game_automation_v3_state WHERE internal_game_id = ?1"
    ).get(GAME_ID);
    assert.equal(result.reconciled, true);
    assert.equal(result.state, "lineup_ready");
    assert.equal(state.state, "lineup_ready");
    assert.equal(state.version, 2);
  } finally {
    database.close();
  }
});
