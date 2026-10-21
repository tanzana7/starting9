import { normalizeAllNpbScheduleGames, normalizeFightersScheduleGames, normalizeTargetTeamScheduleGames } from "./game-schedule-detection.js";
import teamContext from "./frontend/shared/team-context.js";

const LINEUP_SIZE = 9;
const LINEUP_CACHE_TTL_SECONDS = 5 * 60;
const ROSTER_CACHE_TTL_SECONDS = 30 * 60;
const NPB_FETCH_TIMEOUT_MS = 12_000;
const NPB_USER_AGENT = "Starting9/1.0 (+https://starting9-app.pages.dev/contact.html; non-commercial fan-made lineup prediction service)";
const EXTERNAL_FETCH_DISABLED_MESSAGE = "公式情報の取得を一時停止しています。";
const NOTICE_SOURCE_URL = "https://npb.jp/announcement/roster/";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://starting9.pages.dev",
  "https://starting9-app.pages.dev",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
];
const CORS_BASE_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const NPB_SCORE_PATH_PATTERN = /^\/scores\/(\d{4})\/(\d{2})(\d{2})\/([a-z0-9]+-[a-z0-9]+-\d+)\/$/i;
const LINEUP_ERROR_MESSAGES = {
  GAME_NOT_FOUND: "対象試合を特定できませんでした。",
  GAME_CANCELLED: "NPB公式でこの試合の中止が確認されました。",
  EXTERNAL_FETCH_DISABLED: "公式情報の取得を一時停止しています。",
  NPB_HTTP_ERROR: "NPB公式ページを取得できませんでした。",
  WORKER_FETCH_FAILED: "NPB公式ページへの接続に失敗しました。",
  TIMEOUT: "NPB公式ページの取得がタイムアウトしました。",
  LINEUP_NOT_PUBLISHED: "スタメンはまだ発表されていません。",
  PARSE_FAILED: "NPB公式ページからスタメンを解析できませんでした。",
  INVALID_LINEUP: "取得したスタメンの内容を確認できませんでした。"
};
const inFlightNpbFetches = new Map();
const FIGHTERS_TEAM_KEYWORDS = [
  "北海道日本ハムファイターズ",
  "北海道日本ハム",
  "日本ハム",
  "ファイターズ",
  "F"
];
const FIGHTERS_TEXT_KEYWORDS = FIGHTERS_TEAM_KEYWORDS.filter((keyword) => keyword !== "F");
const POSITION_ALIASES = {
  "捕": "捕",
  "C": "捕",
  "キャッチャー": "捕",
  "2": "捕",
  "一": "一",
  "1B": "一",
  "ファースト": "一",
  "3": "一",
  "二": "二",
  "2B": "二",
  "セカンド": "二",
  "4": "二",
  "三": "三",
  "3B": "三",
  "サード": "三",
  "5": "三",
  "遊": "遊",
  "SS": "遊",
  "ショート": "遊",
  "6": "遊",
  "左": "左",
  "LF": "左",
  "レフト": "左",
  "7": "左",
  "中": "中",
  "CF": "中",
  "センター": "中",
  "8": "中",
  "右": "右",
  "RF": "右",
  "ライト": "右",
  "9": "右",
  "指": "指",
  "DH": "指",
  "D": "指",
  "指名打者": "指",
  "0": "指"
};
const PLAYER_ALIASES = {
  "郡司": "郡司裕也",
  "郡司裕也": "郡司裕也",
  "清宮": "清宮幸太郎",
  "清宮幸": "清宮幸太郎",
  "清宮幸太郎": "清宮幸太郎",
  "万波": "万波中正",
  "万波中": "万波中正",
  "万波中正": "万波中正",
  "田宮": "田宮裕涼",
  "田宮裕": "田宮裕涼",
  "田宮裕涼": "田宮裕涼",
  "進藤": "進藤勇也",
  "進藤勇": "進藤勇也",
  "進藤勇也": "進藤勇也",
  "細川": "細川凌平",
  "細川凌": "細川凌平",
  "細川凌平": "細川凌平",
  "野村": "野村佑希",
  "野村佑": "野村佑希",
  "野村佑希": "野村佑希",
  "水野": "水野達稀",
  "水野達": "水野達稀",
  "水野達稀": "水野達稀",
  "奈良間": "奈良間大己",
  "奈良間大": "奈良間大己",
  "奈良間大己": "奈良間大己",
  "五十幡": "五十幡亮汰",
  "五十幡亮": "五十幡亮汰",
  "五十幡亮汰": "五十幡亮汰",
  "水谷": "水谷瞬",
  "水谷瞬": "水谷瞬",
  "宮崎": "宮崎一樹",
  "宮崎一": "宮崎一樹",
  "宮崎一樹": "宮崎一樹",
  "大塚": "大塚瑠晏",
  "大塚瑠": "大塚瑠晏",
  "大塚瑠晏": "大塚瑠晏",
  "山縣": "山縣秀",
  "山縣秀": "山縣秀",
  "吉田": "吉田賢吾",
  "吉田賢": "吉田賢吾",
  "吉田賢吾": "吉田賢吾",
  "松本": "松本剛",
  "松本剛": "松本剛",
  "マルティネス": "マルティネス",
  "レイエス": "レイエス"
};
const STARTER_SOURCE_URL = "https://npb.jp/announcement/starter/";
const STARTER_TEAM_ALIASES = [
  { key: "fighters", name: "北海道日本ハムファイターズ", aliases: ["北海道日本ハムファイターズ", "北海道日本ハム", "日本ハムファイターズ", "日本ハム"] },
  { key: "buffaloes", name: "オリックス・バファローズ", aliases: ["オリックス・バファローズ", "オリックスバファローズ", "オリックス"] },
  { key: "hawks", name: "福岡ソフトバンクホークス", aliases: ["福岡ソフトバンクホークス", "ソフトバンクホークス", "ソフトバンク"] },
  { key: "lions", name: "埼玉西武ライオンズ", aliases: ["埼玉西武ライオンズ", "西武ライオンズ", "西武"] },
  { key: "eagles", name: "東北楽天ゴールデンイーグルス", aliases: ["東北楽天ゴールデンイーグルス", "楽天ゴールデンイーグルス", "楽天"] },
  { key: "marines", name: "千葉ロッテマリーンズ", aliases: ["千葉ロッテマリーンズ", "ロッテマリーンズ", "ロッテ", "マリーンズ"] },
  { key: "giants", name: "読売ジャイアンツ", aliases: ["読売ジャイアンツ", "巨人"] },
  { key: "tigers", name: "阪神タイガース", aliases: ["阪神タイガース", "阪神"] },
  { key: "baystars", name: "横浜DeNAベイスターズ", aliases: ["横浜DeNAベイスターズ", "横浜DeNA", "DeNA"] },
  { key: "carp", name: "広島東洋カープ", aliases: ["広島東洋カープ", "広島カープ", "広島"] },
  { key: "dragons", name: "中日ドラゴンズ", aliases: ["中日ドラゴンズ", "中日"] },
  { key: "swallows", name: "東京ヤクルトスワローズ", aliases: ["東京ヤクルトスワローズ", "ヤクルトスワローズ", "ヤクルト"] }
];

export default {
  async fetch(request, env) {
    const corsHeaders = createCorsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return withCors(jsonResponse({ ok: false, error: "GETリクエストのみ対応しています。" }, 405), corsHeaders);
    }

    const requestUrl = new URL(request.url);
    const mode = requestUrl.searchParams.get("mode") || "lineup";
    if (String(env?.NPB_FETCH_DISABLED || "").toLowerCase() === "true") {
      return withCors(jsonResponse({
        ok: false,
        code: "EXTERNAL_FETCH_DISABLED",
        error: EXTERNAL_FETCH_DISABLED_MESSAGE,
        source: "npb-public-information"
      }, 503), corsHeaders);
    }
    if (mode === "starter") {
      return withCors(await handleStarterRequest(requestUrl.searchParams.get("debug") === "1"), corsHeaders);
    }
    const isDebug = requestUrl.searchParams.get("debug") === "1";

    if (mode === "roster") {
      return withCors(await handleRosterRequest(requestUrl, isDebug), corsHeaders);
    }
    if (mode === "notice") {
      return withCors(await handleNoticeRequest(requestUrl, isDebug), corsHeaders);
    }
    if (mode === "schedule") {
      return withCors(await handleScheduleRequest(requestUrl), corsHeaders);
    }

    if (mode !== "lineup") {
      return withCors(jsonResponse({ ok: false, error: "対応していない取得モードです。" }, 400), corsHeaders);
    }

    const source = createLineupSourceUrl(requestUrl.searchParams);

    if (!source.ok) {
      return withCors(lineupErrorResponse(source.code || "GAME_NOT_FOUND", 400), corsHeaders);
    }

    const cachedLineup = await getCachedLineup(source);
    if (cachedLineup) {
      return withCors(jsonResponse({ ...cachedLineup, cacheStatus: "hit", stale: false }), corsHeaders);
    }

    let selectedSource = source;
    let upstream = await fetchNpbScorePage(source.url);
    let resolutionDiagnostics = createLineupResolutionDiagnostics(source, upstream);
    if (!upstream.ok) {
      const fallback = await resolveOfficialScorePage(source, upstream);
      resolutionDiagnostics = fallback.diagnostics;
      if (fallback.ok) {
        selectedSource = fallback.source;
        upstream = fallback.upstream;
      }
    }
    if (!upstream.ok) {
      return withCors(lineupErrorResponse(resolutionDiagnostics.errorCode || upstream.code, upstream.status, {
        sourceUrl: source.url,
        diagnostics: resolutionDiagnostics,
        ...(upstream.httpStatus ? { httpStatus: upstream.httpStatus } : {})
      }), corsHeaders);
    }

    const extraction = extractNpbOrderText(upstream.html);
    const cancellation = classifyOfficialCancellationText(upstream.html);
    if (!extraction.lineupText && cancellation.officialCancelled) {
      return withCors(lineupErrorResponse("GAME_CANCELLED", 409, {
        sourceUrl: selectedSource.url,
        diagnostics: resolutionDiagnostics,
        cancellationStatus: "official_cancelled",
        cancellationReason: "NPB公式ページに明示的な中止表示があり、通常のスタメン情報がありません。"
      }), corsHeaders);
    }
    if (!extraction.lineupText) {
      const code = classifyLineupExtractionFailure(extraction);
      return withCors(lineupErrorResponse(code, 422, {
        sourceUrl: selectedSource.url,
        diagnostics: resolutionDiagnostics,
        ...(isDebug ? { debug: createDebugInfo(selectedSource.url, upstream.httpStatus, extraction) } : {})
      }), corsHeaders);
    }

    const responseBody = {
      ok: true,
      sourceUrl: selectedSource.url,
      fetchedAt: new Date().toISOString(),
      date: selectedSource.date,
      gameCode: selectedSource.gameCode,
      method: getExtractionMethod(extraction),
      team: "fighters",
      lineup: extraction.rows.map((row) => ({
        order: row.order,
        position: row.position,
        playerName: row.player
      })),
      lineupText: extraction.lineupText,
      cacheStatus: "miss",
      stale: false,
      diagnostics: resolutionDiagnostics
    };
    await cacheLineupResponse(source, responseBody);
    return withCors(jsonResponse(responseBody), corsHeaders);
  }
};

