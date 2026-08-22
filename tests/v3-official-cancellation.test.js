import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyOfficialCancellationText, extractScheduleGames } from "../cloudflare-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const cloudflareSource = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
const executorSource = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");

test("NPB公式の明示的な中止は検知し、可能性・検討段階は中止扱いにしない", () => {
  assert.deepEqual(classifyOfficialCancellationText("北海道日本ハム - 千葉ロッテ　18:00　中止"), {
    officialCancelled: true,
    marker: "中止",
    tentative: false
  });
  assert.equal(classifyOfficialCancellationText("中止の可能性があります").officialCancelled, false);
  assert.equal(classifyOfficialCancellationText("中止が検討されています").officialCancelled, false);
});

test("公式日程の中止行をcancelledとして正規化する", () => {
  const html = [
    "<h1>試合日程</h1>",
    "<table><tr><td>8月22日</td><td>北海道日本ハムファイターズ - 千葉ロッテマリーンズ</td><td>18:00 中止</td></tr></table>"
  ].join("");
  const games = extractScheduleGames(html, "2026-08-22");
  assert.equal(games?.length, 1);
  assert.deepEqual(games[0], {
    homeTeam: "fighters",
    awayTeam: "marines",
    startTime: "18:00",
    gameCode: "",
    venue: "",
    status: "cancelled"
  });
});

test("当日速報カードの中止状態を日程行へ引き継ぐ", () => {
  const html = [
    "<h1>試合日程</h1>",
    "<div class=\"score_box date\"><div>2026<br>8/22 Sat.</div></div>",
    "<div class=\"score_box\"><a href=\"/scores/2026/0822/m-f-18/\"><img alt=\"千葉ロッテマリーンズ\"><img alt=\"北海道日本ハムファイターズ\"><div class=\"state\">（ZOZOマリン）<br>中止</div></a></div>",
    "<table><tr id=\"date0822\"><th>8/22（土）</th><td>ロッテ - 日本ハム</td><td>ZOZOマリン 18:00</td></tr></table>"
  ].join("");
  const games = extractScheduleGames(html, "2026-08-22");
  assert.equal(games?.[0]?.gameCode, "m-f-18");
  assert.equal(games?.[0]?.status, "cancelled");
});

test("当日の日程を短い間隔で再確認し、公式中止を既存の正式除外経路へ接続する", () => {
  assert.match(authSource, /CURRENT_DAY_SCHEDULE_SYNC_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(authSource, /syncCurrentDayFightersSchedule\(env, now\)/);
  assert.match(authSource, /handleAdminGameScheduleUpdate\(synthetic, env/);
  assert.match(authSource, /cancelOpenV3Jobs\(env\.AUTH_DB, internalGameId/);
  assert.match(authSource, /transitionV3State\(env\.AUTH_DB, \{ internalGameId, from: stateBefore, to: "excluded"/);
  assert.match(authSource, /official_game_cancelled/);
  assert.match(cloudflareSource, /cancellationStatus: "official_cancelled"/);
  assert.match(executorSource, /OFFICIAL_CANCELLATION_RECONCILE_REQUIRED/);
  assert.match(executorSource, /official_cancellation_reconcile/);
});

test("スタメン取得の中止コードは未発表へ正規化されない", () => {
  assert.match(authSource, /if \(rawCode === "GAME_CANCELLED"\) return error/);
  assert.match(authSource, /status: "official_cancelled"/);
});
