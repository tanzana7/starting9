const LINEUP_SIZE = 9;
const ROSTER_CACHE_TTL_SECONDS = 30 * 60;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const FIGHTERS_TEAM_KEYWORDS = [
  "北海道日本ハムファイターズ",
  "北海道日本ハム",
  "日本ハム",
  "ファイターズ",
  "F"
];
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
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "GETリクエストのみ対応しています。" }, 405);
    }

    const requestUrl = new URL(request.url);
    const mode = requestUrl.searchParams.get("mode") || "lineup";
    if (mode === "starter") {
      return await handleStarterRequest(requestUrl.searchParams.get("debug") === "1");
    }
    const isDebug = requestUrl.searchParams.get("debug") === "1";

    if (mode === "roster") {
      return handleRosterRequest(requestUrl, isDebug);
    }

    const targetUrlValue = requestUrl.searchParams.get("url");
    const validation = validateTargetUrl(targetUrlValue);

    if (!validation.ok) {
      return jsonResponse({ ok: false, error: validation.error }, 400);
    }

    try {
      const response = await fetch(validation.url, {
        headers: {
          "User-Agent": "Starting9 MVP Cloudflare Worker"
        }
      });

      if (!response.ok) {
        return jsonResponse({ ok: false, error: `NPB公式ページを取得できませんでした。HTTP ${response.status}` }, 502);
      }

      const html = await response.text();
      const extraction = extractNpbOrderText(html);

      if (!extraction.lineupText) {
        return jsonResponse({
          ok: false,
          error: "スタメン候補を抽出できませんでした。",
          ...(isDebug ? { debug: createDebugInfo(validation.url, response.status, extraction) } : {})
        }, 422);
      }

      return jsonResponse({
        ok: true,
        sourceUrl: validation.url,
        fetchedAt: new Date().toISOString(),
        method: getExtractionMethod(extraction),
        team: "fighters",
        lineupText: extraction.lineupText
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: `NPB公式ページ取得中にエラーが発生しました：${error.message}` }, 500);
    }
  }
};

async function handleRosterRequest(requestUrl, isDebug) {
  const rosterUrlValue = requestUrl.searchParams.get("url") || "https://npb.jp/announcement/roster/";
  const validation = validateRosterUrl(rosterUrlValue);

  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  try {
    const source = await fetchRosterSource(requestUrl, validation.url);
    if (!source.ok) {
      return jsonResponse({ ok: false, error: source.error }, 502);
    }

    const html = source.html;
    const extraction = extractFightersRoster(html);

    if (!extraction.players.length) {
      return jsonResponse({
        ok: false,
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
    return jsonResponse({ ok: false, error: `NPB公式登録ページ取得中にエラーが発生しました：${error.message}` }, 500);
  }
}

async function fetchRosterSource(requestUrl, sourceUrl) {
  const cache = caches.default;
  const cacheKey = new Request(`${requestUrl.origin}/__starting9/roster-cache?source=${encodeURIComponent(sourceUrl)}`);
  let cached = null;
  try {
    const cachedResponse = await cache.match(cacheKey);
    cached = cachedResponse ? await readCachedRosterSource(cachedResponse) : null;
  } catch {
    // Cache APIの障害時も、公式ページへの新規取得は試みる。
  }

  if (cached && !cached.isExpired) {
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
      cacheStatus: "miss",
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

  if (targetUrl.hostname !== "npb.jp" && !targetUrl.hostname.endsWith(".npb.jp")) {
    return { ok: false, error: "npb.jp以外のURLは利用できません。" };
  }

  if (!targetUrl.pathname.startsWith("/scores/")) {
    return { ok: false, error: "https://npb.jp/scores/ 配下の試合ページURLを指定してください。" };
  }

  return { ok: true, url: targetUrl.href };
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
  const tableRows = extractRowsFromFightersTable(html);
  const plainText = htmlToPlainText(html);
  const lines = normalizeNpbTextLines(plainText);
  const orderStartIndex = lines.findIndex((line) => line.includes("最新のオーダー"));

  if (tableRows.length === LINEUP_SIZE) {
    return {
      lineupText: formatRowsForParser(tableRows),
      debug: buildExtractionDebug("table", plainText, lines, orderStartIndex, tableRows)
    };
  }

  const compactRows = extractRowsFromCompactText(lines.join(" "));
  if (compactRows.length === LINEUP_SIZE) {
    return {
      lineupText: formatRowsForParser(compactRows),
      debug: buildExtractionDebug("compact-text", plainText, lines, orderStartIndex, compactRows)
    };
  }

  const tokenRows = extractRowsFromTokens(lines);
  if (tokenRows.length === LINEUP_SIZE) {
    return {
      lineupText: formatRowsForParser(tokenRows),
      debug: buildExtractionDebug("token", plainText, lines, orderStartIndex, tokenRows)
    };
  }

  const searchStartIndex = orderStartIndex >= 0 ? orderStartIndex + 1 : 0;
  const fightersIndex = findFightersOrderStartIndex(lines, searchStartIndex);
  const candidateStartIndex = fightersIndex >= 0 ? fightersIndex + 1 : searchStartIndex;
  const fightersRows = collectNpbOrderRows(lines.slice(candidateStartIndex));

  if (fightersRows.length === LINEUP_SIZE) {
    return {
      lineupText: formatRowsForParser(fightersRows),
      debug: buildExtractionDebug("line", plainText, lines, orderStartIndex, fightersRows)
    };
  }

  const fallbackRows = collectNpbOrderRows(lines.slice(searchStartIndex));
  if (fallbackRows.length === LINEUP_SIZE) {
    return {
      lineupText: formatRowsForParser(fallbackRows),
      debug: buildExtractionDebug("line-fallback", plainText, lines, orderStartIndex, fallbackRows)
    };
  }

  return {
    lineupText: "",
    debug: buildExtractionDebug("no-9-rows", plainText, lines, orderStartIndex, tableRows)
  };
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

function extractRowsFromFightersTable(html) {
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

    const rows = parseTableRows(match[2]);
    if (rows.length >= LINEUP_SIZE) {
      return rows.slice(0, LINEUP_SIZE);
    }
  }

  return [];
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
    return index >= startIndex && FIGHTERS_TEAM_KEYWORDS.some((keyword) => line.includes(keyword));
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function isFightersTeamName(value) {
  return FIGHTERS_TEAM_KEYWORDS.some((keyword) => String(value || "").includes(keyword));
}

function findFightersTextStart(text) {
  const orderIndex = text.indexOf("最新のオーダー");
  const searchStartIndex = orderIndex >= 0 ? orderIndex : 0;
  let bestIndex = -1;

  for (const keyword of FIGHTERS_TEAM_KEYWORDS) {
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
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
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