function createCorsHeaders(request, env) {
  const configuredOrigins = String(env?.NPB_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS);
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers(CORS_BASE_HEADERS);

  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  return headers;
}

async function handleScheduleRequest(requestUrl) {
  const date = String(requestUrl.searchParams.get("date") || "").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ ok: false, code: "SCHEDULE_DATE_INVALID", error: "日程の日付が不正です。" }, 400);
  }
  const requestedTeamKey = requestUrl.searchParams.get("team") || "fighters";
  const allTeams = requestedTeamKey === "all";
  const requestedTeam = allTeams ? null : resolvePilotTeam(requestedTeamKey);
  if (!allTeams && !requestedTeam) {
    return jsonResponse({ ok: false, code: "SCHEDULE_TEAM_UNSUPPORTED", error: "指定された球団の日程には対応していません。" }, 400);
  }
  const [year, month] = date.split("-");
  const sourceUrl = `https://npb.jp/games/${year}/schedule_${month}_detail.html`;
  const upstream = await fetchNpbScorePage(sourceUrl);
  if (!upstream.ok) {
    return jsonResponse({ ok: false, code: "SCHEDULE_FETCH_FAILED", error: "NPB公式日程を取得できませんでした。" }, 502);
  }
  const games = extractScheduleGames(upstream.html, date);
  if (games === null) {
    return jsonResponse({ ok: false, code: "SCHEDULE_PARSE_FAILED", error: "NPB公式日程を解析できませんでした。" }, 422);
  }
  const normalizedGames = (allTeams
    ? normalizeAllNpbScheduleGames(games, date)
    : requestedTeam.key === teamContext.FIGHTERS.key
      ? normalizeFightersScheduleGames(games, date)
      : normalizeTargetTeamScheduleGames(games, date, requestedTeam)).map((game) => ({
    ...game,
    npbGameUrl: buildNpbGameUrl(date, game.gameCode)
  }));
  return jsonResponse({ ok: true, date, sourceUrl, fetchedAt: new Date().toISOString(), games: normalizedGames });
}

function buildNpbGameUrl(date, gameCode) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const normalizedCode = String(gameCode || "").trim().toLowerCase();
  if (!match || !/^[a-z0-9]+-[a-z0-9]+-\d+$/.test(normalizedCode)) return "";
  return `https://npb.jp/scores/${match[1]}/${match[2]}${match[3]}/${normalizedCode}/`;
}

function extractScheduleGames(html, date) {
  if (typeof html !== "string" || !html.includes("試合日程")) return null;
  const result = [];
  const scoreStatuses = extractOfficialScoreStatuses(html, date);
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu) || [];
  const [, monthText, dayText] = String(date).match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  const targetMonth = Number(monthText);
  const targetDay = Number(dayText);
  let activeDateMatches = false;
  for (const row of rows) {
    const text = decodeHtml(row.replace(/<[^>]+>/g, " ")).replace(/[\s\u3000]+/g, " ").trim();
    const dateMatch = /(\d{1,2})\s*[/月]\s*(\d{1,2})/.exec(text);
    if (dateMatch) activeDateMatches = Number(dateMatch[1]) === targetMonth && Number(dateMatch[2]) === targetDay;
    if (!activeDateMatches) continue;
    const unique = extractNpbTeamsFromText(text);
    const time = /\b([01]\d|2[0-3]):[0-5]\d\b/.exec(text)?.[0] || "";
    if (unique.length !== 2 || !time) continue;
    const scoreCode = /\/scores\/\d{4}\/\d{4}\/([a-z0-9]+-[a-z0-9]+-\d+)\//i.exec(row)?.[1] || "";
    const scoreStatus = scoreStatuses.find((item) => item.homeTeam === unique[0] && item.awayTeam === unique[1]);
    result.push({
      homeTeam: unique[0],
      awayTeam: unique[1],
      startTime: time,
      gameCode: scoreCode || scoreStatus?.gameCode || "",
      venue: "",
      status: classifyOfficialCancellationText(text).officialCancelled || scoreStatus?.officialCancelled ? "cancelled" : "scheduled"
    });
  }
  return result;
}

