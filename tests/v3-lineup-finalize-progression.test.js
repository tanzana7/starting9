import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { selectV3LineupFinalizeCandidate } from "../auth-worker.js";

function createDbAdapter(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...parameters) {
          return {
            all: async () => ({ results: statement.all(...parameters) }),
            first: async () => statement.get(...parameters),
            run: async () => ({ meta: { changes: statement.run(...parameters).changes } })
          };
        }
      };
    }
  };
}

function buildLineup({ unresolved = false, count = 9 } = {}) {
  const positions = ["遊", "二", "三", "一", "左", "中", "右", "捕", "指"];
  return positions.slice(0, count).map((position, index) => ({
    battingOrder: index + 1,
    teamCode: "fighters",
    teamId: "F",
    uniformNumber: String(index + 1),
    playerId: unresolved && index === 0 ? null : `F-${index + 1}`,
    playerName: unresolved && index === 0 ? "未解決選手" : `選手${index + 1}`,
    displayName: unresolved && index === 0 ? "未解決選手" : `選手${index + 1}`,
    position
  }));
}

function createFixture(lineup) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_lineup_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      internal_game_id TEXT NULL,
      version INTEGER NOT NULL,
      revision_id TEXT NULL,
      actual_lineup_json TEXT NOT NULL,
      validation_json TEXT NULL,
      captured_at TEXT NULL,
      created_at TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 0
    )
  `);
  database.prepare(`
    INSERT INTO game_lineup_revisions
      (game_id, internal_game_id, version, revision_id, actual_lineup_json, created_at, is_final)
    VALUES (?, ?, 1, ?, ?, ?, 0)
  `).run(
    "legacy-readable-id",
    "12d554bb-ad25-44be-8159-0134c046dcee",
    "12d554bb-ad25-44be-8159-0134c046dcee:1",
    JSON.stringify(lineup),
    "2026-08-07T09:20:00.000Z"
  );
  return { database, db: createDbAdapter(database) };
}

test("lineup_finalizeはgame_idではなくcanonical internal_game_idの候補を確定対象にする", async () => {
  const fixture = createFixture(buildLineup());
  try {
    const result = await selectV3LineupFinalizeCandidate(fixture.db, {
      internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee"
    });
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.lookup, "game_lineup_revisions.internal_game_id");
    assert.equal(result.diagnostics.provisionalLineupFound, true);
    assert.equal(result.diagnostics.playerCount, 9);
    assert.equal(result.diagnostics.selectedRevisionId, "12d554bb-ad25-44be-8159-0134c046dcee:1");
    assert.equal(result.lineup[0].playerId, "F-1");
  } finally {
    fixture.database.close();
  }
});

test("lineup_finalizeは不完全なcanonical候補を具体的なコードで拒否する", async () => {
  const fixture = createFixture(buildLineup({ count: 8 }));
  try {
    const result = await selectV3LineupFinalizeCandidate(fixture.db, {
      internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "V3_LINEUP_INCOMPLETE");
    assert.equal(result.diagnostics.candidateCount, 1);
    assert.equal(result.diagnostics.provisionalLineupFound, false);
  } finally {
    fixture.database.close();
  }
});

test("lineup_finalizeは選手ID未解決の古い名前だけでfinalizeしない", async () => {
  const fixture = createFixture(buildLineup({ unresolved: true }));
  try {
    const result = await selectV3LineupFinalizeCandidate(fixture.db, {
      internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "V3_LINEUP_PLAYER_RESOLUTION_FAILED");
    assert.equal(result.diagnostics.provisionalLineupFound, false);
  } finally {
    fixture.database.close();
  }
});
