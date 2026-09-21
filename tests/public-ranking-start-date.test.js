import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getPublicWeeklyRankingAvailability } from "../auth-worker.js";

const root = path.join(import.meta.dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8"));

test("週間ランキングはJSTの開始日までは順位を返さず、開始週より前も遡れない", () => {
  assert.deepEqual(
    getPublicWeeklyRankingAvailability({
      now: new Date("2026-09-20T14:59:59.999Z"),
      weekStart: "2026-09-14"
    }),
    { status: "not_started", message: "ランキングは9月21日（月）の試合からスタート！" }
  );
  assert.deepEqual(
    getPublicWeeklyRankingAvailability({
      now: new Date("2026-09-21T00:00:00.000Z"),
      weekStart: "2026-09-14"
    }),
    { status: "unavailable", message: "この期間のランキングは公開していません。" }
  );
  assert.deepEqual(
    getPublicWeeklyRankingAvailability({
      now: new Date("2026-09-21T00:00:00.000Z"),
      weekStart: "2026-09-21"
    }),
    { status: "available", message: "" }
  );
});

test("期間別ランキングAPIは一般ユーザーへデータを返さず、結果APIには日付cutoffを適用しない", () => {
  assert.equal(config.vars.PUBLIC_RANKING_RELEASED_AT, "2026-09-21T00:00:00+09:00");
  assert.match(worker, /PUBLIC_RANKING_ADMIN_ONLY/);
  assert.match(worker, /adminRankingRoute/);
  const resultGames = worker.slice(worker.indexOf("async function handleGetResultGames"), worker.indexOf("async function handleGetResultGame", worker.indexOf("async function handleGetResultGames")));
  const resultGame = worker.slice(worker.indexOf("async function handleGetResultGame"), worker.indexOf("const tableColumnSetCache", worker.indexOf("async function handleGetResultGame")));
  const previousResult = worker.slice(worker.indexOf("async function handleGetPreviousResultGame"), worker.indexOf("async function handleGetProbableStarter", worker.indexOf("async function handleGetPreviousResultGame")));
  assert.doesNotMatch(resultGames, /getPublicRankingStartDate|publicStartCondition|PUBLIC_RESULT_PERIOD_HIDDEN/);
  assert.doesNotMatch(resultGame, /getPublicRankingStartDate|PUBLIC_RESULT_PERIOD_HIDDEN/);
  assert.doesNotMatch(previousResult, /getPublicRankingStartDate|publicStartCondition|publicStartBindings/);
});

test("通常画面から期間別ランキングの表示と導線を除去する", () => {
  assert.doesNotMatch(html, /rankingPanel|showWeeklyRankingButton|showMonthlyRankingButton|showYearlyRankingButton/);
  assert.doesNotMatch(script, /refreshWeeklyRanking\(\{ force: false \}\)/);
});
