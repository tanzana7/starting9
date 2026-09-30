import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  buildLineupShadowObservation,
  compareShadowLineupToManual,
  isLineupShadowDue,
  isLineupShadowEnabled,
  isShadowLineupRevision,
  nextLineupShadowRetryAt,
  shouldRetryLineupShadow
} from "../backend/automation-v3/lineup-shadow-service.js";
import { isAutoFinalEligible } from "../backend/automation-v3/lineup-candidate-service.js";
import { readV3LineupDataHealth } from "../backend/automation-v3/orchestrator.js";
import {
  hasV3LineupShadowWindowCandidate,
  listV3LineupShadowCandidates
} from "../backend/automation-v3/repository.js";

const NOW = new Date("2026-09-28T09:00:00.000Z");
const LINEUP = Array.from({ length: 9 }, (_, index) => ({
  battingOrder: index + 1,
  playerId: `F-${index + 1}`,
  playerName: `player-${index + 1}`,
  position: index === 8 ? "指" : "遊"
}));

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params)
          };
        }
      };
    }
  };
}

test("production shadow flag is explicit and auto-final remains fail-closed", () => {
  assert.equal(isLineupShadowEnabled({ ENABLE_LINEUP_SHADOW: "true" }), true);
  assert.equal(isLineupShadowEnabled({ ENABLE_LINEUP_SHADOW: "false" }), false);
  const candidate = { source: "official", status: "lineup_announced" };
  const verification = { status: "verified" };
  assert.equal(isAutoFinalEligible({ candidate, verification, autoFinalEnabled: true }).eligible, true);
  assert.equal(isAutoFinalEligible({ candidate, verification, environment: "production", autoFinalEnabled: true }).eligible, false);
  assert.equal(isAutoFinalEligible({ candidate, verification, environment: "production", autoFinalEnabled: true }).reason, "PRODUCTION_AUTO_FINAL_DISABLED");
});

test("shadow候補は時間窓外で詳細行を返さず、窓内では次の対象を返す", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_game_url TEXT,
      game_status TEXT, is_active INTEGER, deleted_at TEXT
    );
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT, is_final INTEGER
    );
  `);
  database.prepare("INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, NULL)")
    .run("shadow-game", "2026-09-28", "2026-09-28T10:00:00.000Z", "fighters", "eagles", "f-e-1", null);
  try {
    const db = d1(database);
    assert.equal(await hasV3LineupShadowWindowCandidate(db, new Date("2026-09-28T00:00:00.000Z")), false);
    assert.deepEqual(await listV3LineupShadowCandidates(db, new Date("2026-09-28T00:00:00.000Z"), { limit: 4 }), []);
    assert.equal(await hasV3LineupShadowWindowCandidate(db, new Date("2026-09-28T09:00:00.000Z")), true);
    const candidates = await listV3LineupShadowCandidates(db, new Date("2026-09-28T09:00:00.000Z"), { limit: 4 });
    assert.deepEqual(candidates.map((game) => game.internalGameId), ["shadow-game"]);
    database.prepare("INSERT INTO game_lineup_revisions VALUES ('shadow-game', 1)").run();
    assert.equal(await hasV3LineupShadowWindowCandidate(db, new Date("2026-09-28T09:00:00.000Z")), false);
  } finally {
    database.close();
  }
});

test("shadow fetch is limited to the pregame and late recovery window", () => {
  const target = { startAt: "2026-09-28T10:00:00.000Z" };
  assert.equal(isLineupShadowDue(target, "2026-09-28T07:59:59.999Z").due, false);
  assert.equal(isLineupShadowDue(target, "2026-09-28T08:00:00.000Z").due, true);
  assert.equal(isLineupShadowDue(target, "2026-09-29T10:00:00.000Z").due, true);
  assert.equal(isLineupShadowDue(target, "2026-09-29T10:00:00.001Z").due, false);
});

test("shadow retry stops for terminal observations and is bounded for waiting", () => {
  const next = nextLineupShadowRetryAt({ status: "waiting" }, NOW);
  assert.equal(next, "2026-09-28T09:05:00.000Z");
  assert.equal(shouldRetryLineupShadow({ status: "waiting", nextRetryAt: next }, NOW), false);
  assert.equal(shouldRetryLineupShadow({ status: "waiting", nextRetryAt: "2026-09-28T08:59:00.000Z" }, NOW), true);
  assert.equal(nextLineupShadowRetryAt({ status: "verified" }, NOW), null);
  assert.equal(shouldRetryLineupShadow({ status: "manual_final_exists" }, NOW), false);
});

test("shadow/manual comparison reports exact, order, player, and position differences", () => {
  assert.deepEqual(compareShadowLineupToManual(LINEUP, LINEUP), {
    exactMatch: true,
    playerMatch: true,
    battingOrderMatch: true,
    positionMatch: true,
    differences: [],
    differenceCount: 0,
    shadowCount: 9,
    manualCount: 9
  });
  const changed = LINEUP.map((row) => ({ ...row }));
  changed[0].playerId = "F-different";
  changed[0].playerName = "different";
  changed[1].position = "一";
  const comparison = compareShadowLineupToManual(changed, LINEUP);
  assert.equal(comparison.exactMatch, false);
  assert.equal(comparison.differences.length, 2);
  assert.equal(comparison.differences[0].battingOrder, 1);
  assert.equal(comparison.differences[1].battingOrder, 2);
});

test("shadow observation is compact and carries retry/validation diagnostics", () => {
  assert.deepEqual(buildLineupShadowObservation({
    status: "waiting",
    source: "official",
    playerCount: 0,
    validationStatus: "LINEUP_NOT_PUBLISHED",
    reasonCode: "LINEUP_NOT_PUBLISHED",
    nextRetryAt: "2026-09-28T09:05:00.000Z"
  }), {
    status: "waiting",
    source: "official",
    fetchedAt: null,
    playerCount: 0,
    validationStatus: "LINEUP_NOT_PUBLISHED",
    reasonCode: "LINEUP_NOT_PUBLISHED",
    nextRetryAt: "2026-09-28T09:05:00.000Z",
    comparison: null
  });
});

test("shadow revision marker is explicit and formal revisions remain distinguishable", () => {
  assert.equal(isShadowLineupRevision({ validation_json: JSON.stringify({ shadowMode: true }) }), true);
  assert.equal(isShadowLineupRevision({ validation_json: JSON.stringify({ shadowMode: false }) }), false);
  assert.equal(isShadowLineupRevision({ validation_json: "not-json" }), false);
});

test("shadow candidate does not make formal lineup health ready", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT, version INTEGER, actual_lineup_json TEXT,
      is_final INTEGER, validation_json TEXT
    );
    CREATE TABLE game_lineups (internal_game_id TEXT, actual_lineup_json TEXT, final_lineup_revision_id TEXT);
  `);
  database.prepare("INSERT INTO game_lineup_revisions VALUES (?, 1, ?, 0, ?)").run(
    "game-1", JSON.stringify(LINEUP), JSON.stringify({ shadowMode: true })
  );
  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return { bind(...values) {
        return {
          all: async () => ({ results: statement.all(...values) }),
          first: async () => statement.get(...values)
        };
      } };
    }
  };
  const health = await readV3LineupDataHealth(db, "game-1");
  assert.equal(health.candidateCount, 0);
  assert.equal(health.candidateValid, false);
  assert.equal(health.ready, false);
  database.close();
});
