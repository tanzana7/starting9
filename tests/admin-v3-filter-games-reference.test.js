const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("admin game progress renderer receives the filterGames dependency it uses", () => {
  const renderer = read("frontend/admin-v3/render-game-progress.js");
  const entry = read("admin-v3.js");
  const signatureStart = renderer.indexOf("function createAdminV3GameProgressRenderer");
  const signatureEnd = renderer.indexOf(") {", signatureStart);
  const rendererSignature = renderer.slice(signatureStart, signatureEnd);
  const configStart = entry.indexOf("const v3GameProgressRenderer =");
  const configEnd = entry.indexOf("});", configStart);
  const entryConfig = entry.slice(configStart, configEnd);

  assert.match(rendererSignature, /\bfilterGames\b/);
  assert.match(renderer, /const todayGames = filterGames\(allGames, "today"\)/);
  assert.match(entryConfig, /filterGames: filteredV3Games/);
});

test("admin-v3 static assets use the filterGames hotfix cache buster", () => {
  const html = read("admin-v3.html");

  assert.match(html, /admin-v3-all-job-manual-controls-1/);
  assert.doesNotMatch(html, /admin-v3-render-modules-1/);
});
