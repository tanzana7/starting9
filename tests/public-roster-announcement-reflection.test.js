import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPublicBaselineRosterResponse,
  buildPublicGameDayRosterResponse,
  getPublicRosterQualityFromAuditDetails,
  getPublicRosterBaselineUsableUntil,
  isPublicRosterBaselineCandidate
} from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicRoster = fs.readFileSync(path.join(root, "frontend", "public", "roster.js"), "utf8");
const publicCoordinator = fs.readFileSync(path.join(root, "frontend", "public", "app-coordinator.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const internalGameId = "348e8d56-9565-474e-96e9-33b1e5ef6ae0";
const gameDate = "2026-08-09";

function snapshot(overrides = {}) {
  return {
    internal_game_id: internalGameId,
    game_date: gameDate,
    captured_at: "2026-08-09T03:12:10.291Z",
    source: "npb-roster",
    status: "captured",
    player_count: 2,
    roster_json: JSON.stringify([
      { name: "登録選手", number: "12", position: "外野手" },
      { name: "継続選手", number: "3", position: "捕手" }
    ]),
    ...overrides
  };
}

function getScriptFunctionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < script.length; index += 1) {
    if (script[index] === "{") {
      depth += 1;
      bodyStarted = true;
    } else if (script[index] === "}") {
      depth -= 1;
      if (bodyStarted && depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`${name} の終端を見つけられません`);
}

function createRosterFilterHelpers(storedSnapshot, selectedGame = { internalGameId, date: gameDate }, status = "fresh", usableUntil = "") {
  const context = vm.createContext({
    state: {
      isAdminMode: false,
      predictionTargetGame: selectedGame,
      probableStarter: { nextGame: null },
      publicRoster: {
        internalGameId,
        gameDate,
        status,
        players: storedSnapshot?.players || [],
        usableUntil
      }
    },
    STORAGE_KEYS: { rosterSnapshot: "roster" },
    loadFromStorage: () => storedSnapshot,
    getCurrentGameId: () => selectedGame.internalGameId || "",
    normalizePlayerKey: (value) => String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "")
  });
  const names = [
    "normalizeRosterSnapshot",
    "normalizeRosterEntries",
    "createRosterEntryKey",
    "canUseRosterSnapshot",
    "getGameDayRosterTargetInternalGameId",
    "getRosterSnapshotForCurrentGame",
    "rosterEntryMatchesPlayer",
    "hasUsablePublicRosterForCurrentGame",
    "isPlayerInCurrentRoster",
    "isRegisteredFielderCandidate"
  ];
  vm.runInContext(`${names.map(getScriptFunctionSource).join("\n")}; this.helpers = { isPlayerInCurrentRoster, isRegisteredFielderCandidate };`, context);
  return context.helpers;
}

test("freshなV3 roster snapshotは公示変更なしでも通常画面候補として返す", () => {
  const response = buildPublicGameDayRosterResponse({
    internalGameId,
    gameDate,
    snapshot: snapshot()
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "captured");
  assert.equal(response.displayRosterSource, "fresh_snapshot");
  assert.equal(response.playerCount, 2);
  assert.deepEqual(response.players.map((player) => player.name), ["登録選手", "継続選手"]);
  assert.equal("source" in response, false);
});

test("矢澤は投手sourceでも出場候補、山﨑福也は特殊DHとしてその他に分類する", () => {
  const { isRegisteredFielderCandidate } = createRosterFilterHelpers({
    players: [{ name: "矢澤宏太", number: "12", position: "投手" }, { name: "山﨑福也", number: "18", position: "投手" }]
  });
  assert.equal(isRegisteredFielderCandidate({
    name: "矢澤宏太",
    uniformNumber: "12",
    registeredPosition: "投手",
    isBatterCandidate: true,
    predictionCandidateRole: "fielder"
  }), true);
  assert.equal(isRegisteredFielderCandidate({
    name: "山﨑福也",
    uniformNumber: "18",
    registeredPosition: "投手",
    isBatterCandidate: true,
    predictionCandidateRole: "special_dh"
  }), false);
});

test("当日公示前は直近7日以内の同一球団snapshotを安全なbaselineとして返す", () => {
  const baselineSnapshot = snapshot({
    internal_game_id: "35ae1388-02f9-43d3-8643-79acac3cbd34",
    game_date: "2026-08-08",
    captured_at: "2026-08-09T03:12:10.291Z"
  });
  assert.equal(isPublicRosterBaselineCandidate(baselineSnapshot, {
    now: new Date("2026-08-10T00:00:00.000Z")
  }), true);
  const response = buildPublicBaselineRosterResponse({
    internalGameId,
    gameDate: "2026-08-11",
    snapshot: baselineSnapshot,
    usableUntil: "2026-08-11T04:00:00.000Z",
    now: new Date("2026-08-10T00:00:00.000Z")
  });
  assert.equal(response.status, "baseline");
  assert.equal(response.displayRosterSource, "latest_official_snapshot");
  assert.equal(response.usableUntil, "2026-08-11T04:00:00.000Z");
  assert.equal(response.playerCount, 2);
});

test("7日を超えたsnapshotや不明なsnapshotはbaselineとして公開しない", () => {
  const oldSnapshot = snapshot({ captured_at: "2026-08-01T03:12:10.291Z" });
  const unknownSnapshot = snapshot({ source: "manual", captured_at: "2026-08-09T03:12:10.291Z" });
  const now = new Date("2026-08-10T00:00:00.000Z");
  assert.equal(isPublicRosterBaselineCandidate(oldSnapshot, { now }), false);
  assert.equal(isPublicRosterBaselineCandidate(unknownSnapshot, { now }), false);
  assert.equal(buildPublicBaselineRosterResponse({ internalGameId, gameDate, snapshot: oldSnapshot }).status, "pending");
});

test("別試合・別日・staleなsnapshotは通常画面候補へ流用しない", () => {
  for (const invalidSnapshot of [
    snapshot({ internal_game_id: "35ae1388-02f9-43d3-8643-79acac3cbd34" }),
    snapshot({ game_date: "2026-08-08" }),
    snapshot({ captured_at: "2026-08-08T03:12:10.291Z" })
  ]) {
    const response = buildPublicGameDayRosterResponse({ internalGameId, gameDate, snapshot: invalidSnapshot });
    assert.equal(response.status, "pending");
    assert.equal(response.playerCount, 0);
    assert.deepEqual(response.players, []);
  }
});

test("通常画面は選択試合のUUIDでV3 snapshotを再取得し、旧game_id行を参照しない", () => {
  assert.match(script, /function getGameDayRosterTargetInternalGameId\(\)/);
  assert.match(script, /api\/game-day-roster\?internalGameId=/);
  assert.match(script, /initializeRosterCandidateSync\(\)/);
  assert.match(script, /snapshot\.internalGameId !== internalGameId/);
  assert.match(script, /snapshot\.gameDate !== gameDate/);
  assert.match(worker, /WHERE internal_game_id = \?1\s*\n\s*ORDER BY updated_at DESC, captured_at DESC/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleGetGameDayRoster"), worker.indexOf("function getGameTeamCodes")), /WHERE game_id = \?1/);
});

test("同じcanonical UUIDのroster responseを受けると公開候補の再描画へ反映する", async () => {
  const context = vm.createContext({ window: { Starting9Public: {} } });
  vm.runInContext(publicRoster, context);
  const renderedNames = [];
  const state = {
    predictionTargetGame: { internalGameId, date: gameDate },
    publicRoster: { internalGameId: "", gameDate: "", status: "pending", players: [] }
  };
  let requestId = 0;
  const controller = context.window.Starting9Public.createPublicRosterController({
    state,
    requestGuard: {
      begin: () => ({ id: ++requestId, signal: undefined }),
      isCurrent: (_name, id) => id === requestId
    },
    getTargetInternalGameId: () => internalGameId,
    getRosterRequestId: () => requestId,
    setRosterRequestId: () => {},
    syncPublicAppState: () => {},
    renderPicker: () => renderedNames.push(...state.publicRoster.players.map((player) => player.name)),
    renderPredictionDeadline: () => {},
    fetchGameDayRosterSnapshot: async (requestedId) => ({
      ok: true,
      internalGameId: requestedId,
      gameDate,
      status: "captured",
      players: [{ name: "公開候補選手", number: "12", position: "外野手" }]
    }),
    normalizeRosterEntries: (players) => players,
    storage: { save: () => {} },
    storageKeys: { rosterSnapshot: "roster" },
    hasUsablePublicRosterForCurrentGame: () => true,
    getPlayerData: () => null,
    isPlayerInCurrentRoster: () => true
  });

  await controller.syncCurrentGameRoster();

  assert.equal(state.publicRoster.internalGameId, internalGameId);
  assert.deepEqual(renderedNames, ["公開候補選手"]);
});

test("source/snapshot mismatchの監査はpublicでもATTENTIONとして扱う", () => {
  const details = JSON.stringify({
    sourceSnapshotComparison: {
      status: "ATTENTION",
      mismatch: true,
      reasonCode: "ROSTER_SOURCE_SNAPSHOT_MISMATCH"
    }
  });
  assert.deepEqual(
    getPublicRosterQualityFromAuditDetails(`[v3_details=${details}]`),
    { attention: true, reasonCode: "ROSTER_SOURCE_SNAPSHOT_MISMATCH" }
  );
  assert.deepEqual(getPublicRosterQualityFromAuditDetails(JSON.stringify({
    sourceSnapshotComparison: { status: "OK", mismatch: false, stale: false }
  })), { attention: false, reasonCode: null });
});

test("captured rosterは警告を解除し、選手一覧を表示する", () => {
  const createElement = (dataset = {}) => ({
    dataset,
    classList: {
      values: new Set(),
      toggle(name, enabled) {
        if (enabled) this.values.add(name);
        else this.values.delete(name);
      }
    },
    setAttribute() {},
    textContent: ""
  });
  const status = createElement();
  const chip = createElement({ picker: "prediction", player: "正式取得選手" });
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === "[data-roster-filter]") return [];
      if (selector === '.player-chip[data-picker="prediction"]') return [chip];
      return [];
    },
    getElementById(id) {
      return id === "predictionRosterStatus" ? status : null;
    }
  };
  const context = vm.createContext({ document: fakeDocument, window: { Starting9Public: {} } });
  vm.runInContext(publicRoster, context);
  const controller = context.window.Starting9Public.createPublicRosterController({
    state: {
      candidateRosterFilter: "active",
      predictionTargetGame: { internalGameId, date: gameDate },
      publicRoster: { internalGameId, gameDate, status: "pending", players: [] }
    },
    hasUsablePublicRosterForCurrentGame: () => true,
    getPlayerData: () => ({ isBatterCandidate: true }),
    isPlayerInCurrentRoster: () => true
  });

  controller.renderPredictionRosterFilter();

  assert.equal(status.textContent, "");
  assert.equal(status.classList.values.has("hidden"), true);
  assert.equal(chip.classList.values.has("hidden"), false);
});

