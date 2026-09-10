export const RANKING_TEST_SLOT_MIN = 1;
export const RANKING_TEST_SLOT_MAX = 9;
export const RANKING_TEST_POSITION_LABELS = Object.freeze({
  0: "DH",
  1: "投",
  2: "捕",
  3: "一",
  4: "二",
  5: "三",
  6: "遊",
  7: "左",
  8: "中",
  9: "右"
});
export const RANKING_TEST_POSITION_CANONICAL = Object.freeze({
  0: "指",
  1: "投",
  2: "捕",
  3: "一",
  4: "二",
  5: "三",
  6: "遊",
  7: "左",
  8: "中",
  9: "右"
});

export function rankingTestUsername(slot) {
  return `S9_TEST_${Number(slot)}`;
}

export function normalizeRankingTestSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= RANKING_TEST_SLOT_MIN && slot <= RANKING_TEST_SLOT_MAX ? slot : null;
}

export function normalizeRankingTestPosition(value) {
  const position = String(value ?? "").normalize("NFKC").trim();
  return Object.prototype.hasOwnProperty.call(RANKING_TEST_POSITION_CANONICAL, position)
    ? RANKING_TEST_POSITION_CANONICAL[position]
    : null;
}

export function createRankingTestRows() {
  return Array.from({ length: RANKING_TEST_SLOT_MAX }, (_, index) => ({
    battingOrder: index + 1,
    uniformNumber: "",
    position: ""
  }));
}
