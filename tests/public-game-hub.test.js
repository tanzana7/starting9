const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const script = read("script.js");
const css = read("style.css");

test("公開トップからGame Hubのカード・切替UI・専用CSSを撤去する", () => {
  assert.doesNotMatch(html, /publicGameHub|GAME HUB|試合を選ぶ/);
  assert.doesNotMatch(script, /publicGameHub|public-game-hub|selectPublicGame|handlePublicGameHubClick|publicGameSelection:\s*\{/);
  assert.doesNotMatch(css, /public-game-hub/);
  assert.match(html, /id="publicGameSelectionMeta"/);
});

test("試合単位のlocalStorage分離とstale response guardは維持する", () => {
  assert.match(script, /function getGameScopedStorageKey\(key, gameId\)/);
  assert.match(script, /legacyGameId === gameId/);
  assert.match(script, /function hydrateGameScopedState\(gameId\)/);
  assert.match(script, /beginPublicRequest\("account", \{ abort: true \}\)/);
  assert.match(read("frontend/public/probable-starter.js"), /deps\.requestGuard\.begin\("probable", \{ abort: true \}\)/);
  assert.match(script, /state\.probableStarter\.nextGame\?\.internalGameId/);
});

test("公開トップは新しいcache busterで単一試合表示を配信する", () => {
  assert.match(html, /style\.css\?v=public-single-game-1/);
  assert.match(html, /script\.js\?v=public-single-game-1/);
});
