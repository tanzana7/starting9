import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeV3LineupFetchError, selectV3LineupFinalizeCandidate } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function createDbAdapter(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...parameters) {
          return {
            all: async () => ({ results: statement.all(...parameters) }),
            first: async () => statement.get(...parameters)
          };
        }
      };
    }
  };
}

function lineupRows() {
  return ["遊", "二", "三", "一", "左", "中", "右", "捕", "指"].map((position, index) => ({
    battingOrder: index + 1,
    teamCode: "fighters",
    teamId: "F",
    uniformNumber: String(index + 1),
    playerId: `F-${index + 1}`,
    playerName: `選手${index + 1}`,
    displayName: `選手${index + 1}`,
    position
  }));
}

test("production-shaped game_lineup_revisions without id column remains readable", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_lineup_revisions (
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      actual_lineup_json TEXT NOT NULL,
      lineup_fingerprint TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      revision_id TEXT,
      internal_game_id TEXT,
      captured_at TEXT,
      validation_json TEXT,
      is_final INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, version)
    )
  `);
  database.prepare(`
    INSERT INTO game_lineup_revisions
      (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, reason, revision_id, internal_game_id, captured_at)
    VALUES (?, 1, ?, 'fingerprint', 'npb-auto', ?, 'candidate', ?, ?, ?)
  `).run(
    "c099db0c-da34-425c-bd38-69e29ddc1064",
    JSON.stringify(lineupRows()),
    "2026-08-08T05:30:00.000Z",
    "c099db0c-da34-425c-bd38-69e29ddc1064:1",
    "c099db0c-da34-425c-bd38-69e29ddc1064",
    "2026-08-08T05:30:00.000Z"
  );
  try {
    const result = await selectV3LineupFinalizeCandidate(createDbAdapter(database), {
      internalGameId: "c099db0c-da34-425c-bd38-69e29ddc1064"
    });
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.selectedRevisionId, "c099db0c-da34-425c-bd38-69e29ddc1064:1");
    assert.doesNotMatch(workerSource, /game_lineup_revisions[\s\S]{0,180}ORDER BY version DESC, id DESC/);
  } finally {
    database.close();
  }
});

test("lineup fetch classifies unannounced data as retryable waiting", () => {
  const error = normalizeV3LineupFetchError({
    code: "LINEUP_INVALID_PLAYER_COUNT",
    validation: { parsedCount: 0 }
  }, new Date("2026-08-08T05:40:00.000Z"));
  assert.equal(error.code, "LINEUP_NOT_ANNOUNCED");
  assert.equal(error.retryable, true);
  assert.equal(error.reasonCode, "LINEUP_DATA_NOT_ANNOUNCED");
});

test("lineup executor diagnostics retain unexpected exception context without secrets", () => {
  assert.match(workerSource, /executorStage/);
  assert.match(workerSource, /exceptionName/);
  assert.match(workerSource, /exceptionMessage/);
  assert.match(workerSource, /selectedSlot/);
  assert.match(workerSource, /NPB_GAME_CODE_NOT_AVAILABLE/);
});
