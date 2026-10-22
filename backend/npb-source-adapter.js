import { extractNpbOrderText, extractScheduleGames, extractTeamRoster, parseStarterPage } from "../cloudflare-worker.js";
import { normalizeAllNpbScheduleGames, normalizeScheduleTeamCode } from "../game-schedule-detection.js";

const GAME_CODE_PATTERN = /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// External sources use slightly different spellings for terminal game
// outcomes. Keep the source-specific vocabulary at this boundary so the V3
// planner only ever receives the canonical values used by the existing
// eligibility and publication gates.
export function normalizeExternalGameStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw.replace(/[\s-]+/g, "_");
  if (["canceled", "cancelled"].includes(normalized)) return "cancelled";
  if (["no_game", "nogame", "no_game_confirmed"].includes(normalized)) return "no_game";
  return normalized;
}

export function classifyExternalGameStatus(value) {
  const normalized = normalizeExternalGameStatus(value);
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "no_game") return "no_game";
  if (["scheduled", "live", "final", "completed", "postponed", "service_unavailable"].includes(normalized)) return "normal";
  return "unknown";
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedEnvironment(env) {
  return String(env?.ENVIRONMENT || env?.APP_ENV || env?.NODE_ENV || "").trim().toLowerCase();
}

export function isProductionNpbEnvironment(env = {}) {
  const environment = normalizedEnvironment(env);
  return environment === "production" || environment === "prod"
    || String(env?.ENABLE_DEVELOPMENT_MODE || "").trim().toLowerCase() === "false";
}

function simulatorAllowedInEnvironment(env = {}) {
  if (isProductionNpbEnvironment(env)) return false;
  const environment = normalizedEnvironment(env);
  return String(env?.ENABLE_DEVELOPMENT_MODE || "").trim().toLowerCase() === "true"
    || ["development", "dev", "test", "local"].includes(environment);
}

export function resolveNpbSource(env = {}) {
  const requested = String(env?.NPB_SOURCE || "official").trim().toLowerCase();
  if (requested !== "simulator") return { kind: "official", requested, guarded: false, reason: "default_or_official" };
  if (!simulatorAllowedInEnvironment(env)) {
    return { kind: "official", requested, guarded: true, reason: "simulator_requires_non_production_environment" };
  }
  return { kind: "simulator", requested, guarded: false, reason: "development_or_test_configuration" };
}

export function normalizeSimulatorBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw adapterError("SIMULATOR_BASE_URL_MISSING", "S9simu base URL is not configured.");
  let parsed;
  try { parsed = new URL(raw); } catch { throw adapterError("SIMULATOR_BASE_URL_INVALID", "S9simu base URL is invalid."); }
  const host = parsed.hostname.toLowerCase();
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!((parsed.protocol === "https:") || (parsed.protocol === "http:" && localHost))) {
    throw adapterError("SIMULATOR_BASE_URL_NOT_ALLOWED", "S9simu base URL host is not allowed.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw adapterError("SIMULATOR_BASE_URL_NOT_ORIGIN", "S9simu base URL must be an origin without path or query.");
  }
  return parsed.origin;
}

function normalizedGameCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return GAME_CODE_PATTERN.test(code) ? code : "";
}

