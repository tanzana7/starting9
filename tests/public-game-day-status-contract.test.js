import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const workerPath = path.join(root, "auth-worker.js");
const worker = read("auth-worker.js");
const script = read("script.js");
const coordinator = read("frontend/public/app-coordinator.js");
const html = read("index.html");
const {
  parseGameDayStatusRequestIdentifier,
  resolveApiGameReference,
  resolveGameDayStatusIdentity
} = await import(pathToFileURL(workerPath).href);

function createCanonicalGameDb({ internalGameId, gameRow, scheduleRow }) {
  return {
    prepare(sql) {
      return {
        bind() {
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
              if (sql.includes("PRAGMA table_info")) {
                return { results: [{ name: "internal_game_id" }, { name: "start_time" }] };
              }
              if (sql.includes("FROM game_identifiers")) {
                return { results: [{ internal_game_id: internalGameId, identifier_type: "internal_game_id", identifier_value: internalGameId }] };
              }
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

test("game-day-statusはlegacy gameIdとcanonical internalGameIdを明示的に受け付ける", () => {
  assert.deepEqual(
    parseGameDayStatusRequestIdentifier(new URLSearchParams({ gameId: "2026-08-13-fighters-lions-1800" })),
    { type: "legacyGameId", value: "2026-08-13-fighters-lions-1800" }
  );
  assert.deepEqual(
    parseGameDayStatusRequestIdentifier(new URLSearchParams({ internalGameId: "34005ba3-cf62-4dee-81ca-bf427731c560" })),
    { type: "internalGameId", value: "34005ba3-cf62-4dee-81ca-bf427731c560" }
  );
  assert.deepEqual(
    parseGameDayStatusRequestIdentifier(new URLSearchParams({ gameId: "34005ba3-cf62-4dee-81ca-bf427731c560" })),
    { type: "internalGameId", value: "34005ba3-cf62-4dee-81ca-bf427731c560" }
  );
  assert.equal(parseGameDayStatusRequestIdentifier(new URLSearchParams({ internalGameId: "not-a-uuid" })), null);
});

test("game-day-statusはcompact IDを従来のstatic pregame経路で解決し、UUIDだけcanonical registryを使う", () => {
  const start = worker.indexOf("async function handleGetGameDayStatus");
  const end = worker.indexOf("async function handleGetGameDayRoster", start);
  const handler = worker.slice(start, end);
  assert.match(handler, /parseGameDayStatusRequestIdentifier/);
  assert.match(handler, /await resolveGameDayStatusIdentity\(env\.AUTH_DB, identifier\)/);
  assert.doesNotMatch(handler, /resolvePregameIdentity\(/);
  assert.match(handler, /if \(!identity\) return jsonResponse\(\{ ok: false, error: "対象試合を指定してください。" \}, 400, cors\)/);
  assert.match(handler, /internalGameId: identity\.internalGameId \|\| null/);
});

test("canonical internalGameIdは共通resolverで対象試合のlegacy日程IDへ解決される", async () => {
  const internalGameId = "34005ba3-cf62-4dee-81ca-bf427731c560";
  const resolved = await resolveApiGameReference(createCanonicalGameDb({
    internalGameId,
    gameRow: {
      internal_game_id: internalGameId,
      game_date: "2026-08-13",
      start_time: "2026-08-13T09:00:00.000Z",
      home_team: "fighters",
      away_team: "lions",
      game_status: "scheduled"
    },
    scheduleRow: {
      game_id: "2026-08-13-f-l-20",
      source_game_key: "2026-08-13:fighters:lions:18:00",
      game_date: "2026-08-13",
      start_at: "2026-08-13T09:00:00.000Z",
      home_team: "fighters",
      away_team: "lions",
      game_code: "f-l-20",
      game_status: "scheduled",
      internal_game_id: internalGameId
    }
  }), internalGameId);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.metadata.internalGameId, internalGameId);
  assert.equal(resolved.metadata.legacyGameId, "2026-08-13-f-l-20");
});

function createGameDayStatusDb({ internalGameId, game = null, identifiers = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("FROM games") ? game : null,
            all: async () => sql.includes("FROM game_identifiers") ? { results: identifiers } : { results: [] }
          };
        }
      };
    }
  };
}

test("実例のcompact legacy IDはregistryの可否に関係なく従来どおり解決される", async () => {
  const identity = await resolveGameDayStatusIdentity(null, {
    type: "legacyGameId",
    value: "2026-08-13-f-l-20"
  });

  assert.equal(identity?.gameId, "2026-08-13-f-l-20");
  assert.equal(identity?.gameCode, "f-l-20");
});

test("実例のcanonical UUIDはgamesとgame_identifiersから同じcompact pregame identityへ解決される", async () => {
  const internalGameId = "34005ba3-cf62-4dee-81ca-bf427731c560";
  const db = createGameDayStatusDb({
    internalGameId,
    game: {
      internal_game_id: internalGameId,
      game_date: "2026-08-13",
      start_time: "2026-08-13T09:00:00.000Z",
      home_team: "fighters",
      away_team: "lions",
      npb_game_code: "f-l-20",
      game_status: "scheduled"
    },
    identifiers: [
      { identifier_type: "descriptive_game_id", identifier_value: "2026-08-13-fighters-lions-1800" },
      { identifier_type: "npb_game_code", identifier_value: "f-l-20" }
    ]
  });

  const identity = await resolveGameDayStatusIdentity(db, { type: "internalGameId", value: internalGameId });
  assert.equal(identity?.internalGameId, internalGameId);
  assert.equal(identity?.gameId, "2026-08-13-f-l-20");
  assert.equal(identity?.gameCode, "f-l-20");
});

test("存在しないUUIDまたはcompact IDはgame-day-status identityを解決しない", async () => {
  const missing = await resolveGameDayStatusIdentity(createGameDayStatusDb(), {
    type: "internalGameId",
    value: "34005ba3-cf62-4dee-81ca-bf427731c560"
  });
  assert.equal(missing, null);
  assert.equal(await resolveGameDayStatusIdentity(null, { type: "legacyGameId", value: "2026-12-31-f-l-999" }), null);
});

test("公開画面はcanonical internalGameIdを公示状態APIへ送る", () => {
  const start = script.indexOf("function getGameDayNoticeTarget");
  const end = script.indexOf("function renderGameDayNoticeStatus", start);
  const builder = script.slice(start, end);
  assert.match(builder, /function getGameDayNoticeTarget\(\)/);
  assert.match(builder, /internalGameId: state\.predictionTargetGame\?\.internalGameId/);
  assert.match(builder, /function buildGameDayNoticeApiUrl\(\{ internalGameId = "", gameId = "" \} = \{\}\)/);
  assert.match(builder, /game-day-status\?internalGameId=/);
  assert.match(builder, /game-day-status\?gameId=/);
});

test("公開初期化はcurrent game確定後に公示状態を一度だけ取得する", () => {
  assert.equal((coordinator.match(/refreshGameDayNoticeStatus\(\{ force: true \}\)/g) || []).length, 1);
  assert.match(coordinator, /void ops\.initializePublicGameCatalog\(\)\s*\.then/);
  assert.match(coordinator, /void ops\.refreshGameDayNoticeStatus\(\{ force: true \}\)/);
  const start = script.indexOf("async function refreshGameDayNoticeStatus");
  const end = script.indexOf("async function fetchGameDayRosterSnapshot", start);
  assert.match(script.slice(start, end), /state\.gameDayNotice\.isLoading && state\.gameDayNotice\.gameId === gameId/);
});

test("公示なしはUIを隠し、4xxはwarning、5xxまたは通信失敗だけをconsole errorにする", () => {
  const start = script.indexOf("async function refreshGameDayNoticeStatus");
  const end = script.indexOf("async function fetchGameDayRosterSnapshot", start);
  const loader = script.slice(start, end);
  assert.match(loader, /error\.httpStatus = response\.status/);
  assert.match(loader, /httpStatus >= 500 \|\| !httpStatus/);
  assert.match(loader, /console\.warn\("本日の公示状態を確認できませんでした"/);
  assert.match(loader, /state\.gameDayNotice\.message = ""/);
  assert.match(script, /if \(!hasNotice\) \{[\s\S]*container\.classList\.add\("hidden"\)/);
});

test("公開画面のmoduleとentry pointは同じcache busterを使う", () => {
  assert.match(html, /frontend\/public\/app-coordinator\.js\?v=public-past-result-date-heading-1/);
  assert.match(html, /script\.js\?v=public-result-actual-player-score-table-1/);
});
