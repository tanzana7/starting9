import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(root, "game-schedule-detection.js")).href;

test("ファイターズのホーム・ビジター戦だけを内部チームコードへ正規化する", async () => {
  const { normalizeFightersScheduleGames } = await import(moduleUrl);
  const games = normalizeFightersScheduleGames([
    { homeTeam: "北海道日本ハムファイターズ", awayTeam: "楽天", startTime: "18:00", gameCode: "f-e-15" },
    { homeTeam: "西武", awayTeam: "F", startTime: "18:00", gameCode: "l-f-17" },
    { homeTeam: "巨人", awayTeam: "阪神", startTime: "18:00", gameCode: "g-t-12" }
  ], "2026-07-23");

  assert.equal(games.length, 2);
  assert.deepEqual(games.map((game) => [game.homeTeam, game.awayTeam]), [["fighters", "eagles"], ["lions", "fighters"]]);
  assert.deepEqual(games.map((game) => game.gameId), ["2026-07-23-f-e-15", "2026-07-23-l-f-17"]);
});

test("gameCodeがない試合は開始時刻を含む安定した識別子で重複を防ぐ", async () => {
  const { normalizeFightersScheduleGames } = await import(moduleUrl);
  const games = normalizeFightersScheduleGames([
    { homeTeam: "日本ハム", awayTeam: "ロッテ", startTime: "13:00" },
    { homeTeam: "日本ハム", awayTeam: "ロッテ", startTime: "18:00" },
    { homeTeam: "日本ハム", awayTeam: "ロッテ", startTime: "13:00" }
  ], "2026-07-23");
  assert.deepEqual(games.map((game) => game.gameId), ["2026-07-23-fighters-marines-1300", "2026-07-23-fighters-marines-1800"]);
});

test("Cronは公式日程をService Bindingで同期してから既存の試合前処理を実行する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const npbWorker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "0011_detected_game_schedule.sql"), "utf8");
  assert.match(worker, /await syncTodayFightersSchedule\(env, now\)/);
  assert.match(worker, /fetchNpbWorkerJson\(env, \{ mode: "schedule", date \}\)/);
  assert.match(worker, /INSERT INTO detected_game_schedule/);
  assert.match(worker, /setDetectedScheduleGames\(rows\)/);
  assert.match(npbWorker, /mode === "schedule"/);
  assert.match(npbWorker, /handleScheduleRequest/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS detected_game_schedule/);
});
