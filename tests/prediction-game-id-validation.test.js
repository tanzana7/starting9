import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const worker = fs.readFileSync(workerPath, "utf8");
const { getResolvedPredictionDeadlineStatus, parsePredictionGameId, resolveApiGameReference, resolvePredictionGameMetadata } = await import(pathToFileURL(workerPath).href);

function createScheduleDb({ directRow = null, candidateRows = [] } = {}) {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => directRow,
            all: async () => ({ results: candidateRows })
          };
        }
      };
    }
  };
}

test("長形式のcanonical game_idを既知の球団slugとして正規化できる", () => {
  assert.deepEqual(parsePredictionGameId("2026-08-01-fighters-marines-1400"), {
    gameId: "2026-08-01-fighters-marines-1400",
    date: "2026-08-01",
    homeCode: "f",
    awayCode: "m",
    opponentCode: "m",
    isHome: true,
    gameCode: "",
    format: "descriptive"
  });
});

test("D1のgame_codeを受け取った場合も既存のcanonical game_idへ解決する", async () => {
  const resolved = await resolvePredictionGameMetadata(createScheduleDb({ directRow: {
    game_id: "2026-08-01-fighters-marines-1400",
    game_date: "2026-08-01",
    start_at: "2026-08-01T05:00:00.000Z",
    home_team: "fighters",
    away_team: "marines",
    game_code: "f-m-15",
    game_status: "scheduled"
  } }), "2026-08-01-f-m-15");

  assert.equal(resolved.gameId, "2026-08-01-fighters-marines-1400");
  assert.equal(resolved.gameCode, "f-m-15");
  assert.equal(resolved.startAt, "2026-08-01T05:00:00.000Z");
});

test("D1に保存されたUTC開始時刻から、既存どおり試合開始1時間前の締切を算出する", async () => {
  const resolved = await resolvePredictionGameMetadata(createScheduleDb({ directRow: {
    game_id: "2026-08-01-fighters-marines-1400",
    game_date: "2026-08-01",
    start_at: "2026-08-01T05:00:00.000Z",
    home_team: "fighters",
    away_team: "marines",
    game_code: "f-m-15",
    game_status: "scheduled"
  } }), "2026-08-01-fighters-marines-1400");

  const before = getResolvedPredictionDeadlineStatus(resolved, new Date("2026-08-01T03:59:59.000Z"));
  const atDeadline = getResolvedPredictionDeadlineStatus(resolved, new Date("2026-08-01T04:00:00.000Z"));
  assert.equal(before.isClosed, false);
  assert.equal(atDeadline.isClosed, true);
  assert.equal(atDeadline.deadlineAt, "2026-08-01T04:00:00.000Z");
});

test("静的日程にもD1にも存在しないIDと任意文字列は受け入れない", async () => {
  assert.equal(await resolvePredictionGameMetadata(createScheduleDb(), "2026-12-31-fighters-marines-1400"), null);
  assert.equal(parsePredictionGameId("2026-08-01-made-up-team-1400"), null);
  assert.equal(parsePredictionGameId("not-a-game-id"), null);
});

test("説明形式の対象gameIdを、同一日時・対戦カードのD1 compact game_idへ解決する", async () => {
  const resolved = await resolvePredictionGameMetadata(createScheduleDb({ candidateRows: [{
    game_id: "2026-08-01-f-m-15",
    game_date: "2026-08-01",
    start_at: "2026-08-01T05:00:00.000Z",
    home_team: "fighters",
    away_team: "marines",
    game_code: "f-m-15",
    game_status: "scheduled"
  }] }), "2026-08-01-fighters-marines-1400");

  assert.equal(resolved.gameId, "2026-08-01-f-m-15");
  assert.equal(resolved.gameCode, "f-m-15");
  assert.equal(resolved.startAt, "2026-08-01T05:00:00.000Z");
});

test("D1同期前に静的日程から返した既知gameIdは開始時刻付きで保存対象へ解決する", async () => {
  const compact = await resolvePredictionGameMetadata(createScheduleDb(), "2026-08-01-f-m-15");
  const descriptive = await resolvePredictionGameMetadata(createScheduleDb(), "2026-08-01-fighters-marines-1400");

  for (const resolved of [compact, descriptive]) {
    assert.equal(resolved.gameId, "2026-08-01-f-m-15");
    assert.equal(resolved.gameCode, "f-m-15");
    assert.equal(resolved.startAt, "2026-08-01T05:00:00.000Z");
  }
});

