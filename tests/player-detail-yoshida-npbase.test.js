const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const players = fs.readFileSync(path.join(root, "players.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("指定されたファイターズ選手は確定済みNPBase個別URLを持つ", () => {
  const expectedLinks = {
    "郡司裕也": "https://npbase.jp/players/f-8yhj0v",
    "進藤勇也": "https://npbase.jp/players/f-ckoojm",
    "吉田賢吾": "https://npbase.jp/players/f-1ndh33l",
    "田宮裕涼": "https://npbase.jp/players/f-17pwqx1",
    "上川畑大悟": "https://npbase.jp/players/f-16ef16m",
    "野村佑希": "https://npbase.jp/players/f-f0dol0",
    "カストロ": "https://npbase.jp/players/f-1tx69x3",
    "清宮幸太郎": "https://npbase.jp/players/f-1o4ka09",
    "有薗直輝": "https://npbase.jp/players/f-1sp62if",
    "水野達稀": "https://npbase.jp/players/f-ff2or2",
    "細川凌平": "https://npbase.jp/players/f-48itsm",
    "奈良間大己": "https://npbase.jp/players/f-1ogsyoy",
    "五十幡亮汰": "https://npbase.jp/players/f-1rd2j8y",
    "今川優馬": "https://npbase.jp/players/f-zwuzkb",
    "万波中正": "https://npbase.jp/players/f-yttgzb",
    "レイエス": "https://npbase.jp/players/f-1tybbot",
    "マルティネス": "https://npbase.jp/players/f-fx01ju",
    "清水優心": "https://npbase.jp/players/f-hrpoyu",
    "リン": "https://npbase.jp/players/f-36873h",
    "藤森海斗": "https://npbase.jp/players/f-13ny4he",
    "梅林優貴": "https://npbase.jp/players/f-1uppkus",
    "中島卓也": "https://npbase.jp/players/f-xefqsf",
    "阪口樂": "https://npbase.jp/players/f-7tugjj",
    "大塚瑠晏": "https://npbase.jp/players/f-4plurc",
    "半田南十": "https://npbase.jp/players/f-1kg6l7k",
    "山縣秀": "https://npbase.jp/players/f-pxuom",
    "明瀬諒介": "https://npbase.jp/players/f-1m5zpg7",
    "常谷拓輝": "https://npbase.jp/players/f-v25xs7",
    "柴田獅子": "https://npbase.jp/players/f-1u7vn8r",
    "西川遥輝": "https://npbase.jp/players/f-1gddgeu",
    "淺間大基": "https://npbase.jp/players/f-mtjvw6",
    "宮崎一樹": "https://npbase.jp/players/f-f6j0np",
    "エドポロケイン": "https://npbase.jp/players/f-ylxr6d",
    "水谷瞬": "https://npbase.jp/players/f-2rkir7",
    "山﨑福也": "https://npbase.jp/players/f-11yvncc",
    "矢澤宏太": "https://npbase.jp/players/f-1krpu0l"
  };

  for (const [name, url] of Object.entries(expectedLinks)) {
    const playerBlock = players.match(new RegExp(`name: "${name}"[\\s\\S]*?(?=\\n  \\},|$)`))?.[0];
    assert.ok(playerBlock, `${name} のplayers master登録が見つかりません`);
    assert.match(playerBlock, new RegExp(`npbasePlayerUrl: "${url.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`));
  }
  assert.equal((players.match(/npbasePlayerUrl:/g) || []).length, Object.keys(expectedLinks).length);
  assert.match(players, /aliases: \["吉田", "吉田賢", "吉田賢吾", "吉田 賢吾"/);
  assert.doesNotMatch(players, /name: "西川愛也"/);
});

test("選手カードに選択と分離した詳細導線を持つ", () => {
  assert.match(script, /detailButton\.className = "player-chip-detail-button"/);
  assert.match(script, /detailButton\.textContent = "詳細"/);
  assert.match(script, /event\.stopPropagation\(\)/);
  assert.match(script, /assignPlayerToActiveSlot\(pickerName, player\)/);
  assert.match(html, /id="predictionPlayerDetails" class="player-detail-overlay hidden"/);
});

test("詳細パネルは吉田の個別URL、他選手の汎用URL、NPBaseリンクを分ける", () => {
  assert.match(script, /const NPBASE_PLAYER_FALLBACK_URL = "https:\/\/npbase\.jp\/"/);
  assert.match(script, /function getNpbasePlayerUrl\(player\)/);
  assert.match(script, /選手成績を見る（NPBase）/);
  assert.doesNotMatch(script, /対予告先発成績（NPBase）/);
  assert.match(script, /function createProbableStarterHeadingHtml\(\)/);
  assert.match(script, /対予告先発成績/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(script, /成績表示は準備中です|現在はNPBaseへのリンクから確認できます/);
  assert.match(script, /この選手を選択/);
  assert.doesNotMatch(script, /NPBase公認|NPBase公式連携|提供: NPBase/);
});

test("詳細パネルは登録区分だけを表示し、内部候補分類を表示しない", () => {
  assert.match(script, /<dt>登録区分<\/dt><dd>\$\{escapeHtml\(player\.registeredPosition \|\| "未設定"\)\}<\/dd>/);
  assert.doesNotMatch(script, /<dt>S9上の扱い<\/dt>/);
  assert.doesNotMatch(script, /predictionCandidateLabel/);
  assert.doesNotMatch(script, /<dt>分類<\/dt>/);
  assert.match(players, /name: "矢澤宏太"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "野手運用候補"/);
  assert.match(players, /name: "山﨑福也"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "特殊DH候補"/);
  assert.match(players, /name: "柴田獅子"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "DH候補"/);
});

test("詳細パネルはPC modal、スマホ bottom sheet、閉じる操作を持つ", () => {
  assert.match(script, /function closePlayerDetails\(\)/);
  assert.match(script, /event\.key === "Escape"[\s\S]*?closePlayerDetails\(\)/);
  assert.match(script, /player-detail-close/);
  assert.match(css, /\.player-detail-overlay\s*\{[\s\S]*position: fixed[\s\S]*inset: 0/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.player-detail-overlay[\s\S]*align-items: end[\s\S]*\.player-detail-dialog[\s\S]*border-radius: 16px 16px 0 0/);
  assert.match(css, /\.player-detail-dialog\s*\{[\s\S]*width: min\(100%, 440px\)[\s\S]*padding: 24px/);
  assert.match(css, /\.player-detail-meta\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)/);
  assert.match(css, /\.player-detail-meta > div\s*\{[\s\S]*min-width: 0[\s\S]*padding: 12px 14px/);
  assert.match(css, /\.player-detail-positions\s*\{[\s\S]*flex-wrap: wrap[\s\S]*gap: 8px/);
  assert.match(css, /\.player-detail-links a\s*\{[\s\S]*max-width: 100%[\s\S]*padding: 10px 14px[\s\S]*min-height: 44px/);
  assert.match(css, /\.player-detail-select\s*\{[\s\S]*width: 100%[\s\S]*min-height: 46px/);
});

test("公開assetのcache busterは追加NPBaseリンク版へ更新される", () => {
  assert.match(html, /players\.js\?v=public-player-detail-modal-width-polish-1/);
  assert.match(html, /script\.js\?v=public-player-detail-modal-width-polish-1/);
  assert.match(html, /style\.css\?v=public-player-detail-modal-width-polish-1/);
});
