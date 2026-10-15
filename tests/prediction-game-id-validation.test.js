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

function createRegistryDb({ identifierRows = [], gameRow = null, scheduleRow = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              if (sql.includes("FROM games WHERE internal_game_id")) return gameRow;
              if (sql.includes("FROM detected_game_schedule") && sql.includes("internal_game_id = ?1")) return scheduleRow;
              return null;
            },
            all: async () => {
              if (sql.includes("sqlite_master")) {
                return { results: [{ name: "games" }, { name: "game_identifiers" }, { name: "detected_game_schedule" }] };
              }
              if (sql.includes("PRAGMA table_info")) return { results: [{ name: "internal_game_id" }] };
              if (sql.includes("FROM game_identifiers")) return { results: identifierRows };
              if (sql.includes("FROM games WHERE game_date")) return { results: gameRow ? [gameRow] : [] };
              return { results: [] };
            }
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

test("2026-08-04の説明形式IDをregistry経由で解決し、games.start_timeを締切計算へ使う", async () => {
  const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
  const resolved = await resolvePredictionGameMetadata(createRegistryDb({
    identifierRows: [{ internal_game_id: internalGameId, identifier_type: "descriptive_game_id", identifier_value: "2026-08-04-fighters-hawks-1800" }],
    gameRow: {
      internal_game_id: internalGameId,
      game_date: "2026-08-04",
      start_time: "2026-08-04T09:00:00.000Z",
      home_team: "fighters",
      away_team: "hawks",
      game_status: "scheduled"
    },
    scheduleRow: {
      game_id: "2026-08-04-f-h-15",
      source_game_key: "2026-08-04:fighters:hawks:18:00",
      game_date: "2026-08-04",
      start_at: "2026-08-04T10:00:00.000Z",
      home_team: "fighters",
      away_team: "hawks",
      game_code: "f-h-15",
      game_status: "scheduled",
      internal_game_id: internalGameId
    }
  }), "2026-08-04-fighters-hawks-1800");

  assert.equal(resolved.internalGameId, internalGameId);
  assert.equal(resolved.gameId, "2026-08-04-f-h-15");
  assert.equal(resolved.startAt, "2026-08-04T09:00:00.000Z");
  const before = getResolvedPredictionDeadlineStatus(resolved, new Date("2026-08-04T07:59:59.000Z"));
  const atDeadline = getResolvedPredictionDeadlineStatus(resolved, new Date("2026-08-04T08:00:00.000Z"));
  assert.equal(before.isClosed, false);
  assert.equal(atDeadline.isClosed, true);
  assert.equal(atDeadline.deadlineAt, "2026-08-04T08:00:00.000Z");
});

test("source_game_keyから対象UUIDへ安全に解決し、外部日程取得を必要としない", async () => {
  const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
  const db = createRegistryDb({
    identifierRows: [{ internal_game_id: internalGameId, identifier_type: "source_game_key", identifier_value: "2026-08-04:fighters:hawks:18:00" }],
    gameRow: {
      internal_game_id: internalGameId,
      game_date: "2026-08-04",
      start_time: "2026-08-04T09:00:00.000Z",
      home_team: "fighters",
      away_team: "hawks",
      game_status: "scheduled"
    }
  });
  const resolved = await resolvePredictionGameMetadata(db, "2026-08-04-fighters-hawks-1800");
  assert.equal(resolved.internalGameId, internalGameId);
  assert.equal(resolved.startAt, "2026-08-04T09:00:00.000Z");
});

test("V2の日本語チーム名を含むgames行から8月4日の内部試合IDと開始時刻を解決する", async () => {
  const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
  const resolved = await resolvePredictionGameMetadata(createRegistryDb({
    identifierRows: [{ internal_game_id: internalGameId, identifier_type: "descriptive_game_id", identifier_value: "2026-08-04-fighters-hawks-1800" }],
    gameRow: {
      internal_game_id: internalGameId,
      game_date: "2026-08-04",
      start_time: "2026-08-04T09:00:00.000Z",
      home_team: "日本ハム",
      away_team: "ソフトバンク",
      game_status: "scheduled"
    }
  }), "2026-08-04-fighters-hawks-1800");

  assert.equal(resolved.internalGameId, internalGameId);
  assert.equal(resolved.homeCode, "f");
  assert.equal(resolved.awayCode, "h");
  assert.equal(resolved.startAt, "2026-08-04T09:00:00.000Z");
});

test("対象試合APIはV3のinternalGameIdを保存処理へ送信する", () => {
  assert.match(script, /function getCurrentGameId\(\)[\s\S]*state\.predictionTargetGame\?\.internalGameId/);
  assert.match(script, /body: JSON\.stringify\(\{ internalGameId: gameId, prediction: predictionPayload\.prediction \}\)/);
  assert.match(worker, /reference = await resolveV3PredictionReference\(env\.AUTH_DB, input\?\.internalGameId\)/);
  assert.match(worker, /internalGameId: metadata\.internalGameId \|\| ""/);
  assert.match(worker, /const storageGameId = metadata\.internalGameId && existing\?\.game_id/);
  assert.match(worker, /storageGameId,\s*\.\.\.\(predictionStorage\.predictions/);
});

test("対象試合APIの一時障害時は、既存静的日程へ戻って保存対象を失わない", () => {
  const resolver = script.slice(script.indexOf("async function resolvePredictionTargetGame"), script.indexOf("async function getLoadedGameSchedule"));
  assert.match(resolver, /return null;/);
  assert.match(script, /mergePublicGameSchedules\(\[\], apiGames\)/);
  assert.match(script, /公開試合一覧の取得に失敗しました/);
});

test("compact game_code照合は同じ試合日の行だけを候補にする", () => {
  assert.match(worker, /game_code = \?2 AND game_date = \?3/);
  assert.match(worker, /\.bind\(parsed\.gameId, parsed\.gameCode \|\| "", parsed\.date\)\.first\(\)/);
});

test("通常画面の保存はUUIDを優先し、締切判定は旧gameIdを利用する", () => {
  const currentGameId = script.slice(script.indexOf("function getCurrentGameId"), script.indexOf("function getAuthApiBaseUrl"));
  const deadlineGameId = script.slice(script.indexOf("function getPredictionDeadlineGameId"), script.indexOf("\nfunction parseJstScheduleDateTime"));

  assert.match(currentGameId, /state\.predictionTargetGame\?\.internalGameId/);
  assert.doesNotMatch(currentGameId, /state\.prediction\?\.gameId/);
  assert.match(deadlineGameId, /return getCurrentGameId\(\)/);
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

test("V3はmigration未適用時に安全停止し、旧game_idへfallbackしない", () => {
  assert.match(worker, /V3_PREDICTIONS_SCHEMA_UNAVAILABLE/);
  assert.match(worker, /resolveV3PredictionReference\(env\.AUTH_DB, input\?\.internalGameId\)/);
});

test("予告先発とロースターの保存後もcanonical IDへ関連行をリンクする", () => {
  const probable = worker.slice(worker.indexOf("async function runProbableStarterFetch"), worker.indexOf("function parseJsonArray"));
  const roster = worker.slice(worker.indexOf("async function saveRosterSnapshotFromNotice"), worker.indexOf("async function fixGameRosterAtDeadline"));
  assert.match(probable, /linkLegacyGameRowsToInternalGameId\(env\.AUTH_DB, target\?\.internalGameId, gameId\)/);
  assert.match(roster, /linkLegacyGameRowsToInternalGameId\(db, storage\.internalGameId, identity\.gameId\)/);
});