function extractOfficialScoreStatuses(html, date) {
  const dateMatch = /<div\b[^>]*class=["'][^"']*score_box[^"']*date[^"']*["'][^>]*>[\s\S]*?(20\d{2})\s*<br\s*\/?>\s*(\d{1,2})\/(\d{1,2})/i.exec(html);
  if (!dateMatch || `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}` !== String(date)) return [];
  const blocks = html.match(/<a\b[^>]*href=["']\/scores\/\d{4}\/\d{4}\/([a-z0-9]+-[a-z0-9]+-\d+)\/["'][^>]*>[\s\S]*?<\/a>/giu) || [];
  return blocks.map((block) => {
    const gameCode = /href=["']\/scores\/\d{4}\/\d{4}\/([a-z0-9]+-[a-z0-9]+-\d+)\//i.exec(block)?.[1] || "";
    const teamNames = [...block.matchAll(/\b(?:alt|title)=["']([^"']+)["']/giu)].map((match) => match[1]);
    const teams = extractNpbTeamsInDisplayOrder(teamNames);
    return {
      gameCode,
      homeTeam: teams[0] || "",
      awayTeam: teams[1] || "",
      officialCancelled: classifyOfficialCancellationText(block).officialCancelled
    };
  }).filter((item) => item.gameCode && item.homeTeam && item.awayTeam);
}

function withCors(response, corsHeaders) {
  const headers = new Headers(response.headers);
  corsHeaders.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function createLineupSourceUrl(searchParams) {
  const requestedDate = String(searchParams.get("date") || searchParams.get("gameDate") || "").trim();
  const requestedGameCode = String(searchParams.get("gameCode") || "").trim();

  if (requestedDate || requestedGameCode) {
    return attachLineupTargetMetadata(createLineupSourceFromIdentity(requestedDate, requestedGameCode), searchParams);
  }

  // Compatibility path for existing admin bookmarks. It still accepts only a strict NPB score URL.
  const legacyUrl = searchParams.get("url");
  if (!legacyUrl) {
    return { ok: false, code: "GAME_NOT_FOUND" };
  }

  const validation = validateTargetUrl(legacyUrl);
  if (!validation.ok) {
    return { ok: false, code: "GAME_NOT_FOUND" };
  }

  return attachLineupTargetMetadata(createLineupSourceFromIdentity(validation.date, validation.gameCode), searchParams);
}

function attachLineupTargetMetadata(source, searchParams) {
  if (!source?.ok) return source;
  return {
    ...source,
    originalStoredGameCode: source.gameCode,
    homeTeam: String(searchParams.get("homeTeam") || searchParams.get("home_team") || "").trim(),
    awayTeam: String(searchParams.get("awayTeam") || searchParams.get("away_team") || "").trim(),
    startAt: String(searchParams.get("startAt") || searchParams.get("start_at") || "").trim(),
    venue: String(searchParams.get("venue") || searchParams.get("stadium") || "").trim()
  };
}

function createLineupSourceFromIdentity(date, gameCode) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const normalizedGameCode = String(gameCode || "").trim().toLowerCase();

  if (!dateMatch || !/^[a-z0-9]+-[a-z0-9]+-\d+$/.test(normalizedGameCode)) {
    return { ok: false, code: "GAME_NOT_FOUND" };
  }

  const [, year, month, day] = dateMatch;
  const candidateDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidateDate.getUTCFullYear() !== Number(year)
    || candidateDate.getUTCMonth() !== Number(month) - 1
    || candidateDate.getUTCDate() !== Number(day)
  ) {
    return { ok: false, code: "GAME_NOT_FOUND" };
  }

  return {
    ok: true,
    date: `${year}-${month}-${day}`,
    gameCode: normalizedGameCode,
    url: `https://npb.jp/scores/${year}/${month}${day}/${normalizedGameCode}/`
  };
}

async function fetchNpbScorePage(sourceUrl) {
  const upstream = await fetchNpbBody(sourceUrl, { purpose: "score-page" });
  if (!upstream.ok) return { ok: false, code: upstream.code, status: 502, httpStatus: upstream.httpStatus, bodySummary: upstream.bodySummary || null };
  return { ok: true, html: upstream.body, httpStatus: upstream.httpStatus };
}

function createLineupResolutionDiagnostics(source, upstream, overrides = {}) {
  return {
    attemptedUrl: source?.url || null,
    finalSelectedUrl: overrides.finalSelectedUrl || (upstream?.ok ? source?.url || null : null),
    sourceIndexUrl: overrides.sourceIndexUrl || null,
    originalStoredGameCode: source?.originalStoredGameCode || source?.gameCode || null,
    resolvedScorePageCode: overrides.resolvedScorePageCode || (upstream?.ok ? source?.gameCode || null : null),
    originStatus: Number(overrides.originStatus || upstream?.httpStatus || 0) || null,
    fetchWorkerStatus: Number(overrides.fetchWorkerStatus || (upstream?.ok ? 200 : upstream?.status || 0)) || null,
    fallbackUsed: overrides.fallbackUsed === true,
    fallbackCandidateCount: Number.isFinite(Number(overrides.fallbackCandidateCount)) ? Number(overrides.fallbackCandidateCount) : 0,
    fallbackRejectReasons: Array.isArray(overrides.fallbackRejectReasons)
      ? overrides.fallbackRejectReasons.filter((reason) => typeof reason === "string").slice(0, 20)
      : [],
    indexFetchAttempts: Array.isArray(overrides.indexFetchAttempts)
      ? overrides.indexFetchAttempts.slice(0, 4).map((attempt) => ({
        url: typeof attempt?.url === "string" ? attempt.url.slice(0, 240) : null,
        originStatus: Number(attempt?.originStatus || 0) || null,
        fetchWorkerStatus: Number(attempt?.fetchWorkerStatus || 0) || null,
        errorCode: typeof attempt?.errorCode === "string" ? attempt.errorCode.slice(0, 80) : null,
        bodySummary: typeof attempt?.bodySummary === "string" ? attempt.bodySummary.slice(0, 240) : null
      }))
      : [],
    indexFallbackUsed: overrides.indexFallbackUsed === true,
    ...(overrides.errorCode ? { errorCode: overrides.errorCode } : {})
  };
}

function normalizeNpbTeam(value) {
  const raw = String(value || "").replace(/[\s\u3000]/g, "").replace(/[・.]/g, "").toLowerCase();
  if (!raw) return "";
  const exact = STARTER_TEAM_ALIASES.find((team) => team.key === raw);
  if (exact) return exact.key;
  return STARTER_TEAM_ALIASES.find((team) => team.aliases.some((alias) => {
    const normalizedAlias = String(alias).replace(/[\s\u3000]/g, "").replace(/[・.]/g, "").toLowerCase();
    return normalizedAlias === raw || raw.includes(normalizedAlias) || normalizedAlias.includes(raw);
  }))?.key || "";
}

function extractNpbTeamsInDisplayOrder(values) {
  const teams = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const team = normalizeNpbTeam(value);
    if (team && !teams.includes(team)) teams.push(team);
  }
  return teams.slice(0, 2);
}

function extractNpbTeamsFromText(value) {
  const text = String(value || "");
  return STARTER_TEAM_ALIASES
    .map((team) => ({
      key: team.key,
      index: Math.min(...team.aliases.map((alias) => text.indexOf(alias)).filter((index) => index >= 0))
    }))
    .filter((team) => Number.isFinite(team.index))
    .sort((left, right) => left.index - right.index)
    .map((team) => team.key)
    .slice(0, 2);
}

function normalizeNpbVenue(value) {
  return String(value || "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[・.]/g, "")
    .replace(/Ｆ/g, "F")
    .toLowerCase();
}

function formatJstStartTime(startAt) {
  const parsed = new Date(startAt || "");
  if (Number.isNaN(parsed.getTime())) return "";
  const jst = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

function extractOfficialScorePageIdentity(html, date) {
  const pageDateMatch = /<time\b[^>]*>\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/i.exec(String(html || ""));
  const pageDate = pageDateMatch
    ? `${pageDateMatch[1]}-${String(pageDateMatch[2]).padStart(2, "0")}-${String(pageDateMatch[3]).padStart(2, "0")}`
    : "";
  const place = /<span\b[^>]*class=["'][^"']*place[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(String(html || ""));
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(String(html || ""));
  const gameInfo = /◇開始\s*([01]\d|2[0-3]):([0-5]\d)/i.exec(decodeHtml(String(html || "")));
  const teamText = decodeHtml(String(heading?.[1] || "").replace(/<[^>]+>/g, " "));
  const teams = extractNpbTeamsFromText(teamText);
  return {
    date: pageDate,
    homeTeam: teams[0] || "",
    awayTeam: teams[1] || "",
    startTime: gameInfo ? `${gameInfo[1]}:${gameInfo[2]}` : "",
    venue: decodeHtml(String(place?.[1] || "").replace(/<[^>]+>/g, " ")).trim()
  };
}

function scoreCandidateRejectionReasons(candidate, identity, source) {
  const reasons = [];
  if (!identity.date) reasons.push("DATE_UNAVAILABLE");
  else if (identity.date !== source.date) reasons.push("DATE_MISMATCH");
  const expectedHome = normalizeNpbTeam(source.homeTeam);
  const expectedAway = normalizeNpbTeam(source.awayTeam);
  if (expectedHome && identity.homeTeam !== expectedHome) reasons.push("HOME_TEAM_MISMATCH");
  if (expectedAway && identity.awayTeam !== expectedAway) reasons.push("AWAY_TEAM_MISMATCH");
  const expectedStartTime = formatJstStartTime(source.startAt);
  if (expectedStartTime && !identity.startTime) reasons.push("START_TIME_UNAVAILABLE");
  else if (expectedStartTime && identity.startTime !== expectedStartTime) reasons.push("START_TIME_MISMATCH");
  const expectedVenue = normalizeNpbVenue(source.venue);
  if (expectedVenue && !identity.venue) reasons.push("VENUE_UNAVAILABLE");
  else if (expectedVenue && normalizeNpbVenue(identity.venue) !== expectedVenue) reasons.push("VENUE_MISMATCH");
  if (!identity.homeTeam || !identity.awayTeam) reasons.push("TEAMS_UNAVAILABLE");
  return reasons;
}

async function resolveOfficialScorePage(source, initialUpstream = null) {
  const initialOriginStatus = Number(initialUpstream?.httpStatus || 0) || null;
  const initialWorkerStatus = Number(initialUpstream?.status || 0) || null;
  const [year, month, day] = String(source.date || "").split("-");
  const indexUrl = `https://npb.jp/scores/${year}/${month}${day}/`;
  const scheduleIndexUrl = `https://npb.jp/games/${year}/schedule_${month}_detail.html`;
  const indexAttempts = [];
  let index = null;
  let selectedIndexUrl = indexUrl;
  for (const candidateUrl of [indexUrl, scheduleIndexUrl]) {
    const candidate = await fetchNpbScorePage(candidateUrl);
    indexAttempts.push({
      url: candidateUrl,
      originStatus: candidate.httpStatus || null,
      fetchWorkerStatus: candidate.ok ? 200 : candidate.status || null,
      errorCode: candidate.ok ? null : candidate.code || "NPB_HTTP_ERROR",
      bodySummary: candidate.ok ? null : candidate.bodySummary || null
    });
    if (candidate.ok) {
      index = candidate;
      selectedIndexUrl = candidateUrl;
      break;
    }
  }
  if (!index?.ok) {
    return {
      ok: false,
      diagnostics: createLineupResolutionDiagnostics(source, initialUpstream, {
        originStatus: initialOriginStatus,
        fetchWorkerStatus: initialWorkerStatus,
        fallbackUsed: false,
        sourceIndexUrl: indexUrl,
        fallbackRejectReasons: ["SCORE_INDEX_FETCH_FAILED"],
        indexFetchAttempts: indexAttempts
      })
    };
  }
  const candidates = extractOfficialScoreStatuses(index.html, source.date);
  const rejectReasons = [];
  const exactMatches = [];
  const expectedHome = normalizeNpbTeam(source.homeTeam);
  const expectedAway = normalizeNpbTeam(source.awayTeam);
  for (const candidate of candidates) {
    const teamRejectReasons = [];
    if (expectedHome && candidate.homeTeam !== expectedHome) teamRejectReasons.push("HOME_TEAM_MISMATCH");
    if (expectedAway && candidate.awayTeam !== expectedAway) teamRejectReasons.push("AWAY_TEAM_MISMATCH");
    if (teamRejectReasons.length) {
      rejectReasons.push(`${candidate.gameCode}:${teamRejectReasons.join(",")}`);
      continue;
    }
    const candidateSource = createLineupSourceFromIdentity(source.date, candidate.gameCode);
    if (!candidateSource.ok) {
      rejectReasons.push(`${candidate.gameCode}:INVALID_CODE`);
      continue;
    }
    const candidatePage = await fetchNpbScorePage(candidateSource.url);
    if (!candidatePage.ok) {
      rejectReasons.push(`${candidate.gameCode}:HTTP_${candidatePage.httpStatus || 0}`);
      continue;
    }
    const identity = extractOfficialScorePageIdentity(candidatePage.html, source.date);
    const reasons = scoreCandidateRejectionReasons(candidate, identity, source);
    if (reasons.length) {
      rejectReasons.push(`${candidate.gameCode}:${reasons.join(",")}`);
      continue;
    }
    exactMatches.push({ source: { ...candidateSource, originalStoredGameCode: source.originalStoredGameCode }, upstream: candidatePage });
  }
  if (!candidates.length) rejectReasons.push("SCORE_INDEX_NO_CANDIDATES");
  const baseDiagnostics = {
    fallbackUsed: exactMatches.length === 1,
    fallbackCandidateCount: candidates.length,
    fallbackRejectReasons: rejectReasons,
    originStatus: initialOriginStatus,
    fetchWorkerStatus: initialWorkerStatus,
    sourceIndexUrl: selectedIndexUrl,
    indexFetchAttempts: indexAttempts,
    indexFallbackUsed: selectedIndexUrl !== indexUrl
  };
  if (exactMatches.length === 1) {
    return {
      ok: true,
      source: exactMatches[0].source,
      upstream: exactMatches[0].upstream,
      diagnostics: createLineupResolutionDiagnostics(source, exactMatches[0].upstream, {
        ...baseDiagnostics,
        fetchWorkerStatus: 200,
        finalSelectedUrl: exactMatches[0].source.url,
        resolvedScorePageCode: exactMatches[0].source.gameCode
      })
    };
  }
  return {
    ok: false,
    diagnostics: createLineupResolutionDiagnostics(source, null, {
      ...baseDiagnostics,
      errorCode: exactMatches.length > 1 ? "NPB_SCORE_PAGE_AMBIGUOUS" : "NPB_HTTP_ERROR"
    })
  };
}

function shareNpbFetch(key, fetcher) {
  const existing = inFlightNpbFetches.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(fetcher).finally(() => {
    if (inFlightNpbFetches.get(key) === pending) inFlightNpbFetches.delete(key);
  });
  inFlightNpbFetches.set(key, pending);
  return pending;
}

async function fetchNpbBody(sourceUrl, { purpose = "page", headers = {}, asBytes = false } = {}) {
  const key = `${purpose}:${sourceUrl}`;
  return shareNpbFetch(key, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NPB_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(sourceUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: { "User-Agent": NPB_USER_AGENT, ...headers }
      });
      if (!response.ok) {
        const errorBody = asBytes ? "" : await response.text().catch(() => "");
        return {
          ok: false,
          code: "NPB_HTTP_ERROR",
          httpStatus: response.status,
          contentType: response.headers.get("Content-Type") || "",
          bodySummary: errorBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
          body: asBytes ? new Uint8Array() : ""
        };
      }
      return {
        ok: true,
        httpStatus: response.status,
        contentType: response.headers.get("Content-Type") || "",
        body: asBytes ? new Uint8Array(await response.arrayBuffer()) : await response.text()
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.name === "AbortError" ? "TIMEOUT" : "WORKER_FETCH_FAILED",
        httpStatus: 0,
        contentType: "",
        body: asBytes ? new Uint8Array() : ""
      };
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

function lineupErrorResponse(code, status, details = {}) {
  return jsonResponse({
    ok: false,
    code,
    error: LINEUP_ERROR_MESSAGES[code] || "スタメン取得に失敗しました。",
    ...details
  }, status);
}

function createLineupCacheKey(source) {
  return new Request(`https://starting9-lineup-cache.invalid/${source.date}/${source.gameCode}`);
}

async function getCachedLineup(source) {
  if (typeof caches === "undefined" || !caches.default) {
    return null;
  }

  try {
    const cache = caches.default;
    const cacheKey = createLineupCacheKey(source);
    const cachedResponse = await cache.match(cacheKey);
    if (!cachedResponse) {
      return null;
    }

    const expiresAt = Number(cachedResponse.headers.get("X-Starting9-Expires-At"));
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
      await cache.delete(cacheKey);
      return null;
    }

    const cachedBody = await cachedResponse.json();
    return cachedBody?.ok && Array.isArray(cachedBody.lineup) && cachedBody.lineup.length === LINEUP_SIZE
      ? cachedBody
      : null;
  } catch (error) {
    return null;
  }
}

async function cacheLineupResponse(source, responseBody) {
  if (typeof caches === "undefined" || !caches.default) {
    return;
  }

  try {
    const expiresAt = Date.now() + LINEUP_CACHE_TTL_SECONDS * 1000;
    await caches.default.put(createLineupCacheKey(source), new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `max-age=${LINEUP_CACHE_TTL_SECONDS}`,
        "X-Starting9-Expires-At": String(expiresAt)
      }
    }));
  } catch (error) {
    // Cache failures must not turn a successful NPB response into a fetch failure.
  }
}

async function handleRosterRequest(requestUrl, isDebug) {
  const rosterUrlValue = requestUrl.searchParams.get("url") || "https://npb.jp/announcement/roster/";
  const requestedTeam = resolvePilotTeam(requestUrl.searchParams.get("team") || "fighters");
  const validation = validateRosterUrl(rosterUrlValue);
  const forceRefresh = ["1", "true", "yes"].includes(String(requestUrl.searchParams.get("force") || "").toLowerCase());

  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }
  if (!requestedTeam) {
    return jsonResponse({ ok: false, code: "ROSTER_TEAM_UNSUPPORTED", error: "指定された球団のロースターには対応していません。" }, 400);
  }

  try {
    const source = await fetchRosterSource(requestUrl, validation.url, { forceRefresh });
    if (!source.ok) {
      return jsonResponse({ ok: false, code: "ROSTER_FETCH_FAILED", error: "NPB公式登録ページを取得できませんでした。" }, 502);
    }

    const html = source.html;
    const extraction = extractTeamRoster(html, requestedTeam.key);

    if (!extraction.players.length) {
      return jsonResponse({
        ok: false,
        code: "ROSTER_PARSE_FAILED",
        error: `${requestedTeam.name}の登録選手一覧を抽出できませんでした。`,
        ...(isDebug ? { debug: extraction.debug } : {})
      }, 422);
    }

    return jsonResponse({
      ok: true,
      sourceUrl: validation.url,
      fetchedAt: source.fetchedAt,
      servedAt: new Date().toISOString(),
      httpStatus: source.httpStatus,
      cacheStatus: source.cacheStatus,
      stale: source.stale,
      method: extraction.method,
      team: requestedTeam.key,
      players: extraction.players,
      count: extraction.players.length,
      parsedCount: extraction.players.length,
      announcedCount: extraction.announcedCount,
      ...(extraction.warning ? { warning: extraction.warning } : {})
    });
  } catch (error) {
    return jsonResponse({ ok: false, code: "ROSTER_FETCH_FAILED", error: "NPB公式登録ページを取得できませんでした。" }, 502);
  }
}

async function handleNoticeRequest(requestUrl, isDebug) {
  const requestedDate = requestUrl.searchParams.get("date") || "";
  try {
    // 公示監視はCronのスロットと本文ハッシュで重複を抑制するため、
    // 通常ロースター取得の30分Cache APIを使わず、公式ページを確認する。
    const source = await fetchNoticeSource();
    if (!source.ok) {
      const isContentTypeError = source.code === "NOTICE_CONTENT_TYPE_INVALID";
      return jsonResponse({
        ok: false,
        code: source.code || "NOTICE_FETCH_FAILED",
        sourceUrl: NOTICE_SOURCE_URL,
        ...(source.httpStatus ? { httpStatus: source.httpStatus } : {}),
        error: isContentTypeError ? "NPB公式公示ページのContent-TypeがHTMLではありません。" : "NPB公式公示ページを取得できませんでした。",
        ...(isDebug ? { debug: source.diagnostics } : {})
      }, isContentTypeError ? 422 : 502);
    }
    const parsed = parseNoticePage(source.html);
    const contentHash = await createContentHash(source.html);
    if (!parsed.isValid) {
      return jsonResponse({
        ok: false,
        code: "NOTICE_PARSE_FAILED",
        sourceUrl: NOTICE_SOURCE_URL,
        fetchedAt: source.fetchedAt,
        error: "NPB公式公示ページの日付または球団一覧を確認できませんでした。",
        ...(isDebug ? { debug: parsed.debug } : {})
      }, 422);
    }
    const notice = selectNoticeForRequestedDate(parsed, requestedDate);
    console.log(`[NPB_NOTICE] parse source=${NOTICE_SOURCE_URL} status=${source.httpStatus} contentType=${source.contentType || "-"} bodyLength=${source.bodyLength} title=${source.diagnostics.title || "-"} head=${source.diagnostics.headStructure || "-"} selectors=${JSON.stringify(parsed.debug.selectorCounts)} noticeDate=${notice.noticeDate} pageDate=${parsed.date} registrations=${notice.registrations.length} removals=${notice.removals.length}`);
    return jsonResponse({
      ok: true,
      sourceUrl: NOTICE_SOURCE_URL,
      fetchedAt: source.fetchedAt,
      httpStatus: source.httpStatus,
      noticeDate: notice.noticeDate,
      pageDate: parsed.date,
      contentHash,
      registrations: notice.registrations,
      removals: notice.removals,
      registeredCount: notice.registrations.length,
      removedCount: notice.removals.length,
      rosters: parsed.rosters,
      cacheStatus: source.cacheStatus,
      stale: source.stale,
      method: "roster-page-daily-notice-and-team-rosters",
      ...(isDebug ? { debug: { ...source.diagnostics, ...parsed.debug, ...notice.debug } } : {})
    });
  } catch (error) {
    console.log(`[NPB_NOTICE] fetch-or-parse-failed source=${NOTICE_SOURCE_URL} code=${String(error?.code || "NOTICE_FETCH_FAILED")}`);
    return jsonResponse({ ok: false, code: "NOTICE_FETCH_FAILED", sourceUrl: NOTICE_SOURCE_URL, error: "NPB公式公示ページを確認できませんでした。" }, 502);
  }
}

async function fetchNoticeSource() {
  try {
    const source = await fetchNpbBody(NOTICE_SOURCE_URL, {
      purpose: "notice-page",
      headers: { "Cache-Control": "no-cache" },
      asBytes: true
    });
    const contentType = source.contentType || "";
    const bytes = source.body;
    const decoded = decodeNoticeHtml(bytes, contentType);
    const diagnostics = createNoticeSourceDiagnostics({
      contentType,
      httpStatus: source.httpStatus,
      bodyLength: bytes.byteLength,
      html: decoded.html,
      charset: decoded.charset
    });
    if (!source.ok) {
      return { ok: false, code: source.code === "NPB_HTTP_ERROR" ? "NOTICE_FETCH_FAILED" : source.code, httpStatus: source.httpStatus, diagnostics };
    }
    if (!isHtmlContentType(contentType)) {
      console.log(`[NPB_NOTICE] content-type-invalid source=${NOTICE_SOURCE_URL} status=${source.httpStatus} contentType=${contentType || "-"} bodyLength=${bytes.byteLength}`);
      return { ok: false, code: "NOTICE_CONTENT_TYPE_INVALID", httpStatus: source.httpStatus, diagnostics };
    }
    return {
      ok: true,
      html: decoded.html,
      httpStatus: source.httpStatus,
      contentType,
      bodyLength: bytes.byteLength,
      diagnostics,
      fetchedAt: new Date().toISOString(),
      cacheStatus: "bypass",
      stale: false
    };
  } catch (error) {
    return { ok: false, code: error?.code || "NOTICE_FETCH_FAILED", error: "NPB公式公示ページを取得できませんでした。" };
  }
}

export function parseNoticePage(html) {
  const sourceHtml = String(html || "");
  const dateMatch = sourceHtml.match(/<h4[^>]*>\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:の)?\s*出場選手登録(?:\s*[、・及お]\s*(?:よび)?\s*登録抹消)?/iu);
  const date = dateMatch ? `${dateMatch[1]}-${String(Number(dateMatch[2])).padStart(2, "0")}-${String(Number(dateMatch[3])).padStart(2, "0")}` : "";
  const noticeSections = extractNoticeSections(sourceHtml);
  const registrationSections = noticeSections.filter((section) => section.heading === "出場選手登録");
  const removalSections = noticeSections.filter((section) => section.heading === "出場選手登録抹消");
  const registrations = registrationSections.flatMap((section) => parseNoticeRows(section.html));
  const removals = removalSections.flatMap((section) => parseNoticeRows(section.html));
  const rosters = {};
  const rosterPattern = /<h5[^>]*>\s*([^<]+?)\s*<\/h5>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/giu;
  let rosterMatch;
  while ((rosterMatch = rosterPattern.exec(sourceHtml)) !== null) {
    const team = normalizeStarterTeam(rosterMatch[1]);
    if (!team || rosters[team.key]) continue;
    const entries = parseRosterTableEntries(rosterMatch[2]);
    if (entries.length > 0) rosters[team.key] = entries;
  }
  return {
    date,
    registrations,
    removals,
    rosters,
    isValid: Boolean(date),
    debug: {
      date,
      registeredRows: registrations.length,
      removedRows: removals.length,
      rosterTeams: Object.keys(rosters).length,
      selectorCounts: {
        dateHeading: dateMatch ? 1 : 0,
        noticeHeadings: noticeSections.length,
        registrationSections: registrationSections.length,
        removalSections: removalSections.length,
        rosterTeamSections: Object.keys(rosters).length
      }
    }
  };
}

