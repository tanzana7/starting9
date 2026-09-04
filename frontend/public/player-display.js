(function initStarting9PlayerDisplay(global) {
  const publicFrontend = global.Starting9Public = global.Starting9Public || {};

  // Display-only overrides. Canonical player names, aliases, IDs, and scoring keys stay untouched.
  const japaneseNameDisplayMap = Object.freeze({
    郡司裕也: "郡司 裕也",
    清水優心: "清水 優心",
    進藤勇也: "進藤 勇也",
    藤森海斗: "藤森 海斗",
    吉田賢吾: "吉田 賢吾",
    田宮裕涼: "田宮 裕涼",
    梅林優貴: "梅林 優貴",
    上川畑大悟: "上川畑 大悟",
    野村佑希: "野村 佑希",
    中島卓也: "中島 卓也",
    清宮幸太郎: "清宮 幸太郎",
    有薗直輝: "有薗 直輝",
    水野達稀: "水野 達稀",
    阪口樂: "阪口 樂",
    大塚瑠晏: "大塚 瑠晏",
    半田南十: "半田 南十",
    山縣秀: "山縣 秀",
    細川凌平: "細川 凌平",
    奈良間大己: "奈良間 大己",
    明瀬諒介: "明瀬 諒介",
    常谷拓輝: "常谷 拓輝",
    柴田獅子: "柴田 獅子",
    西川遥輝: "西川 遥輝",
    淺間大基: "淺間 大基",
    宮崎一樹: "宮崎 一樹",
    五十幡亮汰: "五十幡 亮汰",
    水谷瞬: "水谷 瞬",
    今川優馬: "今川 優馬",
    万波中正: "万波 中正",
    山﨑福也: "山﨑 福也",
    矢澤宏太: "矢澤 宏太"
  });

  function compactName(value) {
    return String(value || "").replace(/[\s\u3000]/g, "");
  }

  function getPlayerDetails(player) {
    const source = typeof player === "object" && player !== null ? player : null;
    const candidates = [source?.name, source?.playerName, source?.displayName, player];
    const details = global.Starting9FightersPlayerDetails;
    if (!details) return null;
    for (const candidate of candidates) {
      const detail = details[compactName(candidate)];
      if (detail) return detail;
    }
    return null;
  }

  function formatJapanesePlayerNameForDisplay(name, playerMeta = null) {
    const raw = String(name || "").trim();
    if (!raw) return raw;

    const familyName = String(playerMeta?.familyName || playerMeta?.lastName || playerMeta?.surname || "").trim();
    const givenName = String(playerMeta?.givenName || playerMeta?.firstName || "").trim();
    const compact = compactName(raw);
    if (familyName && givenName && compact === compactName(`${familyName}${givenName}`)) {
      return `${familyName} ${givenName}`;
    }

    return japaneseNameDisplayMap[compact] || raw;
  }

  function formatPlayerNameForDisplay(player, playerMeta = null) {
    const source = typeof player === "object" && player !== null
      ? player.name ?? player.playerName ?? player.displayName ?? ""
      : player;
    const metadata = typeof player === "object" && player !== null ? player : playerMeta;
    return formatJapanesePlayerNameForDisplay(source, metadata);
  }

  function normalizeBattingHand(value) {
    const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase();
    if (!normalized) return "";
    if (["r", "rh", "right", "右", "右打", "右打ち"].includes(normalized)) return "right";
    if (["l", "lh", "left", "左", "左打", "左打ち"].includes(normalized)) return "left";
    if (["s", "switch", "both", "両", "両打", "両打ち", "スイッチ"].includes(normalized)) return "switch";
    return "";
  }

  function readBattingHand(value) {
    if (!value || typeof value !== "object") return "";
    const directFields = ["bats", "battingSide", "batSide", "battingHand"];
    for (const field of directFields) {
      const hand = normalizeBattingHand(value[field]);
      if (hand) return hand;
    }

    const nested = [value.handedness, value.metadata, value.meta, value.rawMetadata, value.raw];
    for (const entry of nested) {
      if (typeof entry === "string") {
        const explicit = entry.normalize("NFKC").toLowerCase();
        if (explicit.includes("左打") || explicit.includes("left-handed batter") || explicit.includes("left-handed hitter")) return "left";
        if (explicit.includes("両打") || explicit.includes("switch-hitter") || explicit.includes("switch hitter")) return "switch";
        if (explicit.includes("右打") || explicit.includes("right-handed batter") || explicit.includes("right-handed hitter")) return "right";
      }
      if (!entry || typeof entry !== "object") continue;
      for (const field of directFields) {
        const hand = normalizeBattingHand(entry[field]);
        if (hand) return hand;
      }
    }
    return normalizeBattingHand(getPlayerDetails(value)?.battingHand);
  }

  function getPlayerBattingHandedness(player) {
    return readBattingHand(player);
  }

  function getPlayerBattingClass(player) {
    const hand = getPlayerBattingHandedness(player);
    return hand ? `player-name--bat-${hand}` : "";
  }

  function normalizePlayerNumber(value) {
    const normalized = String(value ?? "").normalize("NFKC").trim();
    return /^\d{1,3}$/.test(normalized) ? normalized : "";
  }

  function getPlayerUniformNumber(player) {
    if (!player || typeof player !== "object") return "";
    const fields = ["uniformNumber", "jerseyNumber", "number", "playerNumber", "backNumber", "uniform_no", "jersey_no"];
    const sources = [player, player.metadata, player.meta, player.rawMetadata, player.raw];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const field of fields) {
        const number = normalizePlayerNumber(source[field]);
        if (number) return number;
      }
    }
    return "";
  }

  publicFrontend.formatJapanesePlayerNameForDisplay = formatJapanesePlayerNameForDisplay;
  publicFrontend.formatPlayerNameForDisplay = formatPlayerNameForDisplay;
  publicFrontend.getPlayerBattingHandedness = getPlayerBattingHandedness;
  publicFrontend.getPlayerBattingClass = getPlayerBattingClass;
  publicFrontend.getPlayerUniformNumber = getPlayerUniformNumber;
  publicFrontend.getPlayerDetails = getPlayerDetails;
})(typeof window !== "undefined" ? window : globalThis);
