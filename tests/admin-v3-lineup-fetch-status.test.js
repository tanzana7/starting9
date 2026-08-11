import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const start = client.indexOf("const TODAY_OPS_STATUS_LABELS");
const end = client.indexOf("function renderGameSummary", start);
const listStart = client.indexOf("function normalizeV3List");
const listEnd = client.indexOf("function v3StorageGet", listStart);
const context = {
  statusLabel(status) {
    return ({ pending: "予定", claimed: "実行中", retry_wait: "retry_wait", completed: "完了", failed: "失敗" })[String(status || "")] || "待機中";
  },
  formatV3Jst(value) { return String(value || "-"); },
  escapeV3(value) { return String(value ?? ""); },
  filteredV3Games(games, filter) { return filter === "today" ? games : games; },
  v3JstDate() { return "2026-08-08"; },
  gameDateForFilter(game) { return game.gameDate; },
  nextV3ActionText() { return "次の処理"; }
};
vm.runInNewContext(`${client.slice(listStart, listEnd)}; ${client.slice(start, end)}; globalThis.lineupDisplayState = lineupDisplayState; globalThis.todayOpsStep = todayOpsStep;`, context);

const now = new Date("2026-08-08T05:23:00.000Z");
const lineupSlots = ["2026-08-08T05:10:00.000Z", "2026-08-08T05:20:00.000Z", "2026-08-08T05:30:00.000Z", "2026-08-08T05:40:00.000Z", "2026-08-08T05:50:00.000Z", "2026-08-08T06:00:00.000Z"];

function game(jobs = [], overrides = {}) {
  return {
    gameDate: "2026-08-08",
    startAt: "2026-08-08T06:00:00.000Z",
    state: { state: "prediction_closed" },
    schedule: { lineupPollingSlots: lineupSlots },
    jobs,
    ...overrides
  };
}

test("未発表retry_waitはWAITINGで次回14:30を示す", () => {
  const result = context.lineupDisplayState(game([{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "LINEUP_NOT_ANNOUNCED" }]), now);
  assert.equal(result.status, "waiting");
  assert.equal(result.label, "スタメン未発表");
  assert.equal(result.nextCheckAt, "2026-08-08T05:30:00.000Z");
  assert.match(result.detail, /LINEUP_NOT_ANNOUNCED/);
  assert.equal(context.todayOpsStep(game([{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "LINEUP_NOT_ANNOUNCED" }]), "lineup", now), "waiting");
});

test("HTTP失敗retry_waitは一時取得失敗、parser失敗とV3_JOB_FAILEDはATTENTION", () => {
  const temporary = context.lineupDisplayState(game([{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "HTTP_FETCH_FAILED" }]), now);
  assert.equal(temporary.status, "waiting");
  assert.equal(temporary.label, "一時取得失敗");
  const parser = context.lineupDisplayState(game([{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "LINEUP_PARSE_FAILED" }]), now);
  assert.equal(parser.status, "attention");
  assert.equal(parser.label, "スタメン取得異常");
  const system = context.lineupDisplayState(game([{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "V3_JOB_FAILED" }]), now);
  assert.equal(system.status, "attention");
  assert.equal(system.label, "システム異常");
});

test("UNEXPECTED_EXCEPTIONは例外診断と次回確認slotを表示する", () => {
  const result = context.lineupDisplayState(game([{
    job_type: "lineup_fetch",
    status: "retry_wait",
    failure_code: "UNEXPECTED_EXCEPTION",
    failure_message: 'D1_ERROR [diagnostics={"exceptionName":"Error","exceptionMessage":"no such column: id","executorStage":"capture_official_lineup","selectedSlot":"2026-08-08T05:40:00.000Z"}]'
  }]), now);
  assert.equal(result.status, "attention");
  assert.equal(result.label, "システム異常");
  assert.match(result.detail, /exceptionName: Error/);
  assert.match(result.detail, /no such column: id/);
  assert.match(result.detail, /capture_official_lineup/);
  assert.equal(result.nextCheckAt, "2026-08-08T05:30:00.000Z");
});

test("全polling slot経過後にlineupがなければATTENTION", () => {
  const result = context.lineupDisplayState(game(), new Date("2026-08-08T06:01:00.000Z"));
  assert.equal(result.status, "attention");
  assert.match(result.detail, /全polling slot経過後/);
});

test("Today Opsはlineup reasonと次回確認を同じ表示契約へ渡す", () => {
  assert.match(client, /lineupDetail/);
  assert.match(client, /renderTodayOpsStep\("スタメン", steps\.lineup, steps\.lineupDetail\)/);
  assert.match(client, /次回確認待ち/);
  assert.match(page, /admin-v3\.css\?v=ranking-reset-controls-1/);
  assert.match(page, /admin-v3\.js\?v=ranking-reset-controls-1/);
});
