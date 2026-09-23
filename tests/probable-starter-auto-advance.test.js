import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

function loadSelector() {
  const start = script.indexOf("function getProbableStarterActualStartAt");
  const end = script.indexOf("function getPreferredProbableStarterGame", start);
  const context = {
    Date,
    getScheduleDate: (game) => game.date,
    getScheduleStartTime: (game) => game.startTime,
    getScheduleSortValue: (game) => `${game.date}T${game.startTime}`,
    parseJstScheduleDateTime: (game) => new Date(`${game.date}T${game.startTime}:00+09:00`),
    isNormalManagedSchedule: (game) => game.isTestGame !== true,
    isScheduleGameUnavailable: (game) => game.unavailable === true
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  return context.selectProbableStarterGame;
}

const game = (internalGameId, date, startTime, extra = {}) => ({
  internalGameId,
  canonical: true,
  date,
  startTime,
  homeTeam: "fighters",
  awayTeam: "buffaloes",
  ...extra
});

test("予告先発はJST予定開始の1分前・同時刻・1分後で次戦へ切り替わる", () => {
  const select = loadSelector();
  const games = [
    game("today", "2026-09-20", "14:00"),
    game("tomorrow", "2026-09-21", "18:00")
  ];
  assert.equal(select(games, new Date("2026-09-20T04:59:00Z"))?.internalGameId, "today");
  assert.equal(select(games, new Date("2026-09-20T05:00:00Z"))?.internalGameId, "tomorrow");
  assert.equal(select(games, new Date("2026-09-20T05:01:00Z"))?.internalGameId, "tomorrow");
});

test("実開始時刻がある場合は予定時刻より優先し、日付またぎも扱う", () => {
  const select = loadSelector();
  const games = [
    game("delayed", "2026-09-20", "14:00", { actualStartAt: "2026-09-20T06:30:00Z" }),
    game("next-day", "2026-09-21", "00:10")
  ];
  assert.equal(select(games, new Date("2026-09-20T05:30:00Z"))?.internalGameId, "delayed");
  assert.equal(select(games, new Date("2026-09-20T06:30:00Z"))?.internalGameId, "next-day");
});

test("次戦がない場合はnullを返し、中止・対象外試合を選ばない", () => {
  const select = loadSelector();
  assert.equal(select([game("ended", "2026-09-20", "14:00")], new Date("2026-09-20T06:00:00Z")), null);
  assert.equal(select([
    game("cancelled", "2026-09-20", "18:00", { unavailable: true }),
    game("future", "2026-09-21", "18:00")
  ], new Date("2026-09-20T06:00:00Z"))?.internalGameId, "future");
});

test("予告先発の自動切替は予想対象・開始締切の処理と分離し、30秒tickerで再評価する", () => {
  const initializer = script.slice(script.indexOf("async function initializeProbableStarter"), script.indexOf("async function refreshPredictionTarget"));
  assert.match(initializer, /getPreferredProbableStarterGame/);
  assert.doesNotMatch(initializer, /setPublicCurrentGame/);
  assert.doesNotMatch(initializer, /state\.predictionTargetGame =/);
  assert.match(script, /refreshProbableStarterTarget\(\);/);
  assert.match(script, /PREDICTION_DEADLINE_REFRESH_MS = 30 \* 1000/);
  assert.match(script, /PROBABLE_STARTER_REFRESH_INTERVAL_MS = 60 \* 1000/);
  assert.match(script, /state\.probableStarter\.status\);[\s\S]*?fetchStoredProbableStarter\(\)/);
  assert.match(script, /state\.probableStarter\.matchedGame = null/);
  assert.match(script, /予告先発 未発表/);
  assert.match(script, /次の試合は未定/);
});