export function buildSimulatorSourceUrl(baseUrl, params = {}) {
  const origin = normalizeSimulatorBaseUrl(baseUrl);
  const mode = String(params.mode || "").trim().toLowerCase();
  if (mode === "starter") return `${origin}/simu-npb/announcement/starter/`;
  if (mode === "schedule") {
    const date = String(params.date || params.gameDate || "").trim();
    if (!DATE_PATTERN.test(date)) throw adapterError("SIMULATOR_DATE_INVALID", "S9simu schedule date is invalid.");
    const url = new URL(`${origin}/simu-npb/api/public/games`);
    url.searchParams.set("date", date);
    url.searchParams.set("team", String(params.team || "fighters"));
    return url.href;
  }
  if (mode === "roster") {
    const team = String(params.team || "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(team)) throw adapterError("SIMULATOR_TEAM_INVALID", "S9simu roster team is invalid.");
    return `${origin}/simu-npb/announcement/roster/${encodeURIComponent(team)}/`;
  }
  if (mode === "lineup" || mode === "score") {
    const date = String(params.date || params.gameDate || "").trim();
    const gameCode = normalizedGameCode(params.gameCode || params.npbGameCode);
    if (!DATE_PATTERN.test(date) || !gameCode) throw adapterError("SIMULATOR_GAME_ID_INVALID", "S9simu game identity is invalid.");
    const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const url = new URL(`${origin}/simu-npb/scores/${year}/${month}${day}/${encodeURIComponent(gameCode)}/`);
    if (mode === "lineup" && params.team) url.searchParams.set("team", String(params.team));
    return url.href;
  }
  throw adapterError("SIMULATOR_MODE_UNSUPPORTED", `S9simu does not support mode: ${mode || "unknown"}.`);
}

export async function fetchSimulatorSource(env, params, { fetchImpl = globalThis.fetch, signal } = {}) {
  const url = buildSimulatorSourceUrl(env?.S9SIMU_BASE_URL, params);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/html, application/json", "Cache-Control": "no-store" },
    signal
  });
  return { response, url };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function textContent(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/[\s\u3000]+/g, " ").trim();
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(tag.match(new RegExp(`\\bdata-${escaped}=["']([^"']*)["']`, "i"))?.[1] || "");
}

