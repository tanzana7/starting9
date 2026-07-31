import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const workerUrl = pathToFileURL(workerPath).href;
const worker = fs.readFileSync(workerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

function functionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  const end = nextName ? source.indexOf(`async function ${nextName}(`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} が見つかりません`);
  return source.slice(start, end === -1 ? source.length : end);
}

test("試合開始前だけ正式スタメン保存を許可し、開始時刻ちょうどと開始後を拒否する", async () => {
  const { isBeforeGameStart } = await import(workerUrl);
  const startAt = new Date("2026-07-25T05:00:00.000Z");

  assert.equal(isBeforeGameStart(startAt, new Date("2026-07-25T04:59:00.000Z")), true);
  assert.equal(isBeforeGameStart(startAt, startAt), false);
  assert.equal(isBeforeGameStart(startAt, new Date("2026-07-25T05:01:00.000Z")), false);
  assert.equal(isBeforeGameStart(startAt, new Date("invalid")), false);
});

test("自動取得は試合開始時刻以降にNPBを取得せず、保存済み行を自動上書きしない", () => {
  assert.match(worker, /phase = "provisional"/);
  assert.match(worker, /phase === "final"/);
  assert.match(worker, /now < identity\.finalLineupFetchAt/);
  assert.match(worker, /const isFinalPhase = now >= finalLineupFetchAt/);
  assert.match(worker, /getDueFinalLineupAttemptAt\(timeline, now\)/);
  assert.match(worker, /if \(existing\) return \{ status: existing\.lineup_source === "manual" \? "manual_lineup_exists" : "already_captured" \};/);
  assert.match(worker, /provisional_lineup_json/);
  assert.match(worker, /preventOverwrite: true/);
  assert.match(worker, /assertOfficialLineupSaveAllowed\(gameId, options\.now \|\| new Date\(\)\)/);
});

test("NPBスタメンの守備位置正規化は採点用の既存関数を使い、未定義参照を残さない", () => {
  assert.match(worker, /const position = normalizeScoringPosition\(row\?\.position\);/);
  assert.doesNotMatch(worker, /const position = normalizePosition\(row\?\.position\);/);
  assert.match(worker, /function normalizeScoringPosition\(value\)/);
  for (const alias of ["捕", "一", "二", "三", "遊", "左", "中", "右", "指", "DH", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]) {
    assert.match(worker, new RegExp(`(?:[\"']${alias}[\"']|\\b${alias}\\b)`), `${alias} の正規化定義がありません`);
  }
});

test("Cron採点と手動採点は保存済みgame_lineupsを採点元にする", () => {
  assert.match(worker, /const storedLineup = parseStoredActualLineup\(record\.actual_lineup_json\);/);
  assert.match(worker, /SELECT id, user_id, prediction_json FROM predictions WHERE game_id = \?1 AND is_test_prediction = 0/);

  const previewBody = functionBody(worker, "handleAdminScorePredictionsPreview", "handleAdminScorePredictions");
  const scoreBody = functionBody(worker, "handleAdminScorePredictions", "prepareGamePredictionScoring");
  assert.match(previewBody, /const record = await getGameLineup\(env\.AUTH_DB, gameId\);/);
  assert.match(scoreBody, /const record = await getGameLineup\(env\.AUTH_DB, gameId\);/);
  assert.doesNotMatch(previewBody, /input\?\.actualLineup/);
  assert.doesNotMatch(scoreBody, /input\?\.actualLineup/);
  assert.doesNotMatch(scoreBody, /saveActualLineupForAutoScoring/);
  assert.match(previewBody, /SCORING_LINEUP_REQUIRED/);
  assert.match(scoreBody, /SCORING_LINEUP_REQUIRED/);
  assert.match(worker, /SET score = \?1, max_score = \?2, scored_at = \?3, status = 'scored', actual_lineup_json = \?4/);
});

test("通常の手動保存は開始後・採点後・公開後・再採点ロック中に上書きせず、修正はversion経路へ分離する", () => {
  const saveBody = functionBody(worker, "handleAdminActualLineupSave", "getManualRescoreExpiresAt");
  assert.match(saveBody, /assertOfficialLineupSaveAllowed\(gameId, now\);/);
  assert.match(saveBody, /LINEUP_REVISION_REQUIRED/);
  assert.match(saveBody, /existing\.scoring_status === "processing"/);
  assert.match(saveBody, /existing\.scoring_status === "scored"/);
  assert.match(saveBody, /existing\.publication_status === "published"/);
  assert.match(saveBody, /isManualRescoreLocked\(env\.AUTH_DB, gameId\)/);
  assert.match(worker, /async function handleAdminLineupRevision/);
  assert.match(worker, /async function handleAdminRescoreConfirm/);
  assert.match(worker, /async function applyManualRescore/);
  assert.match(worker, /lineup_source = 'manual-revision'/);
});

test("管理画面の採点リクエストはactualLineupを送信せず、サーバー保存値のfingerprintを使う", () => {
  assert.match(script, /body: JSON\.stringify\(\{\}\)/);
  assert.match(script, /state\.adminScoring\.previewFingerprint = payload\.lineupFingerprint \|\| getAdminScoringFingerprint/);
  assert.doesNotMatch(script, /body: JSON\.stringify\(\{ actualLineup: actualPayload\.lineup \}\)/);
});
