import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPublicBaselineRosterResponse,
  buildPublicGameDayRosterResponse,
  buildPublicStaleRosterResponse,
  fetchLatestPublicRoster,
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

test("同日V3 roster snapshot単独は公式live確認前の未検証状態として返す", () => {
  const response = buildPublicGameDayRosterResponse({
    internalGameId,
    gameDate,
    snapshot: snapshot()
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "captured");
  assert.equal(response.displayRosterSource, "fresh_snapshot");
  assert.equal(response.sourceOfTruth, "canonical_snapshot");
  assert.equal(response.rosterUse, "none");
  assert.equal(response.freshness, "unverified");
  assert.equal(response.canUseForPrediction, false);
  assert.equal(response.verified, false);
  assert.match(response.warning, /公式liveとの一致確認/);
  assert.equal(response.playerCount, 2);
  assert.deepEqual(response.players.map((player) => player.name), ["登録選手", "継続選手"]);
  assert.equal("source" in response, false);
});

test("公式取得失敗時も同一試合の古いsnapshotはstale警告付きで返す", () => {
  const response = buildPublicStaleRosterResponse({
    internalGameId,
    gameDate,
    snapshot: snapshot({ captured_at: "2026-08-08T03:12:10.291Z" })
  });

  assert.equal(response.status, "stale");
  assert.equal(response.displayRosterSource, "stale_snapshot");
  assert.equal(response.cacheStatus, "game-snapshot-stale");
  assert.equal(response.staleReason, "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE");
  assert.match(response.warning, /前回取得データ/);
  assert.equal(response.playerCount, 2);
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
  assert.equal(response.displayRosterSource, "baseline_snapshot");
  assert.equal(response.sourceOfTruth, "baseline_snapshot");
  assert.equal(response.rosterUse, "baseline_snapshot");
  assert.equal(response.canUseForPrediction, true);
  assert.equal(response.verified, false);
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

test("新鮮なsnapshotがない公開rosterはNPB公式をcache利用でread-only確認し、最新登録を隠さない", () => {
  const handler = worker.slice(worker.indexOf("async function handleGetGameDayRoster(request"), worker.indexOf("async function fetchLatestPublicRoster"));
  const overview = worker.slice(worker.indexOf("async function handleAdminV3Overview"), worker.indexOf("async function handleAdminV3IdentityResolve"));
  assert.match(handler, /fetchLatestPublicRoster\(env, game\)/);
  assert.doesNotMatch(handler, /force:\s*["']1["']/);
  assert.match(overview, /readSharedGameDayRoster\(env, \{/);
  assert.doesNotMatch(overview, /fetchLatestPublicRoster\(env, \{/);
  assert.match(worker, /export async function fetchLatestPublicRoster\(env, game, \{ force = false \} = \{\}\)/);
  assert.match(worker, /displayRosterSource: "latest_official_live"/);
  assert.match(handler, /正式roster_fetchで更新します/);
  assert.match(publicRoster, /\["latest_official_snapshot", "latest_official_live"\]\.includes/);
});

test("game-day-statusも表示用live rosterをcache利用で読み、force bypassを行わない", () => {
  const statusHandler = worker.slice(worker.indexOf("async function handleGetGameDayStatus"), worker.indexOf("async function handleGetGameDayRoster"));
  const statusReader = worker.slice(worker.indexOf("async function getGameDayStatus"), worker.indexOf("export function resolveGameDayResultStatus"));
  assert.match(statusHandler, /getGameDayStatus\(env\.AUTH_DB, identity, env\)/);
  assert.match(statusReader, /fetchLatestPublicRoster\(env, \{/);
  assert.doesNotMatch(statusReader, /fetchLatestPublicRoster\(env, \{[\s\S]{0,240}force:/);
});

test("display用live roster helperはforceなしを既定にし、明示forceだけbypassする", async () => {
  const requestedUrls = [];
  const env = {
    NPB_FETCH_WORKER: {
      fetch: async (request) => {
        requestedUrls.push(new URL(request.url));
        return new Response(JSON.stringify({
          ok: true,
          fetchedAt: "2026-09-08T00:00:00.000Z",
          cacheStatus: requestedUrls.at(-1).searchParams.has("force") ? "bypass" : "hit",
          players: Array.from({ length: 20 }, (_, index) => ({
            name: index === 0 ? "柴田獅子" : `選手${index + 1}`,
            number: String(index + 1),
            position: index === 0 ? "投手" : "内野手"
          }))
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  };
  const game = { internal_game_id: internalGameId, game_date: gameDate };
  const normal = await fetchLatestPublicRoster(env, game);
  const forced = await fetchLatestPublicRoster(env, game, { force: true });
  assert.equal(normal.cacheStatus, "hit");
  assert.equal(forced.cacheStatus, "bypass");
  assert.equal(requestedUrls[0].searchParams.has("force"), false);
  assert.equal(requestedUrls[1].searchParams.get("force"), "1");
  assert.equal(normal.players[0].name, "柴田獅子");
});

test("同日snapshotが古い場合も公式liveとfingerprint比較して候補を返す", () => {
  const handler = worker.slice(worker.indexOf("async function handleGetGameDayRoster(request"), worker.indexOf("export function getPublicRosterQualityFromAuditDetails"));
  assert.match(handler, /fetchLatestPublicRoster\(env, game\)/);
  assert.match(handler, /compareV3RosterSourceSnapshot/);
  assert.match(handler, /sourceSnapshotComparison/);
  assert.match(handler, /正式roster_fetchで更新します/);
});

test("大塚瑠晏はplayer masterと公式背番号49で内野手候補として解決できる", () => {
  const players = fs.readFileSync(path.join(root, "players.js"), "utf8");
  const master = fs.readFileSync(path.join(root, "fighters-player-master.js"), "utf8");
  assert.match(players, /name: "大塚瑠晏"[\s\S]*uniformNumber: "49"[\s\S]*registeredPosition: "内野手"[\s\S]*isBatterCandidate: true[\s\S]*isActiveRoster: true/);
  assert.match(master, /\["大塚瑠晏","49",\["大塚","大塚瑠晏"\]\]/);
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
    syncPublicAppState: () => {},
    renderPicker: () => renderedNames.push(...state.publicRoster.players.map((player) => player.name)),
    renderPredictionDeadline: () => {},
    fetchGameDayRosterSnapshot: async (requestedId) => ({
      ok: true,
      internalGameId: requestedId,
      gameDate,
      status: "captured",
      sourceOfTruth: "official_live",
      rosterUse: "official_live",
      canUseForPrediction: true,
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

test("別試合の公式snapshotをbaseline表示する場合は更新確認のwarningを出す", () => {
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
        displayRosterSource: "baseline_snapshot",
        players: [{ name: "最新公式選手" }]
      }
    },
    hasUsablePublicRosterForCurrentGame: () => true,
    getPlayerData: () => ({ isBatterCandidate: true }),
    isPlayerInCurrentRoster: () => true
  });

  controller.renderPredictionRosterFilter();

  assert.match(status.textContent, /前回取得データの場合があります/);
  assert.equal(status.classList.values.has("hidden"), false);
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
  assert.deepEqual(renderedNames, ["前回取得選手"]);
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
  assert.match(publicCoordinator, /void ops\.initializePublicGameCatalog\(\)\s*\.then\([\s\S]*ops\.initializeRosterCandidateSync\(\)/);
  assert.match(target, /void initializeRosterCandidateSync\(\);/);
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