function extractNoticeSections(html) {
  const sections = [];
  const headingPattern = /<h5[^>]*>([\s\S]*?)<\/h5>/giu;
  const headings = [...html.matchAll(headingPattern)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = normalizeWhitespace(stripTags(headings[index][1]));
    const start = (headings[index].index || 0) + headings[index][0].length;
    const end = index + 1 < headings.length ? (headings[index + 1].index || html.length) : html.length;
    if (heading === "出場選手登録" || heading === "出場選手登録抹消") {
      sections.push({ heading, html: html.slice(start, end) });
    }
  }
  return sections;
}

function selectNoticeForRequestedDate(parsed, requestedDate) {
  const normalizedRequestedDate = /^20\d{2}-\d{2}-\d{2}$/.test(String(requestedDate || "")) ? requestedDate : "";
  if (!normalizedRequestedDate || normalizedRequestedDate === parsed.date) {
    return {
      noticeDate: parsed.date,
      registrations: parsed.registrations,
      removals: parsed.removals,
      debug: { pageDate: parsed.date, requestedDate: normalizedRequestedDate || parsed.date, noticeState: "published" }
    };
  }
  // 公示がない日はルートページが直近の公示日を表示する。依頼日の差分は空公示として扱う。
  return {
    noticeDate: normalizedRequestedDate,
    registrations: [],
    removals: [],
    debug: { pageDate: parsed.date, requestedDate: normalizedRequestedDate, noticeState: "no-notice-for-requested-date" }
  };
}

