import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Pagesの相対/apiはAsia CS Workerだけへ転送する接続契約を満たす", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const wrangler = fs.readFileSync(path.join(root, "asia-cs/wrangler.jsonc"), "utf8");
  const readme = fs.readFileSync(path.join(root, "asia-cs/README.md"), "utf8");
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  const pagesProxySource = fs.readFileSync(path.join(root, "functions/api/[[path]].js"), "utf8");
  assert.match(wrangler, /"name"\s*:\s*"starting9-asia-cs-api"/);
  assert.match(wrangler, /"database_name"\s*:\s*"starting9-asia-cs-db"/);
  assert.doesNotMatch(wrangler, /"triggers"\s*:/);
  assert.match(app, /API_PREFIX/);
  assert.match(app, /replace\(\/\^\\\/api/);
  assert.match(app, /\/api\/auth\/me/);
  assert.match(readme, /starting9\.pages\.dev\/api\/asia-cs/);
  assert.match(readme, /standalone Pages.*DEV ONLY/);
  assert.match(pagesProxySource, /ASIA_CS_API_ORIGIN/);
  assert.match(pagesProxySource, /\/api\/asia-cs/);

  const env = {
    DB: { prepare() { return { bind() { return this; }, async first() { return null; } }; } },
    ALLOWED_ORIGIN: "https://asia-cs.example"
  };
  async function pagesProxy(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("pages", { status: 200 });
    return worker.default.fetch(new Request(`https://starting9-asia-cs-api.test${url.pathname}${url.search}`, request), env, {});
  }

  const response = await pagesProxy(new Request("https://asia-cs.example/api/auth/me", { headers: { Origin: "https://asia-cs.example" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, authenticated: false, user: null });
});
