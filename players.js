const players = [
  {
    name: "マルティネス",
    aliases: ["マルティネス"],
    category: "catcher",
    positions: ["一", "指", "左", "捕"],
    defaultPosition: null
  },
  {
    name: "郡司裕也",
    aliases: ["郡司", "郡司裕也", "郡司 裕也", "郡司　裕也"],
    category: "outfielder",
    positions: ["三", "一", "捕", "左"],
    defaultPosition: null
  },
  {
    name: "進藤勇也",
    aliases: ["進藤", "進藤勇", "進藤勇也", "進藤 勇也", "進藤　勇也"],
    category: "catcher",
    positions: ["捕"],
    defaultPosition: "捕"
  },
  {
    name: "吉田賢吾",
    aliases: ["吉田", "吉田賢", "吉田賢吾", "吉田 賢吾", "吉田　賢吾"],
    category: "catcher",
    positions: ["左", "中", "一", "捕", "二"],
    defaultPosition: null
  },
  {
    name: "田宮裕涼",
    aliases: ["田宮", "田宮裕", "田宮裕涼", "田宮 裕涼", "田宮　裕涼"],
    category: "catcher",
    positions: ["捕"],
    defaultPosition: "捕"
  },
  {
    name: "野村佑希",
    aliases: ["野村", "野村佑", "野村佑希", "野村 佑希", "野村　佑希"],
    category: "infielder",
    positions: ["三", "一", "左", "二"],
    defaultPosition: null
  },
  {
    name: "清宮幸太郎",
    aliases: ["清宮", "清宮幸", "清宮幸太郎", "清宮 幸太郎", "清宮　幸太郎"],
    category: "infielder",
    positions: ["一", "三", "左"],
    defaultPosition: null
  },
  {
    name: "水野達稀",
    aliases: ["水野", "水野達", "水野達稀", "水野 達稀", "水野　達稀"],
    category: "infielder",
    positions: ["遊", "二", "三"],
    defaultPosition: "遊"
  },
  {
    name: "大塚瑠晏",
    aliases: ["大塚", "大塚瑠", "大塚瑠晏", "大塚 瑠晏", "大塚　瑠晏"],
    category: "infielder",
    positions: ["二", "三", "遊"],
    defaultPosition: null
  },
  {
    name: "山縣秀",
    aliases: ["山縣", "山縣秀", "山縣 秀", "山縣　秀"],
    category: "infielder",
    positions: ["遊", "二", "三"],
    defaultPosition: null
  },
  {
    name: "細川凌平",
    aliases: ["細川", "細川凌", "細川凌平", "細川 凌平", "細川　凌平"],
    category: "infielder",
    positions: ["二", "遊", "三", "一", "左", "中", "右"],
    defaultPosition: null
  },
  {
    name: "奈良間大己",
    aliases: ["奈良間", "奈良間大", "奈良間大己", "奈良間 大己", "奈良間　大己"],
    category: "infielder",
    positions: ["二", "三", "遊"],
    defaultPosition: null
  },
  {
    name: "宮崎一樹",
    aliases: ["宮崎", "宮崎一", "宮崎一樹", "宮崎 一樹", "宮崎　一樹"],
    category: "outfielder",
    positions: ["中", "左", "右"],
    defaultPosition: null
  },
  {
    name: "五十幡亮汰",
    aliases: ["五十幡", "五十幡亮", "五十幡亮汰", "五十幡 亮汰", "五十幡　亮汰"],
    category: "outfielder",
    positions: ["中", "左", "右"],
    defaultPosition: "中"
  },
  {
    name: "水谷瞬",
    aliases: ["水谷", "水谷瞬", "水谷 瞬", "水谷　瞬"],
    category: "outfielder",
    positions: ["左", "中"],
    defaultPosition: null
  },
  {
    name: "万波中正",
    aliases: ["万波", "万波中", "万波中正", "万波 中正", "万波　中正"],
    category: "outfielder",
    positions: ["右", "中", "左"],
    defaultPosition: "右"
  },
  {
    name: "レイエス",
    aliases: ["レイエス"],
    category: "dh",
    positions: ["指", "一"],
    defaultPosition: "指"
  }
];

// 既存UIは名前の配列を使い、将来のUIはplayersの構造化データを参照する。
const playerNames = players.map((player) => player.name);
const playerAliases = Object.fromEntries(
  players.flatMap((player) => {
    const aliases = new Set([player.name, ...player.aliases]);
    return Array.from(aliases, (alias) => [
      alias.replace(/[\s\u3000]/g, ""),
      player.name
    ]);
  })
);