function isHtmlContentType(contentType) {
  return /^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(String(contentType || "").trim());
}

export function decodeNoticeHtml(bytes, contentType = "") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const asciiHead = new TextDecoder("latin1").decode(view.slice(0, 4096));
  const charset = detectNoticeCharset(contentType, asciiHead);
  try {
    return { html: new TextDecoder(charset).decode(view), charset };
  } catch {
    return { html: new TextDecoder("utf-8").decode(view), charset: "utf-8" };
  }
}

function detectNoticeCharset(contentType, asciiHead) {
  const headerCharset = /charset\s*=\s*["']?([^\s;"'>]+)/iu.exec(String(contentType || ""))?.[1] || "";
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([^\s;"'>]+)/iu.exec(asciiHead)?.[1]
    || /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"'>]+)/iu.exec(asciiHead)?.[1]
    || "";
  const normalized = String(headerCharset || metaCharset || "utf-8").trim().toLowerCase().replace(/_/g, "-");
  if (["shift-jis", "shiftjis", "sjis", "windows-31j", "ms932", "cp932"].includes(normalized)) return "windows-31j";
  if (["euc-jp", "eucjp"].includes(normalized)) return "euc-jp";
  return normalized || "utf-8";
}

function createNoticeSourceDiagnostics({ contentType, httpStatus, bodyLength, html, charset }) {
  const title = normalizeWhitespace(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html || "")?.[1] || ""));
  const head = String(html || "").slice(0, 1600);
  const tags = [...head.matchAll(/<(?:!doctype\s+html|html|head|meta|title|body)\b[^>]*>/giu)]
    .map((match) => /^<\s*([^\s>]+)/u.exec(match[0])?.[1].toLowerCase() || "")
    .filter(Boolean);
  return {
    sourceUrl: NOTICE_SOURCE_URL,
    httpStatus: Number(httpStatus || 0),
    contentType: String(contentType || ""),
    bodyLength: Number(bodyLength || 0),
    charset,
    title,
    headStructure: [...new Set(tags)].join(",")
  };
}

function parseNoticeRows(block) {
  const rows = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/giu;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(block)) !== null) {
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/giu;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) cells.push(stripTags(cellMatch[1]));
    if (cells.length < 4) continue;
    const team = normalizeStarterTeam(cells[0]);
    const position = normalizeWhitespace(cells[1]);
    const number = normalizeWhitespace(cells[2]).replace(/\s+/g, "");
    const name = normalizeRosterPlayerName(cells[3]);
    if (team && position && number && name) rows.push({ teamCode: team.key, position, number, name });
  }
  return rows;
}

