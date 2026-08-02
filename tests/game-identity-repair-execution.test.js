import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyGameIdentityRepairPlan, canResumeFailedGameIdentityRepair, collectGameIdentityRepairExecutionState } from "../auth-worker.js";

const targetInternalGameId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-08-02T00:00:00.000Z");
const plan = {
  repairId: "gir-test-repair",
  planHash: "test-plan-hash",
  generatedAt: now.toISOString(),
  classification: "SAFE_CREATE_INTERNAL_GAME",
  scheduleGameId: "2026-08-01-fighters-marines-1400",
  targetInternalGameId: "",
  createInternalGame: true,
  identifiersToInsert: [{ provider: "starting9", identifierType: "legacy_compact_game_id", identifierValue: "2026-08-01-f-m-15" }],
  tableRowsToUpdate: [{ table: "predictions", legacyGameId: "2026-08-01-f-m-15", expectedCount: 1 }]
};

function createDb({ failAt = "", predictionCount = 1 } = {}) {
  const control = { failAt };
  const state = {
    schedule: {
      game_id: plan.scheduleGameId,
      internal_game_id: "",
      game_date: "2026-08-01",
      start_at: "2026-08-01T05:00:00.000Z",
      home_team: "fighters",
      away_team: "marines",
      game_status: "scheduled"
    },
    games: new Map(),
    identifiers: new Map(),
    predictionInternalGameId: "",
    legacyRows: {
      game_pregame_automation: null,
      game_roster_snapshots: null
    },
    history: []
  };
  const keyForIdentifier = (provider, type, value) => `${provider}|${type}|${value}`;
  const db = {
    prepare(sql) {
      let bindings = [];
      const statement = {
        bind(...values) {
          bindings = values;
          return statement;
        },
        async first() {
          if (sql.includes("FROM detected_game_schedule")) return state.schedule;
          if (sql.includes("FROM games WHERE internal_game_id")) return state.games.get(bindings[0]) || null;
          if (sql.includes("FROM game_identifiers")) {
            return state.identifiers.get(keyForIdentifier(bindings[0], bindings[1], bindings[2])) || null;
          }
          if (sql.includes("FROM predictions")) {
            const linkedToTarget = state.predictionInternalGameId === bindings[0] ? predictionCount : 0;
            return { row_count: predictionCount, linked_to_target_count: linkedToTarget, unlinked_count: linkedToTarget ? 0 : predictionCount };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM detected_game_schedule")) return { results: [state.schedule] };
          if (sql.includes("FROM game_identifiers")) {
            const row = state.identifiers.get(keyForIdentifier(bindings[0], bindings[1], bindings[2]));
            return { results: row ? [row] : [] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO games")) {
            if (control.failAt === "game_create") throw new Error("game create failed");
            state.games.set(bindings[0], {
              internal_game_id: bindings[0], game_date: bindings[1], start_time: bindings[2], home_team: bindings[3], away_team: bindings[4]
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO game_identifiers")) {
            if (control.failAt === "identifier_register") throw new Error("identifier insert failed");
            state.identifiers.set(keyForIdentifier(bindings[1], bindings[2], bindings[3]), { internal_game_id: bindings[0] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE detected_game_schedule")) {
            if (control.failAt === "schedule_link") throw new Error("schedule update failed");
            state.schedule.internal_game_id = bindings[0];
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE predictions")) {
            if (control.failAt === "legacy_row_link") throw new Error("prediction update failed");
            if (!state.predictionInternalGameId && predictionCount > 0) state.predictionInternalGameId = bindings[0];
            return { meta: { changes: predictionCount } };
          }
          for (const table of ["game_pregame_automation", "game_roster_snapshots"]) {
            if (sql.includes(`UPDATE ${table}`)) {
              const row = state.legacyRows[table];
              if (row && row.game_id === bindings[1] && !row.internal_game_id) {
                row.internal_game_id = bindings[0];
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
          }
          if (sql.includes("INSERT INTO game_identity_repair_plans")) {
            if (control.failAt === "history_complete") throw new Error("history write failed");
            state.history.push({ status: bindings[1], targetInternalGameId: bindings[3] });
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
      return statement;
    }
  };
  return { db, state, control };
}

async function apply(db, overrides = {}) {
  return await applyGameIdentityRepairPlan(db, { ...plan, ...overrides }, "admin-1", { targetInternalGameId, now });
}

test("games作成後のidentifier失敗は段階を保持し、同じUUIDで再実行してもgamesを重複作成しない", async () => {
  const { db, state, control } = createDb({ failAt: "identifier_register" });
  await assert.rejects(() => apply(db), (error) => error.repairStage === "identifier_register");
  assert.equal(state.games.size, 1);
  control.failAt = "";
  const retry = await apply(db);
  assert.equal(retry.targetInternalGameId, targetInternalGameId);
  assert.equal(state.games.size, 1);
});

test("identifier追加後にschedule更新が失敗しても、失敗段階と部分状態を識別できる", async () => {
  const { db, state } = createDb({ failAt: "schedule_link" });
  await assert.rejects(() => apply(db), (error) => error.repairStage === "schedule_link");
  assert.equal(state.identifiers.size, 1);
  assert.equal(state.schedule.internal_game_id, "");
});

test("履歴保存失敗はhistory_completeとして伝播し、HTTP層でJSONエラーへ変換できる", async () => {
  const { db, state } = createDb({ failAt: "history_complete" });
  await assert.rejects(() => apply(db), (error) => error.repairStage === "history_complete");
  assert.equal(state.schedule.internal_game_id, targetInternalGameId);
  assert.equal(state.predictionInternalGameId, targetInternalGameId);
});

test("expectedCountが0の関連テーブル更新は正常完了する", async () => {
  const { db, state } = createDb({ predictionCount: 0 });
  const result = await apply(db, { tableRowsToUpdate: [{ table: "predictions", legacyGameId: "2026-08-01-f-m-15", expectedCount: 0 }] });
  assert.equal(result.status, "completed");
  assert.equal(state.history.at(-1).status, "completed");
});

test("既存UUIDへの8月4日row-only修復はpregameとrosterのinternal_game_idだけを更新する", async () => {
  const { db, state } = createDb();
  const compactGameId = "2026-08-04-h-f-15";
  const scheduleGameId = "2026-08-04-hawks-fighters-1500";
  state.schedule = {
    game_id: scheduleGameId,
    internal_game_id: targetInternalGameId,
    game_date: "2026-08-04",
    start_at: "2026-08-04T06:00:00.000Z",
    home_team: "hawks",
    away_team: "fighters",
    game_code: "h-f-15",
    game_status: "scheduled"
  };
  state.games.set(targetInternalGameId, {
    internal_game_id: targetInternalGameId,
    game_date: "2026-08-04",
    start_time: "2026-08-04T06:00:00.000Z",
    home_team: "hawks",
    away_team: "fighters"
  });
  state.legacyRows.game_pregame_automation = { game_id: compactGameId, internal_game_id: "", status: "pending" };
  state.legacyRows.game_roster_snapshots = { game_id: compactGameId, internal_game_id: "", roster_json: "preserved" };
  const rowOnlyPlan = {
    ...plan,
    classification: "SAFE_AUTO_LINK",
    scheduleGameId,
    targetInternalGameId,
    createInternalGame: false,
    identifiersToInsert: [],
    tableRowsToUpdate: [
      { table: "game_pregame_automation", legacyGameId: compactGameId, expectedCount: 1 },
      { table: "game_roster_snapshots", legacyGameId: compactGameId, expectedCount: 1 }
    ]
  };
  const result = await applyGameIdentityRepairPlan(db, rowOnlyPlan, "admin-1", { targetInternalGameId, now });
  assert.equal(result.status, "completed");
  assert.equal(state.legacyRows.game_pregame_automation.internal_game_id, targetInternalGameId);
  assert.equal(state.legacyRows.game_roster_snapshots.internal_game_id, targetInternalGameId);
  assert.equal(state.legacyRows.game_pregame_automation.game_id, compactGameId);
  assert.equal(state.legacyRows.game_pregame_automation.status, "pending");
  assert.equal(state.legacyRows.game_roster_snapshots.game_id, compactGameId);
  assert.equal(state.legacyRows.game_roster_snapshots.roster_json, "preserved");
  assert.equal(state.games.size, 1);
  assert.equal(state.identifiers.size, 0);
});

async function audit(db, overrides = {}) {
  return await collectGameIdentityRepairExecutionState(db, {
    repair_id: plan.repairId,
    status: "failed",
    plan_json: JSON.stringify(plan),
    plan_hash: plan.planHash,
    rollback_json: JSON.stringify({ failure: { stage: "plan_read", errorCode: "GAME_IDENTITY_REPAIR_PLAN_HASH_MISMATCH" } }),
    target_internal_game_id: targetInternalGameId,
    ...overrides
  });
}

test("書き込みゼロのfailed履歴はpartial writeとして扱わない", async () => {
  const { db } = createDb();
  const result = await audit(db);
  assert.equal(result.observed.targetGameExists, false);
  assert.equal(result.observed.partialWriteDetected, false);
  assert.equal(result.observed.rollbackRecordedChanges, false);
});

test("games、identifier、scheduleのいずれかが書き込まれた場合だけpartial writeとして扱う", async () => {
  const createdGame = createDb();
  createdGame.state.games.set(targetInternalGameId, { internal_game_id: targetInternalGameId });
  assert.equal((await audit(createdGame.db)).observed.partialWriteDetected, true);

  const registeredIdentifier = createDb();
  registeredIdentifier.state.identifiers.set("starting9|legacy_compact_game_id|2026-08-01-f-m-15", { internal_game_id: targetInternalGameId });
  assert.equal((await audit(registeredIdentifier.db)).observed.partialWriteDetected, true);

  const linkedSchedule = createDb();
  linkedSchedule.state.schedule.internal_game_id = targetInternalGameId;
  assert.equal((await audit(linkedSchedule.db)).observed.partialWriteDetected, true);
});

test("部分書き込みのないfailed履歴は、最新dry-runのcanonical hashが一致する場合だけ再実行できる", () => {
  const base = {
    status: "failed",
    partialWriteDetected: false,
    expectedPlanHash: "current-canonical-hash",
    currentPlanHash: "current-canonical-hash",
    canonicalStoredPlanHash: "current-canonical-hash"
  };
  assert.equal(canResumeFailedGameIdentityRepair(base), true);
  assert.equal(canResumeFailedGameIdentityRepair({ ...base, partialWriteDetected: true }), false);
  assert.equal(canResumeFailedGameIdentityRepair({ ...base, expectedPlanHash: "stale-hash" }), false);
  assert.equal(canResumeFailedGameIdentityRepair({ ...base, canonicalStoredPlanHash: "changed-plan" }), false);
  assert.equal(canResumeFailedGameIdentityRepair({ ...base, status: "completed" }), false);
});

test("修復POSTは最上位catch、段階別記録、読み取り専用の実行監査ルートを持つ", async () => {
  const source = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
  assert.match(source, /parseGameIdentityRepairAuditRoute/);
  assert.match(source, /handleAdminGameIdentityRepairExecutionAudit/);
  assert.match(source, /GAME_IDENTITY_REPAIR_UNEXPECTED_ERROR/);
  assert.match(source, /GAME_IDENTITY_REPAIR_INTERRUPTED/);
  assert.match(source, /EXPECTED_HASH_DIFFERS_FROM_CURRENT_PLAN/);
  assert.match(source, /STORED_PLAN_DIFFERS_FROM_CURRENT_PLAN/);
  assert.match(source, /expectedPlanHash/);
  assert.match(source, /currentPlanHash/);
  assert.match(source, /storedPlanHash/);
  assert.match(source, /mismatchReason/);
  assert.match(source, /existing\.status === "failed"/);
  assert.match(source, /canResumeFailedGameIdentityRepair/);
  assert.match(source, /!canResumeFailedWithoutPartialWrite && expectedPlanHash !== storedPlanHash/);
  assert.match(source, /plan\.createInternalGame && !state\.observed\.partialWriteDetected/);
  assert.match(source, /status: "executing"/);
  assert.match(source, /const errorStage = error\?\.repairStage \|\| stage/);
  assert.match(source, /isGameIdentityRepairConflict\(error\) \? 409 : 500/);
});
