import { normalizeFightersScheduleGames } from "./game-schedule-detection.js";

const LINEUP_SIZE = 9;
const LINEUP_CACHE_TTL_SECONDS = 5 * 60;
const ROSTER_CACHE_TTL_SECONDS = 30 * 60;
const NPB_FETCH_TIMEOUT_MS = 12_000;
const NOTICE_SOURCE_URL = "https://npb.jp/announcement/roster/";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://starting9.pages.dev",
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
  NPB_HTTP_ERROR: "NPB公式ページを取得できませんでした。",
  WORKER_FETCH_FAILED: "NPB公式ページへの接続に失敗しました。",
  TIMEOUT: "NPB公式ページの取得がタイムアウトしました。",
  LINEUP_NOT_PUBLISHED: "スタメンはまだ発表されていません。",
  PARSE_FAILED: "NPB公式ページからスタメンを解析できませんでした。",
  INVALID_LINEUP: "取得したスタメンの内容を確認できませんでした。"
};
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
  { key: "marines", name: "千葉ロッテマリーンズ", aliases: ["千葉ロッテマリーンズ", "ロッテマリーンズ", "ロッテ"] },
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

    const upstream = await fetchNpbScorePage(source.url);
    if (!upstream.ok) {
      return withCors(lineupErrorResponse(upstream.code, upstream.status, {
        sourceUrl: source.url,
        ...(upstream.httpStatus ? { httpStatus: upstream.httpStatus } : {})
      }), corsHeaders);
    }

    const extraction = extractNpbOrderText(upstream.html);
    const cancellation = classifyOfficialCancellationText(upstream.html);
    if (!extraction.lineupText && cancellation.officialCancelled) {
      return withCors(lineupErrorResponse("GAME_CANCELLED", 409, {
        sourceUrl: source.url,
        cancellationStatus: "official_cancelled",
        cancellationReason: "NPB公式ページに明示的な中止表示があり、通常のスタメン情報がありません。"
      }), corsHeaders);
    }
    if (!extraction.lineupText) {
      const code = classifyLineupExtractionFailure(extraction);
      return withCors(lineupErrorResponse(code, 422, {
        sourceUrl: source.url,
        ...(isDebug ? { debug: createDebugInfo(source.url, upstream.httpStatus, extraction) } : {})
      }), corsHeaders);
    }

    const responseBody = {
      ok: true,
      sourceUrl: source.url,
      fetchedAt: new Date().toISOString(),
      date: source.date,
      gameCode: source.gameCode,
      method: getExtractionMethod(extraction),
      team: "fighters",
      lineup: extraction.rows.map((row) => ({
        order: row.order,
        position: row.position,
        playerName: row.player
      })),
      lineupText: extraction.lineupText,
      cacheStatus: "miss",
      stale: false
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
  const normalizedGames = normalizeFightersScheduleGames(games, date).map((game) => ({
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
    const names = STARTER_TEAM_ALIASES.filter((team) => team.aliases.some((alias) => text.includes(alias))).map((team) => team.key);
    const unique = [...new Set(names)];
    const time = /\b([01]\d|2[0-3]):[0-5]\d\b/.exec(text)?.[0] || "";
    if (unique.length !== 2 || !time) continue;
    const scoreCode = /\/scores\/\d{4}\/\d{4}\/([a-z0-9]+-[a-z0-9]+-\d+)\//i.exec(row)?.[1] || "";
    result.push({ homeTeam: unique[0], awayTeam: unique[1], startTime: time, gameCode: scoreCode, venue: "", status: classifyOfficialCancellationText(text).officialCancelled ? "cancelled" : "scheduled" });
  }
  return result;
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
    return createLineupSourceFromIdentity(requestedDate, requestedGameCode);
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

  return createLineupSourceFromIdentity(validation.date, validation.gameCode);
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPB_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "Starting9 MVP Cloudflare Worker"
      }
    });

    if (!response.ok) {
      return { ok: false, code: "NPB_HTTP_ERROR", status: 502, httpStatus: response.status };
    }

    return { ok: true, html: await response.text(), httpStatus: response.status };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return { ok: false, code: isTimeout ? "TIMEOUT" : "WORKER_FETCH_FAILED", status: 502 };
  } finally {
    clearTimeout(timeoutId);
  }
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
  const validation = validateRosterUrl(rosterUrlValue);
  const forceRefresh = ["1", "true", "yes"].includes(String(requestUrl.searchParams.get("force") || "").toLowerCase());

  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  try {
    const source = await fetchRosterSource(requestUrl, validation.url, { forceRefresh });
    if (!source.ok) {
      return jsonResponse({ ok: false, code: "ROSTER_FETCH_FAILED", error: "NPB公式登録ページを取得できませんでした。" }, 502);
    }

    const html = source.html;
    const extraction = extractFightersRoster(html);

    if (!extraction.players.length) {
      return jsonResponse({
        ok: false,
        code: "ROSTER_PARSE_FAILED",
        error: "日本ハムの登録選手一覧を抽出できませんでした。",
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
      team: "fighters",
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(NOTICE_SOURCE_URL, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": "Starting9 MVP Cloudflare Worker"
      }
    });
    const contentType = response.headers.get("Content-Type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeNoticeHtml(bytes, contentType);
    const diagnostics = createNoticeSourceDiagnostics({
      contentType,
      httpStatus: response.status,
      bodyLength: bytes.byteLength,
      html: decoded.html,
      charset: decoded.charset
    });
    if (!response.ok) {
      return { ok: false, code: "NOTICE_FETCH_FAILED", httpStatus: response.status, diagnostics };
    }
    if (!isHtmlContentType(contentType)) {
      console.log(`[NPB_NOTICE] content-type-invalid source=${NOTICE_SOURCE_URL} status=${response.status} contentType=${contentType || "-"} bodyLength=${bytes.byteLength}`);
      return { ok: false, code: "NOTICE_CONTENT_TYPE_INVALID", httpStatus: response.status, diagnostics };
    }
    return {
      ok: true,
      html: decoded.html,
      httpStatus: response.status,
      contentType,
      bodyLength: bytes.byteLength,
      diagnostics,
      fetchedAt: new Date().toISOString(),
      cacheStatus: "bypass",
      stale: false
    };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "NPB公式公示ページの取得がタイムアウトしました。" : "NPB公式公示ページを取得できませんでした。" };
  } finally {
    clearTimeout(timer);
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
    const response = await fetch(sourceUrl, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
        "User-Agent": "Starting9 MVP Cloudflare Worker"
      }
    });

    if (!response.ok) {
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
      return { ok: false, error: `NPB公式登録ページを取得できませんでした。HTTP ${response.status}` };
    }

    const html = await response.text();
    const fetchedAt = new Date().toISOString();
    const headers = new Headers({
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": `public, max-age=${ROSTER_CACHE_TTL_SECONDS}`,
      "X-Starting9-Roster-Fetched-At": fetchedAt,
      "X-Starting9-Roster-Http-Status": String(response.status)
    });
    try {
      await cache.put(cacheKey, new Response(html, { headers }));
    } catch {
      // キャッシュ不調でも、今回の公式ページ取得結果は返す。
    }

    return {
      ok: true,
      html,
      httpStatus: response.status,
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
    const response = await fetch(STARTER_SOURCE_URL, {
      cache: "no-store",
      headers: {
        "User-Agent": "Starting9 MVP Cloudflare Worker"
      }
    });

    if (!response.ok) {
      return jsonResponse({
        ok: false,
        sourceUrl: STARTER_SOURCE_URL,
        fetchedAt,
        error: `NPB公式予告先発ページを取得できませんでした。HTTP ${response.status}`
      }, 502);
    }

    const html = await response.text();
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

function extractNpbOrderText(html) {
  const plainText = htmlToPlainText(html);
  const lines = normalizeNpbTextLines(plainText);
  const orderStartIndex = lines.findIndex((line) => line.includes("最新のオーダー"));
  const fightersTable = findFightersOrderTable(html);

  if (fightersTable) {
    const tableRows = parseTableRows(fightersTable);
    const validation = validateExtractedLineupRows(tableRows);
    if (validation.ok) {
      return createSuccessfulExtraction("table", tableRows, plainText, lines, orderStartIndex);
    }

    return createFailedExtraction("table-invalid", tableRows, plainText, lines, orderStartIndex, {
      foundFightersTeam: true,
      validationError: validation.reason
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

function extractFightersRoster(html) {
  const sourceHtml = String(html || "");
  const teamTablePattern = /<h5[^>]*>\s*北海道日本ハムファイターズ\s*<\/h5>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i;
  const tableMatch = sourceHtml.match(teamTablePattern);
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
      foundFightersHeading: Boolean(tableMatch),
      foundPlayers: players.length,
      announcedCount,
      warning,
      textExcerpt: lines.join(" ").slice(0, 1800),
      fightersExcerpt: createFightersRosterExcerpt(lines)
    }
  };
}

function parseRosterTableEntries(tableHtml) {
  const entries = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells = [];
    const cellPattern = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 3) {
      continue;
    }

    const position = cells[0].replace(/\s+/g, "");
    const number = cells[1].replace(/\s+/g, "");
    const name = normalizeRosterPlayerName(cells[2]);

    if (position && number && name) {
      entries.push({ position, number, name });
    }
  }

  return entries;
}

function uniqueRosterEntries(entries) {
  const seen = new Set();
  const players = [];

  entries.forEach((entry) => {
    const key = normalizeRosterPlayerKey(entry.name);
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
  extractScheduleGames,
  extractNpbOrderText,
  validateTargetUrl
};