async function createContentHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  const bytes = new Uint8Array(digest);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function fetchRosterSource(requestUrl, sourceUrl, { forceRefresh = false } = {}) {
  const cache = caches.default;
  const cacheKey = new Request(`${requestUrl.origin}/__starting9/roster-cache?source=${encodeURIComponent(sourceUrl)}`);
  let cached = null;
  if (!forceRefresh) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      cached = cachedResponse ? await readCachedRosterSource(cachedResponse) : null;
    } catch {
      // Cache APIの障害時も、公式ページへの新規取得は試みる。
    }
  }

  if (!forceRefresh && cached && !cached.isExpired) {
    return {
      ok: true,
      html: cached.html,
      httpStatus: cached.httpStatus,
      fetchedAt: cached.fetchedAt,
      cacheStatus: "hit",
      stale: false
    };
  }

  try {
    const source = await fetchNpbBody(sourceUrl, {
      purpose: "roster-page",
      headers: {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache"
      }
    });

    if (!source.ok) {
      if (cached) {
        return {
          ok: true,
          html: cached.html,
          httpStatus: cached.httpStatus,
          fetchedAt: cached.fetchedAt,
          cacheStatus: "stale-fallback",
          stale: true
        };
      }
      return { ok: false, error: `NPB公式登録ページを取得できませんでした。HTTP ${source.httpStatus}` };
    }

    const html = source.body;
    const fetchedAt = new Date().toISOString();
    const headers = new Headers({
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": `public, max-age=${ROSTER_CACHE_TTL_SECONDS}`,
      "X-Starting9-Roster-Fetched-At": fetchedAt,
      "X-Starting9-Roster-Http-Status": String(source.httpStatus)
    });
    try {
      await cache.put(cacheKey, new Response(html, { headers }));
    } catch {
      // キャッシュ不調でも、今回の公式ページ取得結果は返す。
    }

    return {
      ok: true,
      html,
      httpStatus: source.httpStatus,
      fetchedAt,
      cacheStatus: forceRefresh ? "bypass" : "miss",
      stale: false
    };
  } catch (error) {
    if (cached) {
      return {
        ok: true,
        html: cached.html,
        httpStatus: cached.httpStatus,
        fetchedAt: cached.fetchedAt,
        cacheStatus: "stale-fallback",
        stale: true
      };
    }
    return { ok: false, error: "NPB公式登録ページの取得中に通信エラーが発生しました。" };
  }
}

async function readCachedRosterSource(response) {
  const fetchedAt = response.headers.get("X-Starting9-Roster-Fetched-At") || "";
  const fetchedAtMs = Date.parse(fetchedAt);
  const httpStatus = Number(response.headers.get("X-Starting9-Roster-Http-Status")) || 200;
  return {
    html: await response.text(),
    fetchedAt,
    httpStatus,
    isExpired: !Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs >= ROSTER_CACHE_TTL_SECONDS * 1000
  };
}

async function handleStarterRequest(isDebug) {
  const fetchedAt = new Date().toISOString();

  try {
    const source = await fetchNpbBody(STARTER_SOURCE_URL, { purpose: "starter-page" });

    if (!source.ok) {
      return jsonResponse({
        ok: false,
        sourceUrl: STARTER_SOURCE_URL,
        fetchedAt,
        code: source.code || "STARTER_FETCH_FAILED",
        error: `NPB公式予告先発ページを取得できませんでした。HTTP ${source.httpStatus || 502}`
      }, 502);
    }

    const html = source.body;
    const parsed = parseStarterPage(html);
    const responseBody = {
      ok: true,
      sourceUrl: STARTER_SOURCE_URL,
      fetchedAt,
      date: parsed.date,
      method: "starter-unit-team-pair",
      games: parsed.games,
      count: parsed.games.length
    };

    if (!parsed.date && parsed.games.length === 0) {
      return jsonResponse({
        ok: false,
        sourceUrl: STARTER_SOURCE_URL,
        fetchedAt,
        error: "NPB公式予告先発ページの試合ブロックを解析できませんでした。",
        ...(isDebug ? { debug: createStarterDebugInfo(html, parsed) } : {})
      }, 422);
    }

    return jsonResponse({
      ...responseBody,
      ...(isDebug ? { debug: createStarterDebugInfo(html, parsed) } : {})
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      sourceUrl: STARTER_SOURCE_URL,
      fetchedAt,
      error: "NPB公式予告先発ページの取得中に通信エラーが発生しました。"
    }, 500);
  }
}

