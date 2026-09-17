const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("public予想の2ペイン幅を変えず、PC操作領域だけ縦方向を約15%広げる", () => {
  assert.match(html, /style\.css\?v=[^"']*public-prediction-height-15-1/);
  assert.match(
    css,
    /@media \(min-width: 900px\)[\s\S]*?\.lineup-slot\[data-picker="prediction"\]\s*\{[\s\S]*?min-height: 55px;[\s\S]*?padding-block: 8px;/
  );
  assert.match(
    css,
    /@media \(min-width: 900px\)[\s\S]*?\.player-list \.player-chip\s*\{[\s\S]*?min-height: 51px;[\s\S]*?padding-block: 10px;/
  );
  const heightBlockStart = css.indexOf("/* 公開予想の2ペイン構成は変えず");
  const heightBlockEnd = css.indexOf("/* Keep the public editing target distinct", heightBlockStart);
  const heightBlock = css.slice(heightBlockStart, heightBlockEnd === -1 ? undefined : heightBlockEnd);
  assert.doesNotMatch(heightBlock, /grid-template-columns|(?:^|\s)gap:|(?:^|\s)width:|max-width:/);
});

test("公開候補一覧は従来どおり2列で、roster sourceの表示ロジックを変更しない", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.player-list\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /data-roster-filter="active"/);
  assert.match(html, /data-roster-filter="inactive"/);
});