test("対象試合APIのinternalGameIdを画面の保存処理が優先して送信する", () => {
  assert.match(script, /state\.predictionTargetGame\?\.internalGameId \|\| state\.probableStarter\.nextGame\?\.internalGameId \|\| getCurrentLegacyGameId\(\)/);
  assert.match(script, /body: JSON\.stringify\(\{ gameId, prediction: predictionPayload\.prediction \}\)/);
  assert.match(worker, /const reference = await resolveApiGameReference\(env\.AUTH_DB, input\?\.gameId\)/);
  assert.match(worker, /internalGameId: metadata\.internalGameId \|\| ""/);
  assert.match(worker, /const storageGameId = metadata\.internalGameId && existing\?\.game_id/);
  assert.match(worker, /storageGameId,\s*\.\.\.\(predictionStorage\.predictions/);
});

test("compact game_code照合は同じ試合日の行だけを候補にする", () => {
  assert.match(worker, /game_code = \?2 AND game_date = \?3/);
  assert.match(worker, /\.bind\(parsed\.gameId, parsed\.gameCode \|\| "", parsed\.date\)\.first\(\)/);
});

test("通常画面の保存はUUIDを優先し、締切判定は旧gameIdを利用する", () => {
  const currentGameId = script.slice(script.indexOf("function getCurrentGameId"), script.indexOf("\nfunction getAdminScoringGameId"));
  const deadlineGameId = script.slice(script.indexOf("function getPredictionDeadlineGameId"), script.indexOf("\nfunction parseJstScheduleDateTime"));

  assert.match(currentGameId, /state\.predictionTargetGame\?\.internalGameId/);
  assert.match(currentGameId, /getCurrentLegacyGameId\(\)/);
  assert.doesNotMatch(currentGameId, /state\.prediction\?\.gameId/);
  assert.match(deadlineGameId, /: getCurrentLegacyGameId\(\)/);
});

test("アカウント保存・復元・削除は共通API resolverを使う", () => {
  const put = worker.slice(worker.indexOf("async function handlePutCurrentPrediction"), worker.indexOf("async function handleDeleteCurrentPrediction"));
  const remove = worker.slice(worker.indexOf("async function handleDeleteCurrentPrediction"), worker.indexOf("async function getPredictionRow"));
  const get = worker.slice(worker.indexOf("async function handleGetCurrentPrediction"), worker.indexOf("async function isGameResultsPublished"));
  assert.match(put, /resolveApiGameReference\(env\.AUTH_DB, input\?\.gameId\)/);
  assert.match(get, /resolveApiGameReference\(/);
  assert.match(remove, /resolveApiGameReference\(/);
  assert.match(put, /createPredictionDeadlineRejection\(metadata, cors\)/);
  assert.match(remove, /createPredictionDeadlineRejection\(metadata, cors\)/);
});

test("API共通resolverは空の識別子を形式不正として拒否する", async () => {
  const resolved = await resolveApiGameReference(createScheduleDb(), "");
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "INVALID_GAME_IDENTIFIER_FORMAT");
});

test("Phase 4はmigration未適用時の旧game_id fallbackとdual-writeを明示する", () => {
  assert.match(worker, /getInternalGameIdStorageAvailability/);
  assert.match(worker, /internal_game_id = \?1 WHERE game_id = \?2/);
  assert.match(worker, /ON CONFLICT\(user_id, game_id\) DO UPDATE SET/);
  assert.match(worker, /internal_game_id IS NULL AND game_id = \?3/);
});

test("予告先発とロースターの保存後もcanonical IDへ関連行をリンクする", () => {
  const probable = worker.slice(worker.indexOf("async function runProbableStarterFetch"), worker.indexOf("function parseJsonArray"));
  const roster = worker.slice(worker.indexOf("async function saveRosterSnapshotFromNotice"), worker.indexOf("async function fixGameRosterAtDeadline"));
  assert.match(probable, /linkLegacyGameRowsToInternalGameId\(env\.AUTH_DB, target\?\.internalGameId, gameId\)/);
  assert.match(roster, /linkLegacyGameRowsToInternalGameId\(db, storage\.internalGameId, identity\.gameId\)/);
});
