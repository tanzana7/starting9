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
const helperEnd = client.indexOf("async function loadV3JobDetail", helperStart);
const listStart = client.indexOf("function normalizeV3List");
const listEnd = client.indexOf("function v3StorageGet", listStart);
const context = { formatV3Jst: (value) => String(value || "") };
vm.runInNewContext(`${client.slice(listStart, listEnd)}; ${client.slice(helperStart, helperEnd)}; globalThis.rosterDisplaySlots = rosterDisplaySlots; globalThis.rosterDisplayState = rosterDisplayState;`, context);

function game(overrides = {}) {
  return {
    startAt: "2026-08-08T06:00:00.000Z",
    rosterDiagnostics: { rosterSnapshotExists: false },
    jobs: [],
    ...overrides
  };
}

test("fresh snapshotだけをToday Opsと個別詳細で完了扱いにする", () => {
  const target = game({ rosterDiagnostics: { rosterSnapshotExists: true, rosterSnapshotStatus: "captured", isSnapshotFresh: true, noticeState: "ROSTER_NO_CHANGES" } });
  assert.equal(context.rosterDisplayState(target).status, "ok");
  assert.equal(context.rosterDisplayState(target).status, "ok");
  assert.match(client, /公式公示を確認しました。変更はありません。/);
  assert.match(fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8"), /NPB識別job:/);
  assert.match(fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8"), /game code:/);
});

test("stale snapshotは取得済みと表示せず、未実行jobがあれば待機を優先する", () => {
  const stale = game({ rosterDiagnostics: { rosterSnapshotExists: false, isSnapshotStale: true, staleReason: "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE" } });
  assert.equal(context.rosterDisplayState(stale).status, "attention");
  assert.equal(context.rosterDisplayState(stale).status, "attention");
  const pending = game({ rosterDiagnostics: stale.rosterDiagnostics, jobs: [{ job_type: "roster_fetch", status: "pending" }] });
  assert.equal(context.rosterDisplayState(pending).status, "waiting");
});

test("slot前のmissing snapshotはToday Opsと個別詳細で取得予定として待機する", () => {
  const target = game({ rosterDiagnostics: {
    rosterSnapshotExists: false,
    isSnapshotStale: true,
    staleReason: "ROSTER_SNAPSHOT_MISSING",
    severity: "WAITING",
    reasonCode: "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE",
    label: "取得予定",
    nextCheckAt: "2026-08-09T04:00:00.000Z"
  } });
  const state = context.rosterDisplayState(target);
  assert.equal(state.status, "waiting");
  assert.equal(context.rosterDisplayState(target).status, "waiting");
  assert.match(state.detail, /ROSTER_SNAPSHOT_MISSING_BEFORE_DUE/);
  assert.match(state.detail, /現時点では当日公示未確認/);
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
  assert.match(page, /admin-v3\.css\?v=admin-v3-v3-recovery-operations-1/);
  assert.match(page, /admin-v3\.js\?v=admin-v3-v3-recovery-operations-1/);
});
