import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("試合前処理ツールの各APIは管理者ルートへ接続される", () => {
  const worker = read("auth-worker.js");
  const html = read("index.html");
  const script = read("script.js");

  for (const action of ["run-notice", "distribute-notice", "run-roster", "fix-roster", "run-lineup", "publish"]) {
    assert.match(worker, new RegExp(`pregame-automation/${action}`));
  }
  assert.match(worker, /auto-scoring\/run-now/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /route\.action === "predictions\/summary"/);
  assert.match(script, /buildAdminGameApiUrl\(gameId, `pregame-automation\/\$\{action\}`\)/);
  assert.match(script, /buildAdminGameApiUrl\(gameId, "auto-scoring\/run-now"\)/);
  assert.match(html, /id="runPregameNoticeButton"/);
  assert.match(html, /id="distributePregameNoticeButton"/);
  assert.match(html, /id="runPregameRosterButton"/);
  assert.match(html, /id="fixPregameRosterButton"/);
  assert.match(html, /id="runPregameLineupButton"/);
  assert.match(html, /id="runPregameScoringButton"/);
  assert.match(html, /id="publishPregameResultsButton"/);
});

test("NPB WorkerのHTTP・JSON失敗を上流status付きで個別処理する", () => {
  const worker = read("auth-worker.js");
  const npbWorker = read("cloudflare-worker.js");
  assert.match(worker, /response\.status/);
  assert.match(worker, /NPB_RESPONSE_INVALID/);
  assert.match(worker, /NPB_WORKER_TIMEOUT/);
  assert.match(worker, /upstreamStatus/);
  assert.match(worker, /NOTICE_FETCH_FAILED/);
  assert.match(worker, /NOTICE_PARSE_FAILED/);
  assert.match(worker, /ROSTER_FETCH_FAILED/);
  assert.match(worker, /ROSTER_PARSE_FAILED/);
  assert.match(worker, /LINEUP_FETCH_FAILED/);
  assert.match(worker, /LINEUP_NOT_PUBLISHED/);
  assert.match(worker, /LINEUP_INVALID/);
  assert.match(npbWorker, /code: "NOTICE_FETCH_FAILED"/);
  assert.match(npbWorker, /code: "NOTICE_PARSE_FAILED"/);
  assert.match(npbWorker, /code: "ROSTER_FETCH_FAILED"/);
  assert.match(npbWorker, /code: "ROSTER_PARSE_FAILED"/);
});

test("D1不足を処理別schema errorとして返し、成功レスポンスでstatus再取得しない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /function isPregameSchemaError\(error\)/);
  assert.match(worker, /NOTICE_SCHEMA_NOT_READY/);
  assert.match(worker, /ROSTER_SCHEMA_NOT_READY/);
  assert.match(worker, /LINEUP_SCHEMA_NOT_READY/);
  assert.match(worker, /PUBLISH_SCHEMA_NOT_READY/);
  assert.doesNotMatch(worker, /result, pregame: await getPregameAutomationStatus/);
  assert.match(worker, /function executePregameTool\(env, cors, gameId, action, operation\)/);
});

test("採点前提不足は409の安全なコードを返す", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /SCORING_LINEUP_REQUIRED/);
  assert.match(worker, /SCORING_IN_PROGRESS/);
  assert.match(worker, /httpStatus: 409/);
});

test("管理画面はエラーmessage・code・HTTP statusを表示する", () => {
  const script = read("script.js");
  assert.match(script, /function getSafePregameActionError\(response, payload, action = ""\)/);
  assert.match(script, /payload\?\.error/);
  assert.match(script, /コード：\$\{safeCode\}/);
  assert.match(script, /HTTP \$\{response\.status\}/);
});

test("migration 0009/0010が試合前処理のD1前提を定義する", () => {
  const migration0009 = read(path.join("migrations", "0009_pregame_automation.sql"));
  const migration0010 = read(path.join("migrations", "0010_game_day_schedule_flow.sql"));
  assert.match(migration0009, /CREATE TABLE IF NOT EXISTS game_roster_snapshots/);
  assert.match(migration0009, /CREATE TABLE IF NOT EXISTS game_pregame_automation/);
  assert.match(migration0010, /CREATE TABLE IF NOT EXISTS game_day_notices/);
  assert.match(migration0010, /CREATE TABLE IF NOT EXISTS game_day_notice_games/);
  assert.match(migration0010, /ALTER TABLE game_pregame_automation ADD COLUMN roster_fixed_at/);
  assert.match(migration0010, /ALTER TABLE game_lineups ADD COLUMN publication_status/);
});