function parseStarterPage(html) {
  const sourceHtml = String(html || "");
  const plainText = htmlToPlainText(sourceHtml);
  const date = extractStarterDate(sourceHtml);
  const games = [];
  const unitPattern = /<div\s+class=["']unit\s+(?:cl|pl)_\d+["'][^>]*>([\s\S]*?)(?=<div\s+class=["']unit\s+(?:cl|pl)_\d+["']|<\/section>)/gi;
  let unitMatch;

  while ((unitMatch = unitPattern.exec(sourceHtml)) !== null) {
    const game = parseStarterUnit(unitMatch[1]);
    if (game) {
      games.push({ date, ...game });
    }
  }

  return { date, games, plainText };
}

function parseStarterUnit(unitHtml) {
  const home = parseStarterTeamBlock(unitHtml, "team_left");
  const away = parseStarterTeamBlock(unitHtml, "team_right");
  const infoMatch = unitHtml.match(/<div\s+class=["']info["'][^>]*>([\s\S]*?)<\/div>/i);

  if (!home || !away) {
    return null;
  }

  const info = normalizeWhitespace(stripTags(infoMatch ? infoMatch[1] : ""));
  const startTimeMatch = info.match(/(\d{1,2}:\d{2})/);
  const venueMatch = info.match(/[（(]\s*([^）)]*?)\s*[）)]/);
  const venue = venueMatch ? venueMatch[1].replace(/\s+/g, "") : "";

  return {
    homeTeam: home.key,
    awayTeam: away.key,
    homeTeamName: home.name,
    awayTeamName: away.name,
    homeStarter: { name: home.starterName },
    awayStarter: { name: away.starterName },
    venue,
    startTime: startTimeMatch ? startTimeMatch[1] : ""
  };
}

function parseStarterTeamBlock(unitHtml, className) {
  const blockMatch = unitHtml.match(new RegExp(`<div\\s+class=["']${className}["'][^>]*>([\\s\\S]*?)<\\/div>`, "i"));
  if (!blockMatch) {
    return null;
  }

  const block = blockMatch[1];
  const altMatch = block.match(/\balt=["']([^"']+)["']/i);
  const team = normalizeStarterTeam(altMatch ? altMatch[1] : "");
  if (!team) {
    return null;
  }

  const playerMatch = block.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
  const starterName = normalizeStarterName(playerMatch ? stripTags(playerMatch[1]) : "");

  return {
    key: team.key,
    name: team.name,
    starterName
  };
}

function extractStarterDate(html) {
  const headingMatch = String(html || "").match(/<h4[^>]*>\s*(\d{1,2})月\s*(\d{1,2})日/iu);
  if (!headingMatch) {
    return "";
  }

  const yearMatch = String(html || "").match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  const month = String(Number(headingMatch[1])).padStart(2, "0");
  const day = String(Number(headingMatch[2])).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const dateValue = new Date(`${date}T00:00:00Z`);
  return dateValue.toISOString().slice(0, 10) === date ? date : "";
}

function normalizeStarterTeam(value) {
  const normalized = normalizeWhitespace(value).replace(/\s+/g, "").normalize("NFKC");
  const match = STARTER_TEAM_ALIASES.find((team) => team.aliases.some((alias) => normalized === alias || normalized.includes(alias)));
  return match || null;
}

function normalizeStarterName(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || /^[\-－—–]+$/.test(normalized) || /^(未発表|未定|予告なし)$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createStarterDebugInfo(html, parsed) {
  const text = normalizeWhitespace(parsed.plainText || htmlToPlainText(html));
  return {
    foundDate: Boolean(parsed.date),
    parsedGameCount: parsed.games.length,
    textExcerpt: text.slice(0, 2400)
  };
}

function validateTargetUrl(value) {
  if (!value) {
    return { ok: false, error: "urlパラメータを指定してください。" };
  }

  let targetUrl;
  try {
    targetUrl = new URL(value);
  } catch (error) {
    return { ok: false, error: "URL形式が不正です。" };
  }

  if (targetUrl.protocol !== "https:") {
    return { ok: false, error: "httpsのNPB公式URLを指定してください。" };
  }

  if (targetUrl.hostname !== "npb.jp") {
    return { ok: false, error: "npb.jp以外のURLは利用できません。" };
  }

  const scoreMatch = targetUrl.pathname.match(NPB_SCORE_PATH_PATTERN);
  if (!scoreMatch) {
    return { ok: false, error: "NPB公式の試合ページURLを指定してください。" };
  }

  return {
    ok: true,
    url: targetUrl.href,
    date: `${scoreMatch[1]}-${scoreMatch[2]}-${scoreMatch[3]}`,
    gameCode: scoreMatch[4].toLowerCase()
  };
}

function validateRosterUrl(value) {
  if (!value) {
    return { ok: false, error: "登録選手ページURLを指定してください。" };
  }

  let targetUrl;
  try {
    targetUrl = new URL(value);
  } catch (error) {
    return { ok: false, error: "登録選手ページURLの形式が不正です。" };
  }

  if (targetUrl.protocol !== "https:") {
    return { ok: false, error: "httpsのNPB公式URLを指定してください。" };
  }

  if (targetUrl.hostname !== "npb.jp" && !targetUrl.hostname.endsWith(".npb.jp")) {
    return { ok: false, error: "npb.jp以外のURLは利用できません。" };
  }

  if (!targetUrl.pathname.startsWith("/announcement/roster/")) {
    return { ok: false, error: "https://npb.jp/announcement/roster/ 配下の登録選手ページURLを指定してください。" };
  }

  return { ok: true, url: targetUrl.href };
}

function extractNpbOrderText(html, requestedTeamKey = teamContext.FIGHTERS.key) {
  const plainText = htmlToPlainText(html);
  const lines = normalizeNpbTextLines(plainText);
  const orderStartIndex = lines.findIndex((line) => line.includes("最新のオーダー"));
  const requestedTeam = STARTER_TEAM_ALIASES.find((team) => team.key === String(requestedTeamKey || "").trim().toLowerCase());
  if (!requestedTeam) {
    return createFailedExtraction("requested-team-unknown", [], plainText, lines, orderStartIndex, {
      foundFightersTeam: false,
      validationError: "requested-team-unknown"
    });
  }
  // Keep the production/default Fighters parser contract unchanged. The
  // test simulator supplies the same team heading/table structure for any
  // participant so the existing row parser can verify every contest without
  // silently borrowing Fighters rows for another club.
  const teamTable = requestedTeam.key === teamContext.FIGHTERS.key
    ? findFightersOrderTable(html)
    : findRequestedTeamOrderTable(html, requestedTeam);

  if (teamTable) {
    const tableRows = parseTableRows(teamTable);
    const validation = validateExtractedLineupRows(tableRows);
    if (validation.ok) {
      return createSuccessfulExtraction("table", tableRows, plainText, lines, orderStartIndex);
    }

    return createFailedExtraction("table-invalid", tableRows, plainText, lines, orderStartIndex, {
      foundFightersTeam: requestedTeam.key === teamContext.FIGHTERS.key,
      foundRequestedTeam: true,
      validationError: validation.reason
    });
  }

  if (requestedTeam.key !== teamContext.FIGHTERS.key) {
    return createFailedExtraction("requested-team-table-missing", [], plainText, lines, orderStartIndex, {
      foundFightersTeam: false,
      foundRequestedTeam: false,
      validationError: "requested-team-table-missing"
    });
  }

  const compactRows = extractRowsFromCompactText(lines.join(" "));
  const compactValidation = validateExtractedLineupRows(compactRows);
  if (compactValidation.ok) {
    return createSuccessfulExtraction("compact-text", compactRows, plainText, lines, orderStartIndex);
  }

  const tokenRows = extractRowsFromTokens(lines);
  const tokenValidation = validateExtractedLineupRows(tokenRows);
  if (tokenValidation.ok) {
    return createSuccessfulExtraction("token", tokenRows, plainText, lines, orderStartIndex);
  }

  const searchStartIndex = orderStartIndex >= 0 ? orderStartIndex + 1 : 0;
  const fightersIndex = findFightersOrderStartIndex(lines, searchStartIndex);
  const candidateStartIndex = fightersIndex >= 0 ? fightersIndex + 1 : searchStartIndex;
  const fightersRows = collectNpbOrderRows(lines.slice(candidateStartIndex));

  const fightersValidation = validateExtractedLineupRows(fightersRows);
  if (fightersValidation.ok) {
    return createSuccessfulExtraction("line", fightersRows, plainText, lines, orderStartIndex);
  }

  const fallbackRows = collectNpbOrderRows(lines.slice(searchStartIndex));
  const fallbackValidation = validateExtractedLineupRows(fallbackRows);
  if (fallbackValidation.ok) {
    return createSuccessfulExtraction("line-fallback", fallbackRows, plainText, lines, orderStartIndex);
  }

  return createFailedExtraction("no-valid-9-rows", fightersRows, plainText, lines, orderStartIndex, {
    foundFightersTeam: fightersIndex >= 0,
    validationError: fightersValidation.reason || compactValidation.reason || tokenValidation.reason || fallbackValidation.reason
  });
}

function findRequestedTeamOrderTable(html, requestedTeam) {
  const sourceHtml = String(html || "");
  const key = requestedTeam.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marked = sourceHtml.match(new RegExp(`<table\\b[^>]*data-lineup-team=["']${key}["'][^>]*>([\\s\\S]*?)<\\/table>`, "i"));
  if (marked) return marked[1];
  const headingPattern = new RegExp(String.raw`<h[1-6][^>]*>([\s\S]*?)</h[1-6]>\s*<table\b[^>]*>([\s\S]*?)</table>`, "gi");
  let match;
  const acceptedNames = [requestedTeam.name, ...requestedTeam.aliases].map((value) => normalizeWhitespace(value).normalize("NFKC").toLowerCase());
  while ((match = headingPattern.exec(sourceHtml)) !== null) {
    const heading = normalizeWhitespace(stripTags(match[1])).normalize("NFKC").toLowerCase();
    if (acceptedNames.some((name) => name && (heading === name || heading.includes(name)))) return match[2];
  }
  return "";
}

function resolvePilotTeam(value) {
  const normalized = normalizeWhitespace(value).replace(/[\s\u3000・.]/g, "").normalize("NFKC").toLowerCase();
  // The 12-team production rollout uses the same explicit team contexts as
  // schedule normalization and roster parsing; unknown values still fail closed.
  return Object.values(teamContext.NPB_TEAMS).find((team) => team.key.toLowerCase() === normalized
    || [team.playerTeamId, team.providerTeamCode, ...team.aliases]
      .some((alias) => alias.replace(/[\s\u3000・.]/g, "").normalize("NFKC").toLowerCase() === normalized)) || null;
}

function extractTeamRoster(html, teamKey = "fighters") {
  const sourceHtml = String(html || "");
  const team = STARTER_TEAM_ALIASES.find((entry) => entry.key === teamKey);
  const heading = team?.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const teamTablePattern = heading
    ? new RegExp(`<h5[^>]*>\\s*${heading}\\s*<\\/h5>[\\s\\S]*?<table[^>]*>([\\s\\S]*?)<\\/table>`, "i")
    : null;
  const tableMatch = teamTablePattern ? sourceHtml.match(teamTablePattern) : null;
  const tableHtml = tableMatch ? tableMatch[1] : "";
  const entries = tableHtml ? parseRosterTableEntries(tableHtml) : [];
  const players = uniqueRosterEntries(entries);
  const plainText = htmlToPlainText(sourceHtml);
  const lines = normalizeNpbTextLines(plainText);
  const announcedCount = extractAnnouncedRosterCount(sourceHtml, tableMatch?.index ?? -1);
  const warning = announcedCount && announcedCount !== players.length
    ? `登録選手数の表示（${announcedCount}人）と抽出人数（${players.length}人）が一致しません。`
    : "";

  return {
    method: tableMatch ? "roster-page-team-block" : "roster-not-found",
    players,
    announcedCount,
    warning,
    debug: {
      team: teamKey,
      foundTeamHeading: Boolean(tableMatch),
      foundPlayers: players.length,
      announcedCount,
      warning,
      textExcerpt: lines.join(" ").slice(0, 1800),
      ...(teamKey === teamContext.FIGHTERS.key ? {
        foundFightersHeading: Boolean(tableMatch),
        fightersExcerpt: createFightersRosterExcerpt(lines)
      } : {})
    }
  };
}

// Keep the existing Fighters extraction contract for callers that still use the
// named helper; the provider route itself resolves the requested pilot context.
function extractFightersRoster(html) {
  return extractTeamRoster(html, teamContext.FIGHTERS.key);
}

function parseRosterTableEntries(tableHtml) {
  const entries = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells = [];
    const rawCells = [];
    const cellPattern = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      rawCells.push(cellMatch[1]);
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 3) {
      continue;
    }

    const position = cells[0].replace(/\s+/g, "");
    const number = cells[1].replace(/\s+/g, "");
    const name = normalizeRosterPlayerName(cells[2]);
    const identity = extractOfficialNpbPlayerIdentity(rawCells[2]);

    if (position && number && name) {
      entries.push({
        position,
        number,
        name,
        ...(identity ? { playerId: identity.playerId, officialPlayerUrl: identity.officialPlayerUrl } : {})
      });
    }
  }

  return entries;
}

function extractOfficialNpbPlayerIdentity(cellHtml) {
  const source = String(cellHtml || "");
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let anchor;
  while ((anchor = anchorPattern.exec(source)) !== null) {
    try {
      const url = new URL(anchor[1], "https://npb.jp");
      if (!/^https?:$/i.test(url.protocol) || !["npb.jp", "www.npb.jp"].includes(url.hostname.toLowerCase())) continue;
      const match = url.pathname.match(/^\/bis\/players\/(\d{8})\.html$/i);
      if (!match) continue;
      return {
        playerId: `npb:${match[1]}`,
        officialPlayerUrl: `https://npb.jp/bis/players/${match[1]}.html`
      };
    } catch {
      // One malformed link must not invalidate the roster row or response.
    }
  }
  return null;
}

function uniqueRosterEntries(entries) {
  const seen = new Set();
  const players = [];

  entries.forEach((entry) => {
    const playerId = String(entry?.playerId || "").trim();
    const key = playerId || `${entry.number}:${normalizeRosterPlayerKey(entry.name)}`;
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    players.push(entry);
  });

  return players;
}

function normalizeRosterPlayerName(value) {
  return String(value || "")
    .replace(/※[\s\S]*$/u, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s\u3000]/g, "");
}

function normalizeRosterPlayerKey(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "");
}

function extractAnnouncedRosterCount(html, teamHeadingIndex) {
  if (teamHeadingIndex < 0) {
    return 0;
  }

  const scopedHtml = String(html || "").slice(teamHeadingIndex, teamHeadingIndex + 12000);
  const countMatch = scopedHtml.match(/以上\s*([0-9０-９]+)\s*名/);
  if (!countMatch) {
    return 0;
  }

  return Number(countMatch[1].normalize("NFKC"));
}

function createFightersRosterExcerpt(lines) {
  const index = lines.findIndex((line) => line.includes("北海道日本ハムファイターズ"));
  if (index < 0) {
    return "";
  }

  return lines.slice(index, index + 90).join(" ").slice(0, 1800);
}