function parseStarterHtml(html) {
  const parsed = parseStarterPage(html);
  if (!parsed.date && !parsed.games.length) {
    const legacyArticles = String(html || "").match(/<article\b[^>]*data-game-code=["'][^"']+["'][\s\S]*?<\/article>/gi) || [];
    if (!legacyArticles.length && !String(html || "").includes("予告先発")) {
      return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_starter_html" };
    }
    parsed.games = legacyArticles.map((article) => {
      const homeStarter = textContent(article.match(/<dt>\s*Home\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i)?.[1] || "");
      const awayStarter = textContent(article.match(/<dt>\s*Away\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i)?.[1] || "");
      return {
        date: attribute(article, "game-date"),
        gameCode: attribute(article, "game-code"),
        npbGameCode: attribute(article, "game-code"),
        homeTeam: attribute(article, "home-team"),
        awayTeam: attribute(article, "away-team"),
        gameStatus: normalizeExternalGameStatus(attribute(article, "game-status")),
        homeStarter: { name: homeStarter === "未発表" ? "" : homeStarter },
        awayStarter: { name: awayStarter === "未発表" ? "" : awayStarter }
      };
    });
  }
  return { ok: true, payload: { ok: true, games: parsed.games, date: parsed.date, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
}

function parseLineupTable(table) {
  const rows = String(table || "").match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  return rows.map((row) => ({
    order: Number(attribute(row, "batting-order")),
    playerId: attribute(row, "player-id"),
    playerName: attribute(row, "player-name"),
    // S9simu uses P for its ninth demo slot. Starting9's canonical batting
    // shape has no pitcher slot, so decode that simulator-only label as DH.
    position: attribute(row, "position") === "P" ? "指" : attribute(row, "position"),
    uniformNumber: attribute(row, "jersey-number")
  })).filter((row) => Number.isInteger(row.order) && row.order > 0 && row.playerName);
}

function parseLineupHtml(html, params = {}) {
  const root = String(html || "").match(/<div\b[^>]*data-game-code=["'][^"']+["'][^>]*>/i)?.[0] || "";
  if (!root && String(html || "").trim()) {
    return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_lineup_html" };
  }
  const seriesNumber = Number(attribute(String(html || "").match(/data-series-number=["'][^"']+["']/i)?.[0] || "", "series-number"));
  const metadata = {
    gameCode: attribute(root, "game-code"),
    date: attribute(root, "game-date"),
    homeTeam: attribute(root, "home-team"),
    awayTeam: attribute(root, "away-team"),
    seriesNumber: Number.isInteger(seriesNumber) && seriesNumber > 0 ? seriesNumber : null,
    startAt: attribute(root, "start-at") || attribute(root, "start-time") || ""
  };
  const gameStatus = normalizeExternalGameStatus(attribute(root, "game-status"));
  const requestedTeam = String(params.team || "fighters").trim().toLowerCase();
  const extracted = extractNpbOrderText(html, requestedTeam);
  const lineup = extracted.lineupText ? extracted.rows.map((row) => ({
    order: row.order,
    playerName: row.player,
    position: row.position
  })) : parseLineupTable(String(html || "").match(new RegExp(`<table\\b[^>]*data-lineup-team=["']${requestedTeam}["'][^>]*>[\\s\\S]*?<\\/table>`, "i"))?.[0] || "");
  if (!lineup.length && ["cancelled", "no_game"].includes(gameStatus)) {
    return { ok: true, payload: { ok: true, ...metadata, lineup: [], status: gameStatus, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
  }
  if (!lineup.length) return { ok: false, code: "LINEUP_NOT_PUBLISHED", parseStage: "simulator_lineup_html", gameStatus };
  return { ok: true, payload: { ok: true, ...metadata, lineup, status: gameStatus, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
}

function parseScoreHtml(html) {
  const root = String(html || "").match(/<div\b[^>]*data-game-code=["'][^"']+["'][^>]*>/i)?.[0] || "";
  if (!root) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_score_html" };
  const seriesTag = String(html || "").match(/data-series-number=["'][^"']+["']/i)?.[0] || "";
  const seriesNumber = Number(attribute(seriesTag, "series-number"));
  return {
    ok: true,
    payload: {
      ok: true,
      gameCode: attribute(root, "game-code"),
      date: attribute(root, "game-date"),
      homeTeam: attribute(root, "home-team"),
      awayTeam: attribute(root, "away-team"),
      seriesNumber: Number.isInteger(seriesNumber) && seriesNumber > 0 ? seriesNumber : null,
      status: normalizeExternalGameStatus(attribute(root, "game-status")),
      sourceUrl: "simulator",
      fetchedAt: new Date().toISOString()
    }
  };
}

function parseScheduleJson(text, params = {}) {
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_schedule_json" }; }
  if (!Array.isArray(body?.games)) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_schedule_json" };
  const requestedDate = String(params.date || params.gameDate || "").trim();
  const extracted = body.games.map((game) => {
    const { replacementGame: _replacementGame, replacement_game_id: _replacementGameId, ...sourceGame } = game || {};
    const replacementGameId = String(_replacementGame?.gameId || _replacementGameId || game?.replacementGameId || "").trim();
    const gameDate = String(game?.gameDate || game?.date || requestedDate);
    const gameCode = String(game?.npbGameCode || game?.gameCode || "").trim().toLowerCase();
    const startAt = String(game?.startAt || game?.startTime || "");
    const startTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startAt)
      ? startAt
      : /T((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d)?(?:[.+-]|$)/.exec(startAt)?.[1] || "";
    return {
      ...sourceGame,
      // Formal sync requires a stable row ID, while replacement discovery
      // relies on the provider's original external ID when it supplies one.
      gameId: String(game?.gameId || (gameCode ? `${gameDate}-${gameCode}` : "")),
      date: gameDate,
      gameCode,
      npbGameUrl: gameCode ? `simulator:${gameCode}` : "",
      startTime,
      homeTeam: normalizeScheduleTeamCode(game?.homeTeam || game?.homeTeamId),
      awayTeam: normalizeScheduleTeamCode(game?.awayTeam || game?.awayTeamId),
      status: normalizeExternalGameStatus(game.status || game.gameStatus || game.game_status),
      venue: String(game?.venue || ""),
      replacementGameId: replacementGameId || null
    };
  });
  const parsed = extracted.filter((game) => game.gameId && (!requestedDate || game.date === requestedDate)
    && game.homeTeam && game.awayTeam && game.startTime && game.gameCode);
  const team = String(params.team || "all").trim().toLowerCase();
  const requestedTeam = normalizeScheduleTeamCode(team);
  const filtered = team === "all" ? parsed
    : requestedTeam ? parsed.filter((game) => game.homeTeam === requestedTeam || game.awayTeam === requestedTeam) : [];
  const games = filtered.map((game) => ({
    ...game,
    gameDate: game.date,
    npbGameCode: game.gameCode,
    npbGameUrl: game.gameCode ? `simulator:${game.gameCode}` : "",
    startAt: `${game.date}T${game.startTime}:00+09:00`
  }));
  return {
    ok: true,
    payload: {
      ok: true,
      games,
      scheduleDiagnostics: {
        rawGamesCount: body.games.length,
        parsedGamesCount: parsed.length,
        filteredGamesCount: filtered.length,
        normalizedGamesCount: games.length
      },
      fetchedAt: new Date().toISOString(),
      sourceUrl: "simulator"
    }
  };
}

function parseScheduleHtml(html, params = {}) {
  const date = String(params.date || params.gameDate || "").trim();
  const extracted = extractScheduleGames(String(html || ""), date);
  if (!Array.isArray(extracted)) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_schedule_html" };
  const team = String(params.team || "fighters").trim().toLowerCase();
  const normalizedAll = normalizeAllNpbScheduleGames(extracted, date);
  const requestedTeam = normalizeScheduleTeamCode(team);
  const filtered = team === "all" ? normalizedAll
    : requestedTeam ? normalizedAll.filter((game) => game.homeTeam === requestedTeam || game.awayTeam === requestedTeam) : [];
  const normalized = filtered.map((game) => ({
    ...game,
    gameDate: date,
    npbGameCode: game.gameCode,
    npbGameUrl: game.gameCode ? `simulator:${game.gameCode}` : "",
    startAt: `${date}T${game.startTime}:00+09:00`
  }));
  return {
    ok: true,
    payload: {
      ok: true,
      games: normalized,
      scheduleDiagnostics: {
        rawGamesCount: extracted.length,
        parsedGamesCount: normalizedAll.length,
        filteredGamesCount: filtered.length,
        normalizedGamesCount: normalized.length
      },
      fetchedAt: new Date().toISOString(),
      sourceUrl: "simulator"
    }
  };
}

function parseRosterHtml(html, params = {}) {
  const team = String(params.team || "").trim().toLowerCase();
  const parsed = extractTeamRoster(String(html || ""), team);
  if (!parsed.players.length) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_roster_html" };
  return {
    ok: true,
    payload: {
      ok: true,
      team,
      players: parsed.players,
      playerCount: parsed.players.length,
      fetchedAt: new Date().toISOString(),
      sourceUrl: "simulator",
      cacheStatus: "miss"
    }
  };
}

export async function parseSimulatorResponse(response, params = {}) {
  const mode = String(params.mode || "").trim().toLowerCase();
  const text = await response.text();
  if (!response.ok) return { ok: false, code: "NPB_HTTP_ERROR", error: "S9simu returned an HTTP error.", httpStatus: response.status };
  if (mode === "schedule") return text.trimStart().startsWith("{") ? parseScheduleJson(text, params) : parseScheduleHtml(text, params);
  if (mode === "roster") return parseRosterHtml(text, params);
  if (mode === "starter") return parseStarterHtml(text);
  if (mode === "score") return parseScoreHtml(text);
  if (mode === "lineup") return parseLineupHtml(text, params);
  return { ok: false, code: "SIMULATOR_MODE_UNSUPPORTED", parseStage: "simulator_response" };
}
