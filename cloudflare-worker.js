const LINEUP_SIZE = 9;
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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "GETリクエストのみ対応しています。" }, 405);
    }

    const requestUrl = new URL(request.url);
    const targetUrlValue = requestUrl.searchParams.get("url");
    const isDebug = requestUrl.searchParams.get("debug") === "1";
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
        lineupText: extraction.lineupText
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: `NPB公式ページ取得中にエラーが発生しました：${error.message}` }, 500);
    }
  }
};

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
