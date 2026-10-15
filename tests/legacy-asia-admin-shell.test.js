const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("legacy Asia admin asset retains a script-free canonical redirect and fallback", () => {
  const html = read("asia-cs/public/admin.html");
  const target = "/admin-v3.html?edition=asia";
  assert.match(html, /<html lang="ja">/);
  const redirects = [...html.matchAll(/<meta\b[^>]*http-equiv="refresh"[^>]*content="0; url=([^"]+)"/g)];
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0][1], target);
  assert.ok(html.includes(`<a href="${target}">`));
  assert.doesNotMatch(html, /<(?:form|input|select|textarea|button|script|section|table)\b/i);
  assert.doesNotMatch(html, /\b(?:id|class|style|on\w+)\s*=/i);
  assert.doesNotMatch(html, /value="asia-cs"|rel="stylesheet"/);
});

test("Pages legacy URL mapping preserves the same asset and canonical Asia admin dependencies", () => {
  const redirects = read("_redirects");
  const wildcard = "/asia-cs/* /asia-cs/public/:splat 200";
  assert.ok(redirects.includes(wildcard));
  for (const alias of ["/asia-cs/admin.html", "/asia-cs/public/admin.html", "/asia-cs/public/admin"]) {
    const rule = `${alias} /admin-v3.html?edition=asia 302`;
    assert.ok(redirects.includes(rule));
    assert.ok(redirects.indexOf(rule) < redirects.indexOf(wildcard));
  }
  const html = read("admin-v3.html");
  for (const id of ["npbAdminEditionContent", "asiaAdminEditionContent", "competitionForm", "gameForm", "gameId", "teamForm", "rosterForm", "lineupJson", "confirmLineup", "scoreGame", "rankingGame", "publishGame", "rescoreGame", "placementGameForm", "prepareDryRunFixture", "activateDryRunFixture"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} remains in canonical admin`);
  }
  assert.match(html, /<script type="module" src="\/asia-cs\/admin\.js\?/);
  assert.match(html, /<script[^>]*src="\/asia-cs\/admin-action-guardrails\.js/);
  assert.match(html, /name="id" value="apbc-2026" readonly required/);
  assert.doesNotMatch(html, /id="loadGame"/);
  assert.doesNotMatch(read("asia-cs/public/admin.js"), /\$\("loadGame"\)/);
});