test("最新公式snapshotを翌日targetへ表示するbaselineは強いwarningを出さない", () => {
  const createElement = (dataset = {}) => ({
    dataset,
    classList: {
      values: new Set(),
      toggle(name, enabled) {
        if (enabled) this.values.add(name);
        else this.values.delete(name);
      }
    },
    setAttribute() {},
    textContent: ""
  });
  const status = createElement();
  const chip = createElement({ picker: "prediction", player: "最新公式選手" });
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === "[data-roster-filter]") return [];
      if (selector === '.player-chip[data-picker="prediction"]') return [chip];
      return [];
    },
    getElementById(id) {
      return id === "predictionRosterStatus" ? status : null;
    }
  };
  const context = vm.createContext({ document: fakeDocument, window: { Starting9Public: {} } });
  vm.runInContext(publicRoster, context);
  const controller = context.window.Starting9Public.createPublicRosterController({
    state: {
      candidateRosterFilter: "active",
      publicRoster: {
        status: "baseline",
        displayRosterSource: "latest_official_snapshot",
        players: [{ name: "最新公式選手" }]
      }
    },
    hasUsablePublicRosterForCurrentGame: () => true,
    getPlayerData: () => ({ isBatterCandidate: true }),
    isPlayerInCurrentRoster: () => true
  });

  controller.renderPredictionRosterFilter();

  assert.equal(status.textContent, "");
  assert.equal(status.classList.values.has("hidden"), true);
  assert.equal(chip.classList.values.has("hidden"), false);
});

