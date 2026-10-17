const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("TARGET canonical cutover keeps an exact dual-origin allowlist", () => {
  const auth = JSON.parse(read("wrangler.auth.target.production.jsonc"));
  const npb = JSON.parse(read("wrangler.npb.target.jsonc"));
  for (const origins of [auth.vars.AUTH_ALLOWED_ORIGINS, npb.vars.NPB_ALLOWED_ORIGINS]) {
    assert.match(origins, /https:\/\/starting9\.pages\.dev/);
    assert.match(origins, /https:\/\/starting9-app\.pages\.dev/);
    assert.doesNotMatch(origins, /\*/);
  }
});
test("Pages deployment guard targets only the permanent TARGET project", () => {
  const guard = require(path.join(root, "tooling/production-deploy.cjs"));
  assert.deepEqual(guard.ACTIONS.pages, {
    config: null,
    profile: "starting9-target",
    project: "starting9-app"
  });
  assert.deepEqual(guard.buildWranglerArgs(root, "pages", "a".repeat(40)), [
    "wrangler", "pages", "deploy", ".", "--project-name", "starting9-app", "--branch", "main",
    "--profile", "starting9-target", "--commit-hash", "a".repeat(40), "--commit-message", "production-pages-aaaaaaaaaaaa"
  ]);
});

test("Pages proxy and metadata use the TARGET canonical origin", () => {
  const html = read("index.html");
  const deployGuard = read("tooling/production-deploy.cjs");
  assert.match(html, /https:\/\/starting9-app\.pages\.dev\//);
  assert.doesNotMatch(html, /https:\/\/starting9\.pages\.dev\//);
  assert.match(deployGuard, /TARGET_PAGES_PROJECT = "starting9-app"/);
  assert.match(deployGuard, /profile: TARGET_PROFILE/);
  assert.doesNotMatch(deployGuard, /SOURCE_PROFILE/);
});

test("NPB fallback and analytics recognize the new canonical host without wildcarding", () => {
  const npb = read("cloudflare-worker.js");
  const analytics = read("frontend/public/analytics.js");
  assert.match(npb, /https:\/\/starting9-app\.pages\.dev/);
  assert.match(analytics, /starting9-app\.pages\.dev/);
  assert.doesNotMatch(analytics, /hostname === "starting9-app\.pages\.dev"\s*\|\|\s*true/);
});
