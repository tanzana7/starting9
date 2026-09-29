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
  if (mode === "starter") return `${origin}/announcement/starter/`;
  if (mode === "schedule") return `${origin}/api/public/games`;
  if (mode === "lineup") {
    const date = String(params.date || params.gameDate || "").trim();
    const gameCode = normalizedGameCode(params.gameCode || params.npbGameCode);
    if (!DATE_PATTERN.test(date) || !gameCode) throw adapterError("SIMULATOR_GAME_ID_INVALID", "S9simu game identity is invalid.");
    const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return `${origin}/scores/${year}/${month}${day}/${encodeURIComponent(gameCode)}/`;
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
  const games = [];
  const articles = String(html || "").match(/<article\b[^>]*data-game-code=["'][^"']+["'][\s\S]*?<\/article>/gi) || [];
  for (const article of articles) {
    const homeStarter = textContent(article.match(/<dt>\s*Home\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i)?.[1] || "");
    const awayStarter = textContent(article.match(/<dt>\s*Away\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i)?.[1] || "");
    games.push({
      date: attribute(article, "game-date"),
      gameCode: attribute(article, "game-code"),
      npbGameCode: attribute(article, "game-code"),
      homeTeam: attribute(article, "home-team"),
      awayTeam: attribute(article, "away-team"),
      gameStatus: normalizeExternalGameStatus(attribute(article, "game-status")),
      homeStarter: { name: homeStarter === "未発表" ? "" : homeStarter },
      awayStarter: { name: awayStarter === "未発表" ? "" : awayStarter }
    });
  }
  if (!articles.length && !String(html || "").includes("予告先発")) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_starter_html" };
  return { ok: true, payload: { ok: true, games, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
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

function parseLineupHtml(html) {
  const root = String(html || "").match(/<div\b[^>]*data-game-code=["'][^"']+["'][^>]*>/i)?.[0] || "";
  const gameStatus = normalizeExternalGameStatus(attribute(root, "game-status"));
  const table = String(html || "").match(/<table\b[^>]*data-lineup-team=["']fighters["'][^>]*>[\s\S]*?<\/table>/i)?.[0] || "";
  const lineup = parseLineupTable(table);
  if (!lineup.length && ["cancelled", "no_game"].includes(gameStatus)) {
    return { ok: true, payload: { ok: true, lineup: [], status: gameStatus, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
  }
  if (!lineup.length) return { ok: false, code: "LINEUP_NOT_PUBLISHED", parseStage: "simulator_lineup_html", gameStatus };
  return { ok: true, payload: { ok: true, lineup, status: gameStatus, fetchedAt: new Date().toISOString(), sourceUrl: "simulator" } };
}

function parseScheduleJson(text) {
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_schedule_json" }; }
  if (!Array.isArray(body?.games)) return { ok: false, code: "NPB_RESPONSE_INVALID", parseStage: "simulator_schedule_json" };
  return {
    ok: true,
    payload: {
      ok: true,
      games: body.games.map((game) => {
        const { replacementGame: _replacementGame, replacement_game_id: _replacementGameId, ...sourceGame } = game || {};
        const replacementGameId = String(_replacementGame?.gameId || _replacementGameId || game?.replacementGameId || "").trim();
        return {
          ...sourceGame,
          date: game.gameDate,
          gameCode: game.npbGameCode,
          npbGameUrl: game.npbGameCode ? `simulator:${game.npbGameCode}` : "",
          startTime: game.startAt,
          status: normalizeExternalGameStatus(game.status || game.gameStatus || game.game_status),
          replacementGameId: replacementGameId || null
        };
      }),
      fetchedAt: new Date().toISOString(),
      sourceUrl: "simulator"
    }
  };
}

export async function parseSimulatorResponse(response, params = {}) {
  const mode = String(params.mode || "").trim().toLowerCase();
  const text = await response.text();
  if (!response.ok) return { ok: false, code: "NPB_HTTP_ERROR", error: "S9simu returned an HTTP error.", httpStatus: response.status };
  if (mode === "schedule") return parseScheduleJson(text);
  if (mode === "starter") return parseStarterHtml(text);
  if (mode === "lineup") return parseLineupHtml(text);
  return { ok: false, code: "SIMULATOR_MODE_UNSUPPORTED", parseStage: "simulator_response" };
}