test("更新待ちでも同一試合の保存済みrosterを暫定表示し、警告を出す", async () => {
  const context = vm.createContext({ window: { Starting9Public: {} } });
  vm.runInContext(publicRoster, context);
  const renderedNames = [];
  const state = {
    candidateRosterFilter: "active",
    predictionTargetGame: { internalGameId, date: gameDate },
    publicRoster: { internalGameId: "", gameDate: "", status: "pending", players: [] }
  };
  let requestId = 0;
  const storedPlayers = [{ name: "前回取得選手", number: "12", position: "外野手" }];
  const controller = context.window.Starting9Public.createPublicRosterController({
    state,
    requestGuard: {
      begin: () => ({ id: ++requestId, signal: undefined }),
      isCurrent: (_name, id) => id === requestId
    },
    getTargetInternalGameId: () => internalGameId,
    getRosterRequestId: () => requestId,
    setRosterRequestId: () => {},
    getRosterSnapshotForCurrentGame: () => ({ internalGameId, gameDate, players: storedPlayers }),
    syncPublicAppState: () => {},
    renderPicker: () => renderedNames.push(...state.publicRoster.players.map((player) => player.name)),
    renderPredictionDeadline: () => {},
    fetchGameDayRosterSnapshot: async () => ({ ok: true, internalGameId, gameDate, status: "pending", players: [] }),
    normalizeRosterEntries: (players) => players || [],
    hasUsablePublicRosterForCurrentGame: () => state.publicRoster.status === "stale" && state.publicRoster.players.length > 0,
    getPlayerData: () => null,
    isPlayerInCurrentRoster: () => true
  });

  await controller.syncCurrentGameRoster();

  assert.equal(state.publicRoster.status, "stale");
  assert.deepEqual(state.publicRoster.players, storedPlayers);
  assert.deepEqual(renderedNames, ["前回取得選手", "前回取得選手"]);
  assert.match(publicRoster, /前回取得データの場合があります/);
  assert.match(publicRoster, /選手情報を更新中です/);
});

