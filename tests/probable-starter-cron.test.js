import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("予告先発はgameId単位のD1保存と60分再確認時刻を持つ", () => {
  const migration = read("migrations/0020_probable_starters.sql");
  for (const field of [
    "game_id", "status", "home_pitcher_name", "away_pitcher_name", "fetched_at",
    "announced_at", "next_check_at", "source_url", "error_code", "updated_at"
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`));
  }
  assert.match(migration, /status IN \('unannounced', 'announced', 'error'\)/);
  assert.match(read("auth-worker.js"), /PROBABLE_STARTER_RETRY_INTERVAL_MS = 60 \* 60 \* 1000/);
  assert.match(read("auth-worker.js"), /new Date\(current\.getTime\(\) \+ PROBABLE_STARTER_RETRY_INTERVAL_MS\)/);
});

test("Cronはtarget・開始前・next_check_at・announcedを条件に予告先発を取得する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /shared\.probableStarter = await runDueProbableStarterWorkflowJobs\(env, now\)/);
  assert.match(worker, /mode: "legacy", \.\.\.\(await runDueProbableStarterJob\(env, now\)\)/);
  assert.match(worker, /selectProbableStarterCronTarget\(env\.AUTH_DB, now\)/);
  assert.match(worker, /new Date\(now\)\.getTime\(\) >= new Date\(target\.startAt\)\.getTime\(\)/);
  assert.match(worker, /isProbableStarterComplete\(row\)/);
  assert.match(worker, /row\?\.next_check_at && new Date\(row\.next_check_at\)\.getTime\(\) > new Date\(now\)\.getTime\(\)/);
  assert.match(worker, /fetchNpbWorkerJson\(env, \{ mode: "starter" \}\)/);
});

test("保存済み表示APIと管理者手動再取得APIは別経路で、手動側は認証必須", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  assert.match(worker, /path === "\/api\/probable-starter" && request\.method === "GET"/);
  assert.match(worker, /async function handleGetProbableStarter\(request, env, cors\)/);
  assert.match(worker, /async function handleAdminProbableStarterRefresh\(request, env, cors, gameId\)/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\);/);
  assert.match(script, /fetchStoredProbableStarter\(\)/);
  assert.match(script, /buildAdminGameApiUrl\(gameId, "probable-starter\/refresh"\)/);
  assert.doesNotMatch(script, /NPB_STARTER_SOURCE_URL[\s\S]*?searchParams\.set\("mode", "starter"\)/);
});

test("Cron・手動とも通常試合だけを対象にし、取得失敗は次回再試行へ回す", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async function isProbableStarterTestGame\(db, gameId\)/);
  assert.match(worker, /if \(await isProbableStarterTestGame\(env\.AUTH_DB, target\.gameId\)\)/);
  assert.match(worker, /status: "error"/);
  assert.match(worker, /nextCheckAt = new Date\(current\.getTime\(\) \+ PROBABLE_STARTER_RETRY_INTERVAL_MS\)/);
  assert.match(worker, /eventType: "probable_starter_fetch_failed"/);
});
