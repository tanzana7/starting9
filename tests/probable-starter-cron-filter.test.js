import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");

function fakeDb(scheduleRows, probableRow) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              return sql.includes("detected_game_schedule") ? { results: scheduleRows } : { results: [] };
            },
            async first() {
              return sql.includes("probable_starters") ? probableRow : null;
            }
          };
        }
      };
    }
  };
}

test("両チームの予告先発が揃った試合はCron対象から除外する", async () => {
  const { selectProbableStarterCronTarget } = await import(pathToFileURL(workerPath));
  const selection = await selectProbableStarterCronTarget(fakeDb([
    {
      game_id: "2026-08-20-f-m-20",
      game_date: "2026-08-20",
      start_at: "2026-08-20T05:00:00.000Z",
      home_team: "fighters",
      away_team: "marines",
      game_code: "f-m-20",
      venue: ""
    }
  ], {
    status: "announced",
    home_pitcher_name: "伊藤 大海",
    away_pitcher_name: "種市 篤暉",
    next_check_at: null
  }), new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(selection.reason, "already_announced");
  assert.equal(selection.target, null);
});

test("片側取得はpartial完了として保持し、未取得・再試行待ちだけをCron候補に残す", async () => {
  const { isProbableStarterComplete, selectProbableStarterCronTarget } = await import(pathToFileURL(workerPath));
  assert.equal(isProbableStarterComplete({ status: "announced", home_pitcher_name: "A", away_pitcher_name: "B" }), true);
  assert.equal(isProbableStarterComplete({ status: "announced", home_pitcher_name: "A", away_pitcher_name: "" }), false);
  assert.equal(isProbableStarterComplete({ status: "unannounced", home_pitcher_name: "", away_pitcher_name: "" }), false);

  const selection = await selectProbableStarterCronTarget(fakeDb([
    {
      game_id: "2026-08-20-f-m-20",
      game_date: "2026-08-20",
      start_at: "2026-08-20T05:00:00.000Z",
      home_team: "fighters",
      away_team: "marines",
      game_code: "f-m-20",
      venue: ""
    }
  ], {
    status: "announced",
    home_pitcher_name: "伊藤 大海",
    away_pitcher_name: "",
    next_check_at: null
  }), new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(selection.reason, "already_announced");
  assert.equal(selection.target, null);
});

test("Cron候補抽出後にのみ取得関数を呼び、正常な取得済み除外はログを作らない", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  const selection = worker.indexOf("const selection = await selectProbableStarterCronTarget(env.AUTH_DB, now)");
  const fetch = worker.indexOf("runProbableStarterFetch(env, target, now, { source: \"cron\" })");
  const announced = worker.indexOf('selection.reason === "already_announced"');
  assert.ok(selection >= 0 && announced > selection && fetch > announced);
  const announcedBlock = worker.slice(announced, worker.indexOf("  if (!target?.gameId", announced));
  assert.doesNotMatch(announcedBlock, /recordProbableStarterDecision/);
});

test("手動再取得はCron用候補抽出を経由せず同じジョブ実行器を使う", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  assert.match(worker, /const workflow = await runAdminProbableStarterWorkflowJob\(env, target, new Date\(\)\)/);
  assert.match(worker, /executeProbableStarterWorkflowJob\(env, claimed, now, "admin"\)/);
  assert.match(worker, /runProbableStarterFetch\(env, target, now, \{ source: "admin" \}\)/);
});
