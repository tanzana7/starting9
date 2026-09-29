const POSITION_ALIASES = Object.freeze({
  "捕": "捕", C: "捕", "キャッチャー": "捕", "2": "捕",
  "一": "一", "1B": "一", "ファースト": "一", "3": "一",
  "二": "二", "2B": "二", "セカンド": "二", "4": "二",
  "三": "三", "3B": "三", "サード": "三", "5": "三",
  "遊": "遊", SS: "遊", "ショート": "遊", "6": "遊",
  "左": "左", LF: "左", "レフト": "左", "7": "左",
  "中": "中", CF: "中", "センター": "中", "8": "中",
  "右": "右", RF: "右", "ライト": "右", "9": "右",
  "指": "指", DH: "指", D: "指", "指名打者": "指", "0": "指"
});

// Scoring, manual lineup, and shadow comparison must share this map so that
// source labels such as "1B" and the admin label "一" cannot create a false
// mismatch. Keep the canonical values aligned with the scoring domain.
export function normalizeScoringPosition(value) {
  const key = String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  return POSITION_ALIASES[key] || "";
}

export { POSITION_ALIASES };