test("stale fallbackは警告を表示しつつ候補chipを隠さない", () => {
  const createElement = (dataset = {}) => ({
    dataset,
    classList: {
      values: new Set(),
      toggle(name, enabled) {
        if (enabled) this.values.add(name);
        else this.values.delete(name);
      }
    },
    setAttribute() {},
    textContent: "",
    disabled: false
  });
  const activeButton = createElement({ rosterFilter: "active" });
  const inactiveButton = createElement({ rosterFilter: "inactive" });
  const chip = createElement({ picker: "prediction", player: "前回取得選手" });
  const status = createElement();
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === "[data-roster-filter]") return [activeButton, inactiveButton];
      if (selector === '.player-chip[data-picker="prediction"]') return [chip];
      return [];
    },
    getElementById(id) {
      return id === "predictionRosterStatus" ? status : null;
    }
  };
  const context = vm.createContext({ document: fakeDocument, window: { Starting9Public: {} } });
  vm.runInContext(publicRoster, context);
  const controller = context.window.Starting9Public.createPublicRosterController({
    state: {
      candidateRosterFilter: "active",
      publicRoster: { status: "stale", players: [{ name: "前回取得選手" }] }
    },
    hasUsablePublicRosterForCurrentGame: () => true,
    getPlayerData: () => ({ isBatterCandidate: true }),
    isPlayerInCurrentRoster: () => true
  });

  controller.renderPredictionRosterFilter();

  assert.equal(chip.classList.values.has("hidden"), false);
  assert.equal(status.classList.values.has("hidden"), false);
  assert.match(status.textContent, /前回取得データの場合があります/);
});

test("公開試合カタログ確定後にbaseline roster取得を再実行し、初期化競合で更新中に固定されない", () => {
  const catalogStart = script.indexOf("async function initializePublicGameCatalog");
  const catalogEnd = script.indexOf("function isPublicGamePublished", catalogStart);
  const catalog = script.slice(catalogStart, catalogEnd);
  const targetStart = script.indexOf("async function refreshPredictionTarget");
  const targetEnd = script.indexOf("async function resolvePredictionTargetGame", targetStart);
  const target = script.slice(targetStart, targetEnd);

  assert.doesNotMatch(catalog, /void initializeRosterCandidateSync\(\);/);
  assert.match(publicCoordinator, /const rosterPromise = ops\.initializeRosterCandidateSync\(\);/);
  assert.match(target, /void initializeRosterCandidateSync\(\);/);
  assert.match(script, /let publicRosterSyncRequestId = 0;/);
  assert.match(publicRoster, /requestId !== deps\.getRosterRequestId\(\)/);
});

test("snapshotの登録選手は候補に入り、抹消選手は候補から外れる既存フィルタを維持する", async () => {
  const helpers = await import(pathToFileURL(path.join(root, "game-automation-v3.js")).href);
  const fresh = helpers.getV3RosterSnapshotFreshness(snapshot(), { internalGameId, gameDate });
  assert.equal(fresh.isFresh, true);
  assert.equal(fresh.isStale, false);
  const filter = createRosterFilterHelpers({
    internalGameId,
    gameDate,
    players: [{ name: "登録選手", number: "12", position: "外野手" }]
  });
  assert.equal(filter.isPlayerInCurrentRoster({ name: "登録選手", uniformNumber: "12", isActiveRoster: false }), true);
  assert.equal(filter.isPlayerInCurrentRoster({ name: "抹消選手", uniformNumber: "53", isActiveRoster: true }), false);
  assert.match(publicRoster, /isRegisteredFielderCandidate/);
  assert.match(publicRoster, /!isRegisteredFielderCandidate\(player\) && player\?\.isBatterCandidate === true/);
});

