import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public period ranking stays absent while aggregation remains admin-only", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.doesNotMatch(html, /rankingPanel|frontend\/public\/render-ranking\.js/);
  assert.doesNotMatch(script, /\/api\/rankings\/(weekly|monthly|yearly)|\/api\/me\/ranking\/(weekly|monthly|yearly)/);
  assert.match(worker, /PUBLIC_RANKING_ADMIN_ONLY/);
  assert.match(worker, /adminRankingRoute/);
});
