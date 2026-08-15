// WorkerがNPBの表示名を既存のF-背番号形式へ安全に変換するための最小マスタ。
// players.js の背番号・aliasesを更新した場合は、このファイルも同時に更新する。
export const FIGHTERS_TEAM_CODE = "fighters";
export const FIGHTERS_TEAM_ID = "F";
export const FIGHTERS_PLAYER_MASTER = [
  ["マルティネス","2",["マルティネス"]], ["郡司裕也","3",["郡司","郡司裕也"]], ["清水優心","10",["清水","清水優心"]],
  ["進藤勇也","33",["進藤","進藤勇也"]], ["リン","38",["リン"]], ["藤森海斗","57",["藤森","藤森海斗"]],
  ["吉田賢吾","60",["吉田賢","吉田賢吾"]], ["田宮裕涼","64",["田宮","田宮裕涼"]], ["梅林優貴","98",["梅林","梅林優貴"]],
  ["上川畑大悟","4",["上川畑","上川畑大悟"]], ["野村佑希","5",["野村","野村佑希"]], ["カストロ","6",["カストロ","R.カストロ","Ｒ．カストロ"]],
  ["中島卓也","9",["中島","中島卓也"]], ["清宮幸太郎","21",["清宮","清宮幸太郎"]], ["有薗直輝","39",["有薗","有薗直輝"]],
  ["水野達稀","43",["水野","水野達稀"]], ["阪口樂","44",["阪口","阪口樂","阪口楽"]], ["大塚瑠晏","49",["大塚","大塚瑠晏"]],
  ["半田南十","51",["半田","半田南十"]], ["山縣秀","54",["山縣","山縣秀"]], ["細川凌平","56",["細川","細川凌平"]],
  ["奈良間大己","58",["奈良間","奈良間大己"]], ["常谷拓輝","95",["常谷","常谷拓輝","常谷 拓輝","常谷　拓輝","ツネヤ ヒロキ","ツネヤヒロキ"]], ["柴田獅子","31",["柴田","柴田獅子","柴田 獅子","柴田　獅子","シバタ レオ","シバタレオ"]], ["明瀬諒介","65",["明瀬","明瀬諒介"]], ["西川遥輝","7",["西川","西川遥輝"]],
  ["淺間大基","8",["淺間","浅間","淺間大基","浅間大基"]], ["宮崎一樹","36",["宮崎","宮崎一樹"]], ["エドポロケイン","42",["エドポロ","エドポロケイン"]],
  ["五十幡亮汰","50",["五十幡","五十幡亮汰"]], ["水谷瞬","53",["水谷","水谷瞬"]], ["今川優馬","61",["今川","今川優馬"]],
  ["万波中正","66",["万波","万波中正"]], ["レイエス","99",["レイエス","F.レイエス","Ｆ．レイエス"]], ["矢澤宏太","12",["矢澤","矢沢","矢澤宏太","矢沢宏太"]]
].map(([name, uniformNumber, aliases]) => ({ name, uniformNumber, aliases }));

export function normalizeFightersPlayerName(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "").replace(/[．。]/g, ".").toLowerCase();
}

export function findFightersPlayerByName(name) {
  const normalized = normalizeFightersPlayerName(name);
  if (!normalized) return null;
  const matches = FIGHTERS_PLAYER_MASTER.filter((player) => [player.name, ...player.aliases]
    .some((candidate) => normalizeFightersPlayerName(candidate) === normalized));
  return matches.length === 1 ? matches[0] : null;
}

function findFightersPlayerByUniformNumber(uniformNumber) {
  const normalized = String(uniformNumber || "").trim();
  if (!normalized) return null;
  const matches = FIGHTERS_PLAYER_MASTER.filter((player) => player.uniformNumber === normalized);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveFightersRosterEntry(entry) {
  const byName = findFightersPlayerByName(entry?.name);
  const byUniformNumber = findFightersPlayerByUniformNumber(entry?.number);
  if (byName && byUniformNumber && byName.uniformNumber !== byUniformNumber.uniformNumber) {
    return { player: null, reasonCode: "ROSTER_PLAYER_UNMAPPED_FROM_SOURCE" };
  }
  if (byName) return { player: byName, resolvedBy: "alias" };
  if (byUniformNumber) return { player: byUniformNumber, resolvedBy: "uniform_number" };
  return {
    player: null,
    reasonCode: entry?.name ? "ROSTER_PLAYER_MISSING_FROM_MASTER" : "ROSTER_PLAYER_UNMAPPED_FROM_SOURCE"
  };
}

export function inspectFightersRosterMaster(entries) {
  const unresolvedPlayers = [];
  let resolvedCount = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const resolution = resolveFightersRosterEntry(entry);
    if (resolution.player) {
      resolvedCount += 1;
      continue;
    }
    unresolvedPlayers.push({
      name: String(entry?.name || "").slice(0, 80),
      number: String(entry?.number || "").slice(0, 20),
      reasonCode: resolution.reasonCode
    });
  }
  const reasonCode = unresolvedPlayers.find((entry) => entry.reasonCode === "ROSTER_PLAYER_MISSING_FROM_MASTER")
    ? "ROSTER_PLAYER_MISSING_FROM_MASTER"
    : unresolvedPlayers[0]?.reasonCode || "ROSTER_PLAYERS_RESOLVED";
  return {
    status: unresolvedPlayers.length ? "attention" : "resolved",
    reasonCode,
    resolvedCount,
    unresolvedCount: unresolvedPlayers.length,
    unresolvedPlayers: unresolvedPlayers.slice(0, 20)
  };
}

export function createFightersPlayerId(uniformNumber) {
  return typeof uniformNumber === "string" && uniformNumber ? `${FIGHTERS_TEAM_ID}-${uniformNumber}` : null;
}
