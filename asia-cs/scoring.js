// Asia CS uses the same 100-point scoring contract as Starting9's current
// server scorer. Keeping this pure makes it usable by the isolated Worker and
// by the integration tests without importing the production V3/V4 runtime.

export const LINEUP_SIZE = 9;
export const MAX_SCORE = 100;
export const POSITIONS = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

const POSITION_ALIASES = Object.freeze({
  "捕": "捕", catcher: "捕", c: "捕",
  "一": "一", first: "一", "1b": "一",
  "二": "二", second: "二", "2b": "二",
  "三": "三", third: "三", "3b": "三",
  "遊": "遊", short: "遊", ss: "遊",
  "左": "左", left: "左", lf: "左",
  "中": "中", center: "中", cf: "中",
  "右": "右", right: "右", rf: "右",
  "指": "指", dh: "指", designatedhitter: "指"
});

export function normalizePosition(value) {
  const key = String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return POSITION_ALIASES[key] || "";
}

export function normalizeLineupItem(item = {}) {
  const playerId = String(item.playerId ?? item.player_id ?? "").trim();
  const playerName = String(item.playerName ?? item.player_name ?? item.name ?? "").trim().slice(0, 80);
  const battingOrder = Number(item.battingOrder ?? item.batting_order ?? item.order);
  return {
    battingOrder,
    playerId,
    playerName,
    position: normalizePosition(item.position)
  };
}

export function validateLineup(value, { label = "ラインナップ", rosterIds = null } = {}) {
  if (!Array.isArray(value) || value.length !== LINEUP_SIZE) {
    return { ok: false, error: `${label}は9人分入力してください。`, code: "LINEUP_SIZE_INVALID" };
  }

  const lineup = value.map(normalizeLineupItem).sort((a, b) => a.battingOrder - b.battingOrder);
  if (lineup.some((item) => !Number.isInteger(item.battingOrder) || item.battingOrder < 1 || item.battingOrder > LINEUP_SIZE)) {
    return { ok: false, error: `${label}の打順は1番から9番まで入力してください。`, code: "BATTING_ORDER_INVALID" };
  }
  if (new Set(lineup.map((item) => item.battingOrder)).size !== LINEUP_SIZE) {
    return { ok: false, error: `${label}の打順が重複しています。`, code: "DUPLICATE_BATTING_ORDER" };
  }
  if (lineup.some((item) => !item.playerId || !item.playerName)) {
    return { ok: false, error: `${label}の選手情報が不足しています。`, code: "PLAYER_REQUIRED" };
  }
  if (new Set(lineup.map((item) => item.playerId)).size !== LINEUP_SIZE) {
    return { ok: false, error: `${label}に同じ選手が複数います。`, code: "DUPLICATE_PLAYER" };
  }
  if (lineup.some((item) => !POSITIONS.includes(item.position))) {
    return { ok: false, error: `${label}の守備位置が不正です。`, code: "POSITION_INVALID" };
  }
  const nonDhPositions = lineup.map((item) => item.position).filter((position) => position !== "指");
  if (new Set(nonDhPositions).size !== nonDhPositions.length) {
    return { ok: false, error: `${label}に同じ守備位置が複数あります。`, code: "DUPLICATE_POSITION" };
  }
  if (rosterIds && lineup.some((item) => !rosterIds.has(item.playerId))) {
    return { ok: false, error: `${label}に出場選手として登録されていない選手が含まれています。`, code: "PLAYER_NOT_REGISTERED" };
  }
  return { ok: true, lineup };
}

export function scoreLineup(predictionLineup, actualLineup) {
  const actualByPlayerId = new Map(actualLineup.map((item) => [item.playerId, item]));
  let playerHits = 0;
  let orderHits = 0;
  let positionHits = 0;
  for (const prediction of predictionLineup) {
    const actual = actualByPlayerId.get(prediction.playerId);
    if (!actual) continue;
    playerHits += 1;
    if (actual.battingOrder === prediction.battingOrder) orderHits += 1;
    if (actual.position === prediction.position) positionHits += 1;
  }
  const playerScore = playerHits * 5 + (playerHits === LINEUP_SIZE ? 5 : 0);
  const orderScore = orderHits * 3 + (orderHits === LINEUP_SIZE ? 3 : 0);
  const positionScore = positionHits * 2 + (positionHits === LINEUP_SIZE ? 2 : 0);
  return {
    total: Math.min(MAX_SCORE, playerScore + orderScore + positionScore),
    counts: { player: playerHits, order: orderHits, position: positionHits }
  };
}
