import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readWorker = () => fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

test("予告先発取得は成功・未発表・失敗の終端ログを持つ", () => {
  const worker = readWorker();
  assert.match(worker, /eventType: announced \? "probable_starter_announced" : "probable_starter_unannounced"/);
  assert.match(worker, /eventType: "probable_starter_fetch_failed"/);
  assert.match(worker, /let terminalLogged = false/);
  assert.match(worker, /if \(!terminalLogged\)[\s\S]*?PROBABLE_STARTER_TERMINAL_STATE_MISSING/);
  assert.match(worker, /status: announced \? "success" : "notPublished"/);
});

test("対象なし・既取得・再試行待ちは取得せず終端状態を記録する", () => {
  const worker = readWorker();
  assert.match(worker, /async function recordProbableStarterDecision\(/);
  assert.match(worker, /eventType: started \? "probable_starter_fetch_skipped" : "probable_starter_no_target"/);
  assert.match(worker, /PROBABLE_STARTER_ALREADY_ANNOUNCED/);
  assert.match(worker, /PROBABLE_STARTER_RETRY_WAIT/);
  assert.match(worker, /return \{ status: started \? "not_due" : "noTarget", gameId \};/);
  assert.match(worker, /WORKFLOW_LOG_DEDUPE_WINDOW_MS = 30 \* 60 \* 1000/);
});

test("実取得の開始ログは対象判定とテスト試合除外の後に記録する", () => {
  const worker = readWorker();
  const testGameCheck = worker.indexOf("if (await isProbableStarterTestGame(env.AUTH_DB, gameId))");
  const startedLog = worker.indexOf('eventType: "probable_starter_fetch_started"');
  assert.ok(testGameCheck >= 0);
  assert.ok(startedLog > testGameCheck);
});

