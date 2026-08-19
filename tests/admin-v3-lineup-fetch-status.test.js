import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const classifyStart = client.indexOf("function lineupReasonCode");
const lineupStart = client.indexOf("function lineupDisplayState", classifyStart);
const lineupEnd = client.indexOf("async function loadV3JobDetail", lineupStart);
const context = {
  statusLabel(status) {
    return ({ pending: "予定", claimed: "実行中", retry_wait: "retry_wait", completed: "完了", failed: "失敗" })[String(status || "")] || "待機中";
  },
  formatV3Jst(value) { return String(value || "-"); },
  escapeV3(value) { return String(value ?? ""); },
  v3ListItems(value, key = "items") { return Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []; },
  normalizedV3PhaseState() { return null; },
  formatV3Jst(value) { return String(value || "-"); }
};
vm.runInNewContext(`${client.slice(classifyStart, lineupStart)}; ${client.slice(lineupStart, lineupEnd)}; globalThis.lineupDisplayState = lineupDisplayState;`, context);

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
  const diagnostics = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
  assert.match(diagnostics, /lineupDetail/);
  assert.match(diagnostics, /renderStep\("スタメン", steps\.lineup, steps\.lineupDetail\)/);
  assert.match(client, /次回確認待ち/);
  assert.match(page, /admin-v3\.css\?v=admin-v3-deadline-state-gate-diagnostics-1/);
  assert.match(page, /admin-v3\.js\?v=admin-v3-deadline-state-gate-diagnostics-1/);
});
