import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  getManualLineupPlayerCatalog,
  getManualLineupRevisionCancelDecision
} from "../auth-worker.js";
import {
  normalizeManualRosterPlayerName,
  prioritizeManualRosterCatalog
} from "../backend/automation-v3/manual-roster-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadRenderer(relativePath, global = {}) {
  const window = { Starting9AdminV3: {}, Starting9Public: {}, ...global };
  vm.runInNewContext(fs.readFileSync(path.join(root, relativePath), "utf8"), { window });
  return window.Starting9AdminV3;
}

test("manual roster未保存時はFighters野手を静的初期候補としてactive表示する", () => {
  const catalog = getManualLineupPlayerCatalog({ manualRoster: { schemaAvailable: true, source: "static-fallback", entries: [] } });
  const active = catalog.filter((player) => player.manualRosterActive === true);
  assert.ok(active.some((player) => player.playerId === "F-3" && player.category === "捕手"));
  assert.ok(active.some((player) => player.playerId === "F-43" && player.category === "内野手"));
  assert.ok(active.some((player) => player.playerId === "F-53" && player.category === "外野手"));
  assert.ok(active.some((player) => player.playerId === "F-120"));
  assert.equal(catalog.find((player) => player.playerId === "F-12").manualRosterActive, false);
  assert.equal(catalog.find((player) => player.playerId === "F-18").manualRosterActive, false);
});

test("manual roster保存済み行はstatic fallbackに戻らず、名前fallbackも背番号表示を吸収する", () => {
  const catalog = [{ playerId: "F-3", playerName: "郡司裕也", uniformNumber: "3" }, { playerId: "F-43", playerName: "水野達稀", uniformNumber: "43" }];
  const prioritized = prioritizeManualRosterCatalog(catalog, [{ playerName: "[3] 郡司 裕也", status: "inactive" }]);
  assert.equal(normalizeManualRosterPlayerName("[3] 郡司　裕也"), "郡司裕也");
  assert.equal(prioritized.find((player) => player.playerId === "F-3").manualRosterActive, false);
  assert.equal(prioritized.find((player) => player.playerId === "F-43").manualRosterActive, false);
});

test("manual roster rendererはFighters全体・source・人数・カテゴリを表示し、lineupとは独立と明示する", () => {
  const source = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");
  assert.match(source, /Fighters-wide/);
  assert.match(source, /表示元:/);
  assert.match(source, /active:/);
  assert.match(source, /inactive:/);
  assert.match(source, /カテゴリ情報なし|category/);
  assert.match(source, /manual roster更新はmanual lineupを変更しません/);
});

test("manual lineup rendererは入力理由欄を持たず、roster外を警告だけにする", () => {
  const source = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
  assert.doesNotMatch(source, /data-v3-manual-lineup-reason/);
  assert.match(source, /ロースター外（確認要）/);
  assert.match(source, /manual revisionを取消/);
  assert.match(source, /data-v3-manual-lineup-revision-cancel/);
});

test("revision取消はmanualの未来scheduledだけを許可し、自動・採点済み・紐付け不明を拒否する", () => {
  const base = {
    gameDate: "2026-09-08",
    workflowState: "scheduled",
    revision: { revision_id: "game:2", game_id: "game", version: 2, source: "manual-revision", is_current: 1, is_final: 1, lineup_fingerprint: "fp" },
    now: new Date("2026-09-04T00:00:00.000Z")
  };
  assert.equal(getManualLineupRevisionCancelDecision(base).allowed, true);
  assert.equal(getManualLineupRevisionCancelDecision({ ...base, revision: { ...base.revision, source: "npb-auto" } }).allowed, false);
  assert.equal(getManualLineupRevisionCancelDecision({ ...base, canonical: { scoring_status: "scored", final_lineup_revision_id: "game:2" } }).allowed, false);
  assert.equal(getManualLineupRevisionCancelDecision({ ...base, canonical: { scoring_status: "pending" } }).allowed, false);
});

test("revision取消はlegacy game-codeとinternal game-idのcanonical aliasを同一revisionとして扱う", () => {
  const decision = getManualLineupRevisionCancelDecision({
    gameDate: "2026-09-08",
    workflowState: "scheduled",
    revision: {
      revision_id: "game-code:2",
      game_id: "game-code",
      internal_game_id: "11111111-1111-4111-8111-111111111111",
      version: 2,
      source: "manual-revision",
      is_current: 1,
      is_final: 1,
      lineup_fingerprint: "fp"
    },
    canonical: {
      scoring_status: "pending",
      final_lineup_revision_id: "11111111-1111-4111-8111-111111111111:2"
    },
    now: new Date("2026-09-04T00:00:00.000Z")
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.canonicalLinked, true);
});

test("manual lineup payloadはreasonなしで構成し、cancel API endpointが定義されている", () => {
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "frontend", "admin-v3", "api-client.js"), "utf8");
  const coordinator = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
  assert.match(admin, /function manualLineupPayload/);
  const payloadSource = admin.slice(admin.indexOf("function manualLineupPayload"), admin.indexOf("async function saveV3ManualLineup"));
  assert.doesNotMatch(payloadSource, /reason/);
  assert.match(api, /cancelManualLineupRevision/);
  assert.match(coordinator, /data-v3-manual-lineup-revision-cancel/);
});
