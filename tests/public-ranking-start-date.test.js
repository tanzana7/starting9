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

test("週間APIは開始日前の旧データを返さず、正式な試合日cutoffを使う", () => {
  assert.equal(config.vars.PUBLIC_RANKING_RELEASED_AT, "2026-09-21T00:00:00+09:00");
  assert.match(worker, /PUBLIC_RANKING_PERIOD_HIDDEN/);
  assert.match(worker, /rankingStatus: hasPublishedGames \? "available" : "collecting"/);
  assert.match(worker, /releaseCutoffAt: `\$\{publicStartDate\}T00:00:00\+09:00`/);
  assert.match(worker, /ranking_games\.game_date >= \?2/);
  assert.match(worker, /PUBLIC_RESULT_PERIOD_HIDDEN/);
});

test("通常画面は週間だけを表示し、開始週より前の前週移動を許可しない", () => {
  assert.match(html, /id="showWeeklyRankingButton"/);
  assert.doesNotMatch(html, /showMonthlyRankingButton|showYearlyRankingButton/);
  assert.match(script, /if \(view !== "weekly"\) return/);
  assert.match(script, /const firstServiceWeek = "2026-09-21"/);
  assert.match(script, /ランキング集計中/);
});
