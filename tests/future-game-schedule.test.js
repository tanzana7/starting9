import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const workerUrl = pathToFileURL(workerPath).href;

test("未来試合が3件未満なら日数ではなく14日範囲の補充計画を作る", async () => {
  const { getFutureScheduleSyncPlan } = await import(workerUrl);
  const plan = getFutureScheduleSyncPlan(new Date("2026-08-08T00:00:00.000Z"), 1);

  assert.equal(plan.shouldFetch, true);
  assert.equal(plan.fetchRangeStart, "2026-08-08");
  assert.equal(plan.fetchRangeEnd, "2026-08-22");
  assert.equal(plan.dates.length, 15);
});

test("移動日を挟んでも未来試合数が不足している間は補充を継続する", async () => {
  const { getFutureScheduleSyncPlan } = await import(workerUrl);
  const plan = getFutureScheduleSyncPlan(new Date("2026-08-08T00:00:00.000Z"), 2);

  assert.equal(plan.shouldFetch, true);
  assert.equal(plan.dates.length, 15);
  assert.ok(plan.dates.includes("2026-08-12"));
  assert.equal(plan.skipReason, "FUTURE_GAMES_BELOW_MINIMUM");
});

test("未来試合が3件以上なら不要な日程取得をスキップする", async () => {
  const { getFutureScheduleSyncPlan } = await import(workerUrl);
  const plan = getFutureScheduleSyncPlan(new Date("2026-08-08T00:00:00.000Z"), 3);

  assert.equal(plan.shouldFetch, false);
  assert.equal(plan.skipReason, "FUTURE_GAMES_SUFFICIENT");
  assert.deepEqual(plan.dates, []);
});

test("V3 Cronは日程補充をplannerより前に実行し、結果を診断へ返す", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  const start = worker.indexOf("async function runScheduledGameAutomationV3");
  const end = worker.indexOf("async function loadV3GameTarget", start);
  const entrypoint = worker.slice(start, end);

  assert.match(entrypoint, /scheduleSync = await ensureFutureFightersSchedule\(env, now\)/);
  assert.match(entrypoint, /const result = await runGameAutomationV3\(env, now/);
  assert.match(entrypoint, /return \{ \.\.\.result, scheduleSync \}/);
  assert.match(worker, /async function countFutureFightersGames\(db, now\)/);
  assert.match(worker, /futureGamesBefore/);
  assert.match(worker, /futureGamesAfter/);
  assert.match(worker, /gamesInserted/);
  assert.match(worker, /gamesUpdated/);
  assert.match(worker, /AUTOMATION_SCHEDULE_MAX_LOOKAHEAD_DAYS/);
});

test("V3試合一覧はgamesに登録済みの未来を日付上限なしで返す", () => {
  const source = fs.readFileSync(path.join(root, "game-automation-v3.js"), "utf8");
  const listStart = source.indexOf("export async function listV3Games");
  const listEnd = source.indexOf("export async function ensureV3State", listStart);
  const listFunction = source.slice(listStart, listEnd);

  assert.match(listFunction, /game_date >= date\(\?1\)/);
  assert.doesNotMatch(listFunction, /game_date <=/);
});

test("admin-v3のfuture filterはAPIから返った未来試合を3件に切り詰めない", () => {
  const source = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const filterStart = source.indexOf("function filteredV3Games");
  const filterEnd = source.indexOf("function selectedV3Game", filterStart);
  const filter = source.slice(filterStart, filterEnd);

  assert.match(filter, /if \(filter === "future"\) return date > today/);
  assert.doesNotMatch(filter, /slice\(0,\s*3\)/);
});
