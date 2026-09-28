import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listV3Games } from "../backend/automation-v3/repository.js";
import { planMainWorkflowJobs } from "../backend/automation-v3/orchestrator.js";

const NOW = new Date("2026-09-27T08:37:00.000Z");
const TARGET_ID = "00000000-0000-4000-8000-000000000005";
const TARGET_REVISION = `${TARGET_ID}:1`;

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async (...args) => ({ results: statement.all(...args) }),
        first: async (...args) => statement.get(...args),
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

function lineupJson() {
  return JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index],
    playerId: `player-${index + 1}`,
    playerName: `選手${index + 1}`
  })));
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, npb_game_code TEXT,
      npb_identity_status TEXT, game_status TEXT, is_active INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
      job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT,
      status TEXT, attempt_count INTEGER, max_attempts INTEGER,
      next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
      lease_expires_at TEXT, completed_at TEXT, failure_code TEXT,
      failure_message TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_lineups (
      internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT,
      lineup_fingerprint TEXT, scoring_status TEXT, scored_at TEXT,
      publication_status TEXT, published_at TEXT,
      final_lineup_revision_id TEXT, finalized_at TEXT, finalized_by TEXT
    );
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT, game_id TEXT, revision_id TEXT, version INTEGER,
      is_final INTEGER, is_current INTEGER, actual_lineup_json TEXT,
      lineup_fingerprint TEXT, source TEXT, finalized_at TEXT
    );
    CREATE TABLE game_scoring_revisions (
      id TEXT PRIMARY KEY, internal_game_id TEXT, lineup_revision_id TEXT,
      status TEXT, is_active INTEGER, revision_number INTEGER, completed_at TEXT
    );
    CREATE TABLE ranking_reflection_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
      scoring_revision_id TEXT, ranking_update_revision INTEGER,
      status TEXT, reflected_at TEXT
    );
    CREATE TABLE ranking_games (
      internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT
    );
    CREATE TABLE game_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
      provider TEXT, identifier_type TEXT, identifier_value TEXT, updated_at TEXT
    );
  `);

  const oldIds = Array.from({ length: 4 }, (_, index) =>
    `00000000-0000-4000-8000-00000000000${index + 1}`);
  for (const [index, id] of oldIds.entries()) {
    database.prepare(
      `INSERT INTO games VALUES (?, '2026-09-27', ?, 'fighters', 'hawks', ?, 'resolved', 'scheduled', 1, NULL)`
    ).run(id, `2026-09-27T0${5 + index}:00:00.000Z`, `f-h-${index + 1}`);
    database.prepare("INSERT INTO game_automation_v3_state VALUES (?, 'scheduled', 1)").run(id);
    database.prepare(
      `INSERT INTO game_lineups VALUES (?, '[]', '', 'pending', NULL, 'pending', NULL, NULL, NULL, NULL)`
    ).run(id);
    database.prepare("INSERT INTO ranking_games VALUES (?, 'pending', NULL)").run(id);
    const completedAt = new Date(NOW.getTime() - (index + 1) * 60_000).toISOString();
    database.prepare(`
      INSERT INTO game_jobs_v3 (
        internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, completed_at, created_at, updated_at
      ) VALUES (?, 'prediction_close', ?, ?, 'completed', 1, 12, ?, ?, ?)
    `).run(id, completedAt, completedAt, completedAt, completedAt, completedAt);
  }

  database.prepare(
    `INSERT INTO games VALUES (?, '2026-09-27', '2026-09-27T09:00:00.000Z', 'marines', 'fighters', 'm-f-23', 'resolved', 'scheduled', 1, NULL)`
  ).run(TARGET_ID);
  database.prepare("INSERT INTO game_automation_v3_state VALUES (?, 'prediction_closed', 1)").run(TARGET_ID);
  database.prepare(
    `INSERT INTO game_lineups VALUES (?, ?, 'target-fingerprint', 'pending', NULL, 'pending', NULL, ?, '2026-09-27T08:29:00.000Z', 'admin')`
  ).run(TARGET_ID, lineupJson(), TARGET_REVISION);
  database.prepare(
    `INSERT INTO game_lineup_revisions VALUES (?, ?, ?, 1, 1, 1, ?, 'target-fingerprint', 'manual-revision', '2026-09-27T08:29:00.000Z')`
  ).run(TARGET_ID, TARGET_ID, TARGET_REVISION, lineupJson());
  database.prepare("INSERT INTO ranking_games VALUES (?, 'pending', NULL)").run(TARGET_ID);

  return { database, db: d1(database), oldIds };
}

test("採点dueのcanonical final試合をbounded discoveryの先頭へ優先する", async () => {
  const { database, db } = fixture();
  try {
    const games = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    assert.equal(games.length, 4);
    assert.equal(games[0].internalGameId, TARGET_ID);
    assert.equal(games.some((game) => game.internalGameId === TARGET_ID), true);
  } finally {
    database.close();
  }
});

test("優先発見された試合は既存formal planner経由でscore jobを作る", async () => {
  const { database, db } = fixture();
  try {
    const games = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    assert.equal(games[0].internalGameId, TARGET_ID);
    const result = await planMainWorkflowJobs(db, games, NOW, {
      disabledStages: ["roster_fetch", "lineup_fetch"],
      v4SemiAuto: true
    });
    const score = result.planned.find((entry) => entry.game?.internalGameId === TARGET_ID
      && entry.plan?.jobType === "score");
    assert.ok(score, JSON.stringify(result, (_key, value) => value instanceof Date ? value.toISOString() : value));
    assert.equal(score.created, true);
    const persisted = database.prepare(
      "SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ? AND job_type = 'score'"
    ).get(TARGET_ID);
    assert.equal(Number(persisted.count), 1);
  } finally {
    database.close();
  }
});

test("同一試合の既存score jobはpriority後も重複作成しない", async () => {
  const { database, db } = fixture();
  try {
    database.prepare(
      `INSERT INTO game_jobs_v3 (
        internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, created_at, updated_at
      ) VALUES (?, 'score', ?, ?, 'pending', 0, 12, ?, ?)`
    ).run(TARGET_ID, NOW.toISOString(), "2026-09-27T08:00:00.000Z", NOW.toISOString(), NOW.toISOString());
    const games = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    const result = await planMainWorkflowJobs(db, games, NOW, {
      disabledStages: ["roster_fetch", "lineup_fetch"],
      v4SemiAuto: true
    });
    assert.equal(result.planned.filter((entry) => entry.game?.internalGameId === TARGET_ID
      && entry.plan?.jobType === "score").length, 0);
    const persisted = database.prepare(
      "SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ? AND job_type = 'score'"
    ).get(TARGET_ID);
    assert.equal(Number(persisted.count), 1);
  } finally {
    database.close();
  }
});

test("先頭4試合が残り続けてもdue試合を毎回boundedに再発見する", async () => {
  const { database, db } = fixture();
  try {
    for (let run = 0; run < 3; run += 1) {
      const games = await listV3Games(db, new Date(NOW.getTime() + run * 60 * 1000), {
        limit: 4,
        prioritizeDue: true
      });
      assert.ok(games.length <= 4);
      assert.equal(games.some((game) => game.internalGameId === TARGET_ID), true);
    }
  } finally {
    database.close();
  }
});

test("未処理のprediction_closeは同日bounded discoveryでscore候補より先に再発見する", async () => {
  const { database, db } = fixture();
  try {
    database.prepare("UPDATE game_automation_v3_state SET state = 'scheduled' WHERE internal_game_id = ?")
      .run(TARGET_ID);
    const games = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    assert.equal(games[0].internalGameId, TARGET_ID);
  } finally {
    database.close();
  }
});

test("scored/rankedの下流候補も通常未完了試合より優先する", async () => {
  const { database, db } = fixture();
  try {
    database.prepare("UPDATE game_automation_v3_state SET state = 'scored' WHERE internal_game_id = ?").run(TARGET_ID);
    database.prepare("UPDATE game_lineups SET scoring_status = 'scored', scored_at = ? WHERE internal_game_id = ?")
      .run(NOW.toISOString(), TARGET_ID);
    const rankedCandidate = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    assert.equal(rankedCandidate[0].internalGameId, TARGET_ID);

    database.prepare("UPDATE game_automation_v3_state SET state = 'ranked' WHERE internal_game_id = ?").run(TARGET_ID);
    const publishCandidate = await listV3Games(db, NOW, { limit: 4, prioritizeDue: true });
    assert.equal(publishCandidate[0].internalGameId, TARGET_ID);
  } finally {
    database.close();
  }
});