function findFightersOrderTable(html) {
  const sourceHtml = String(html || "");
  const orderBlockMatch = sourceHtml.match(/<div[^>]+id=["']player-order["'][\s\S]*?<\/div>\s*<\/div>/i);
  const orderBlock = orderBlockMatch ? orderBlockMatch[0] : sourceHtml;
  const teamPattern = /<h5[^>]*>([\s\S]*?)<\/h5>\s*<table[^>]*>([\s\S]*?)<\/table>/gi;
  let match;

  while ((match = teamPattern.exec(orderBlock)) !== null) {
    const teamName = stripTags(match[1]);
    if (!isFightersTeamName(teamName)) {
      continue;
    }

    return match[2];
  }

  return "";
}

function extractRowsFromFightersTable(html) {
  const tableHtml = findFightersOrderTable(html);
  return tableHtml ? parseTableRows(tableHtml) : [];
}

function parseTableRows(tableHtml) {
  const rows = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells = [];
    const cellPattern = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }

    const row = parseCellRow(cells);
    if (row) {
      rows.push(row);
    }
  }

  return rows;
}

function parseCellRow(cells) {
  if (cells.length < 3) {
    return null;
  }

  return parseNpbOrderParts(cells[0], cells[1], cells[2]);
}

function extractRowsFromCompactText(text) {
  const startIndex = findFightersTextStart(text);
  if (startIndex < 0) {
    return [];
  }

  const scopedText = text.slice(startIndex, startIndex + 1600);
  const rows = [];
  const rowPattern = /(?:^|\s)([1-9])\s+([^\s]+)\s+(.+?)(?=\s+[1-9]\s+[^\s]+\s+|\s+投\s+|千葉ロッテ|ロッテ|$)/g;
  let match;

  while ((match = rowPattern.exec(scopedText)) !== null) {
    const row = parseNpbOrderParts(match[1], match[2], match[3]);
    if (row) {
      rows.push(row);
    }

    if (rows.length === LINEUP_SIZE) {
      return rows;
    }
  }

  return rows;
}

function extractRowsFromTokens(lines) {
  const startLine = findFightersOrderStartIndex(lines, 0);
  if (startLine < 0) {
    return [];
  }

  const tokens = lines.slice(startLine + 1, startLine + 90).flatMap((line) => line.split(/\s+/).filter(Boolean));
  const rows = [];

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const row = parseNpbOrderParts(tokens[index], tokens[index + 1], tokens[index + 2]);
    if (!row) {
      continue;
    }

    rows.push(row);
    index += 2;

    if (rows.length === LINEUP_SIZE) {
      return rows;
    }
  }

  return rows;
}

function parseNpbOrderParts(rawOrder, rawPosition, rawPlayer) {
  const order = Number(rawOrder);
  const position = normalizePosition(rawPosition);
  const player = normalizePlayerName(rawPlayer);

  if (!Number.isInteger(order) || order < 1 || order > LINEUP_SIZE || !position || position === "投" || !player) {
    return null;
  }

  return { order, position, player };
}

function validateExtractedLineupRows(rows) {
  if (!Array.isArray(rows) || rows.length !== LINEUP_SIZE) {
    return { ok: false, reason: "lineup-size" };
  }

  const orders = new Set();
  const players = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row?.order) || row.order < 1 || row.order > LINEUP_SIZE || orders.has(row.order)) {
      return { ok: false, reason: "batting-order" };
    }
    if (!normalizePosition(row.position) || row.position === "投" || !row.player) {
      return { ok: false, reason: "position-or-player" };
    }

    const playerKey = String(row.player).normalize("NFKC").replace(/[\s\u3000]/g, "");
    if (!playerKey || players.has(playerKey)) {
      return { ok: false, reason: "duplicate-player" };
    }
    orders.add(row.order);
    players.add(playerKey);
  }

  return { ok: true };
}

function createSuccessfulExtraction(stage, rows, plainText, lines, orderStartIndex) {
  return {
    lineupText: formatRowsForParser(rows),
    rows,
    debug: buildExtractionDebug(stage, plainText, lines, orderStartIndex, rows)
  };
}

function createFailedExtraction(stage, rows, plainText, lines, orderStartIndex, details = {}) {
  return {
    lineupText: "",
    rows: [],
    debug: {
      ...buildExtractionDebug(stage, plainText, lines, orderStartIndex, rows),
      ...details
    }
  };
}

function classifyLineupExtractionFailure(extraction) {
  const debug = extraction.debug || {};
  if (!debug.foundOrderHeading) {
    return "LINEUP_NOT_PUBLISHED";
  }
  if (!debug.foundFightersTeam) {
    return "GAME_NOT_FOUND";
  }
  if (debug.validationError) {
    return "INVALID_LINEUP";
  }
  return "PARSE_FAILED";
}

function classifyOfficialCancellationText(value) {
  const text = normalizeWhitespace(htmlToPlainText(value));
  const hasMarker = /(?:中止|延期)/u.test(text);
  const tentative = /(?:中止|延期)(?:の可能性|が検討|を検討|予定|になる可能性|の見込み)/u.test(text);
  return {
    officialCancelled: hasMarker && !tentative,
    marker: hasMarker ? (text.includes("中止") ? "中止" : "延期") : null,
    tentative
  };
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|th|td|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function normalizeNpbTextLines(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function findFightersOrderStartIndex(lines, startIndex) {
  return lines.findIndex((line, index) => {
    return index >= startIndex && FIGHTERS_TEXT_KEYWORDS.some((keyword) => line.includes(keyword));
  });
}

function collectNpbOrderRows(lines) {
  const rows = [];
  const seenOrders = new Set();

  for (const line of lines) {
    const row = parseNpbOrderRow(line);
    if (!row) {
      if (rows.length > 0 && rows.length < LINEUP_SIZE && isLikelyOtherTeamHeading(line)) {
        break;
      }
      continue;
    }

    if (seenOrders.has(row.order)) {
      break;
    }

    rows.push(row);
    seenOrders.add(row.order);

    if (rows.length === LINEUP_SIZE) {
      return rows;
    }
  }

  return rows;
}

function parseNpbOrderRow(line) {
  const normalizedLine = line.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  const match = normalizedLine.match(/^([1-9])\s+([^\s]+)\s+(.+)$/);

  if (!match) {
    return null;
  }

  return parseNpbOrderParts(match[1], match[2], match[3]);
}

function normalizePosition(value) {
  const key = String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  return POSITION_ALIASES[key] || "";
}

function normalizePlayerName(value) {
  const trimmedName = String(value || "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  const key = trimmedName.normalize("NFKC").replace(/[\s\u3000]/g, "");
  return PLAYER_ALIASES[key] || trimmedName.replace(/[\s\u3000]/g, "");
}

function stripTags(html) {
  return decodeHtml(String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|apos);/gi, (_, decimalCode, hexCode) => {
      const codePoint = decimalCode ? Number(decimalCode) : hexCode ? parseInt(hexCode, 16) : 39;
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _;
    });
}

function isFightersTeamName(value) {
  return FIGHTERS_TEAM_KEYWORDS.some((keyword) => String(value || "").includes(keyword));
}

function findFightersTextStart(text) {
  const orderIndex = text.indexOf("最新のオーダー");
  const searchStartIndex = orderIndex >= 0 ? orderIndex : 0;
  let bestIndex = -1;

  for (const keyword of FIGHTERS_TEXT_KEYWORDS) {
    const index = text.indexOf(keyword, searchStartIndex);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
    }
  }

  return bestIndex;
}

function isLikelyOtherTeamHeading(line) {
  return /ファイターズ|ホークス|マリーンズ|イーグルス|ライオンズ|バファローズ|ジャイアンツ|タイガース|ベイスターズ|カープ|スワローズ|ドラゴンズ/.test(line);
}

function formatRowsForParser(rows) {
  return rows
    .sort((first, second) => first.order - second.order)
    .map((row) => `${row.order} ${row.position} ${row.player}`)
    .join("\n");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function buildExtractionDebug(stage, plainText, lines, orderStartIndex, rows) {
  const normalizedText = lines.join(" ");
  const orderTextIndex = normalizedText.indexOf("最新のオーダー");
  const orderExcerpt = orderTextIndex >= 0
    ? normalizedText.slice(Math.max(0, orderTextIndex - 300), orderTextIndex + 1200)
    : "";

  return {
    failedAt: stage,
    foundOrderHeading: orderStartIndex >= 0 || orderTextIndex >= 0,
    foundRows: rows.length,
    rows,
    orderExcerpt,
    textExcerpt: normalizedText.slice(0, 1800)
  };
}

function createDebugInfo(sourceUrl, status, extraction) {
  return {
    sourceUrl,
    status,
    foundOrderHeading: extraction.debug?.foundOrderHeading || false,
    failedAt: extraction.debug?.failedAt || "unknown",
    foundRows: extraction.debug?.foundRows || 0,
    rows: extraction.debug?.rows || [],
    orderExcerpt: extraction.debug?.orderExcerpt || "",
    textExcerpt: extraction.debug?.textExcerpt || ""
  };
}

function getExtractionMethod(extraction) {
  const stage = extraction.debug?.failedAt || "";
  const methodMap = {
    table: "player-order-table",
    "compact-text": "player-order-text",
    token: "player-order-token",
    line: "player-order-line",
    "line-fallback": "player-order-line-fallback"
  };

  return methodMap[stage] || "unknown";
}

export {
  classifyOfficialCancellationText,
  createLineupSourceFromIdentity,
  createLineupSourceUrl,
  extractOfficialScorePageIdentity,
  extractScheduleGames,
  extractNpbOrderText,
  extractFightersRoster,
  extractTeamRoster,
  parseStarterPage,
  parseRosterTableEntries,
  validateTargetUrl
};
