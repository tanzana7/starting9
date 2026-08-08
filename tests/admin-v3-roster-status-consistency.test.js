import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const helperStart = client.indexOf("function rosterDisplaySlots");
const helperEnd = client.indexOf("function buildTodayOpsModel", helperStart);
const context = {};
vm.runInNewContext(`${client.slice(helperStart, helperEnd)}; globalThis.rosterDisplaySlots = rosterDisplaySlots; globalThis.rosterDisplayState = rosterDisplayState; globalThis.todayOpsStep = todayOpsStep;`, context);

function game(overrides = {}) {
  return {
    startAt: "2026-08-08T06:00:00.000Z",
    rosterDiagnostics: { rosterSnapshotExists: false },
    jobs: [],
    ...overrides
  };
}

test("snapshot capturedはjob未生成でもToday Opsと個別詳細を完了扱いにする", () => {
  const target = game({ rosterDiagnostics: { rosterSnapshotExists: true, rosterSnapshotStatus: "captured" } });
  assert.equal(context.rosterDisplayState(target).status, "ok");
  assert.equal(context.todayOpsStep(target, "roster"), "ok");
  assert.match(client, /snapshot取得済みのため追加job不要/);
  assert.match(client, /NPB識別job:/);
  assert.match(client, /game code:/);
});

test("failedとretry_waitはsnapshotより優先して注意・待機表示にする", () => {
  const snapshot = { rosterSnapshotExists: true };
  assert.equal(context.rosterDisplayState(game({ rosterDiagnostics: snapshot, jobs: [{ job_type: "roster_fetch", status: "failed", failure_code: "ROSTER_FETCH_FAILED" }] })).status, "attention");
  assert.equal(context.rosterDisplayState(game({ rosterDiagnostics: snapshot, jobs: [{ job_type: "roster_fetch", status: "retry_wait" }] })).status, "waiting");
});

test("15時開始試合の表示slotから開始後の固定slotを除外し、18時開始では維持する", () => {
  const slots = [
    "2026-08-08T04:00:00.000Z",
    "2026-08-08T04:10:00.000Z",
    "2026-08-08T07:02:00.000Z",
    "2026-08-08T07:10:00.000Z"
  ];
  assert.deepEqual(context.rosterDisplaySlots(game({ startAt: "2026-08-08T06:00:00.000Z" }), slots), slots.slice(0, 2));
  assert.deepEqual(context.rosterDisplaySlots(game({ startAt: "2026-08-08T09:00:00.000Z" }), slots), slots);
});

test("admin-v3のcache busterはロースター状態表示版へ更新される", () => {
  assert.match(page, /admin-v3\.css\?v=automation-v3-8-lineup-status/);
  assert.match(page, /admin-v3\.js\?v=automation-v3-8-lineup-status/);
});
