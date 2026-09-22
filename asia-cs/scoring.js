import {
  SCORING_LINEUP_SIZE,
  SCORING_MAX_SCORE,
  scorePredictionLineup
} from "../backend/domain/scoring.js";

// Validation is Asia CS transport/domain glue; score calculation remains the
// canonical Starting9 scorer so an isolated Worker cannot diverge in points.
export const LINEUP_SIZE = SCORING_LINEUP_SIZE;
export const MAX_SCORE = SCORING_MAX_SCORE;
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
  return scorePredictionLineup(predictionLineup, actualLineup);
}