test("freshなcanonical rosterがない場合は静的isActiveRosterを候補へ戻さない", () => {
  const context = vm.createContext({
    state: {
      isAdminMode: false,
      predictionTargetGame: { internalGameId, date: gameDate },
      probableStarter: { nextGame: null },
      publicRoster: { internalGameId, gameDate, status: "pending", players: [] }
    },
    STORAGE_KEYS: { rosterSnapshot: "roster" },
    loadFromStorage: () => ({ players: [] }),
    getCurrentGameId: () => internalGameId,
    normalizePlayerKey: (value) => String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "")
  });
  const names = [
    "normalizeRosterSnapshot",
    "normalizeRosterEntries",
    "createRosterEntryKey",
    "canUseRosterSnapshot",
    "getGameDayRosterTargetInternalGameId",
    "getRosterSnapshotForCurrentGame",
    "rosterEntryMatchesPlayer",
    "hasUsablePublicRosterForCurrentGame",
    "isPlayerInCurrentRoster"
  ];
  vm.runInContext(`${names.map(getScriptFunctionSource).join("\n")}; this.result = isPlayerInCurrentRoster({ name: "古い選手", uniformNumber: "1", isActiveRoster: true });`, context);
  assert.equal(context.result, false);
  assert.match(publicRoster, /選手情報を更新中です/);
});

test("baselineは利用期限前だけ通常画面の候補として扱う", () => {
  const filter = createRosterFilterHelpers(
    { players: [{ name: "基準選手", number: "12", position: "外野手" }] },
    { internalGameId, date: gameDate },
    "baseline",
    "2099-01-01T00:00:00.000Z"
  );
  assert.equal(filter.isPlayerInCurrentRoster({ name: "基準選手", uniformNumber: "12", isActiveRoster: false }), true);
  assert.match(publicRoster, /gameSnapshot\.status === "baseline"/);
  assert.match(publicRoster, /usableUntil/);
});

test("fresh取得が遅延してもbaselineは予想締切まで利用できる", () => {
  const targetGame = {
    start_time: "2026-08-11T05:00:00.000Z"
  };
  const beforeDeadline = new Date("2026-08-11T03:12:00.000Z");
  assert.equal(
    getPublicRosterBaselineUsableUntil(targetGame, { now: beforeDeadline }),
    "2026-08-11T04:00:00.000Z"
  );
  const baselineSnapshot = snapshot({
    internal_game_id: "35ae1388-02f9-43d3-8643-79acac3cbd34",
    game_date: "2026-08-08",
    captured_at: "2026-08-09T03:12:10.291Z"
  });
  const response = buildPublicBaselineRosterResponse({
    internalGameId,
    gameDate: "2026-08-11",
    snapshot: baselineSnapshot,
    usableUntil: getPublicRosterBaselineUsableUntil(targetGame, { now: beforeDeadline }),
    now: beforeDeadline
  });
  assert.equal(response.status, "baseline");
  assert.equal(response.playerCount, 2);
  assert.equal(response.usableUntil, "2026-08-11T04:00:00.000Z");
});

test("予想締切後は期限切れbaselineを公開対象へ戻さない", () => {
  assert.equal(
    getPublicRosterBaselineUsableUntil(
      { start_time: "2026-08-11T05:00:00.000Z" },
      { now: new Date("2026-08-11T04:00:00.000Z") }
    ),
    null
  );
});

test("公開rosterのbaseline判定はroster取得slotではなく予想締切を基準にする", () => {
  const handlerStart = worker.indexOf("async function handleGetGameDayRoster");
  const handlerEnd = worker.indexOf("function getPublicRosterPlayers", handlerStart);
  const handler = worker.slice(handlerStart, handlerEnd);
  assert.match(handler, /getPublicRosterBaselineUsableUntil\(game, \{ now \}\)/);
  assert.match(handler, /usableUntil: baselineUsableUntil/);
  assert.doesNotMatch(handler, /usableUntil: schedule\.rosterFetchAt1/);
});
