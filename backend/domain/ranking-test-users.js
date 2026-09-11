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

export const RANKING_TEST_DISPLAY_NAME_MIN_LENGTH = 1;
export const RANKING_TEST_DISPLAY_NAME_MAX_LENGTH = 16;

export function defaultRankingTestDisplayName(slot) {
  const normalizedSlot = normalizeRankingTestSlot(slot);
  return normalizedSlot ? rankingTestUsername(normalizedSlot) : "";
}

export function normalizeRankingTestDisplayName(value) {
  const name = String(value ?? "").normalize("NFKC").trim();
  if (!name) return { ok: true, value: "" };
  const length = Array.from(name).length;
  if (length < RANKING_TEST_DISPLAY_NAME_MIN_LENGTH || length > RANKING_TEST_DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, code: "RANKING_TEST_DISPLAY_NAME_LENGTH", error: `表示名は${RANKING_TEST_DISPLAY_NAME_MIN_LENGTH}〜${RANKING_TEST_DISPLAY_NAME_MAX_LENGTH}文字で入力してください。` };
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) {
    return { ok: false, code: "RANKING_TEST_DISPLAY_NAME_CONTROL", error: "表示名に制御文字は使用できません。" };
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
    return { ok: false, code: "RANKING_TEST_DISPLAY_NAME_CHARACTERS", error: "表示名は英数字、日本語、_、-のみ使用できます。" };
  }
  return { ok: true, value: name };
}

export function rankingTestDisplayNameKey(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

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
