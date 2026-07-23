import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerModuleUrl = pathToFileURL(path.join(root, "cloudflare-worker.js")).href;

test("mode=scheduleはHTMLエンティティを既存decodeHtmlで処理してJSONを返す", async () => {
  const { default: worker } = await import(workerModuleUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><title>試合日程</title><body><table>
      <tr><th>7/23</th></tr>
      <tr><td>&#26085;&#26412;&#12495;&#12512; &amp; テスト</td><td>楽天</td><td>18:00</td></tr>
    </table></body></html>
  `, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } });
  try {
    const response = await worker.fetch(new Request("https://npb-fetch.internal/?mode=schedule&date=2026-07-23"), {});
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.games.length, 1);
    assert.equal(body.games[0].homeTeam, "fighters");
    assert.equal(body.games[0].awayTeam, "eagles");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("日程解析はdecodeHtmlEntitiesへの未定義参照を残さない", async () => {
  const fs = await import("node:fs");
  const worker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
  assert.doesNotMatch(worker, /decodeHtmlEntities/);
  assert.match(worker, /decodeHtml\(row\.replace/);
  assert.match(worker, /String\.fromCodePoint/);
  assert.match(worker, /#\(\\d\+\)/);
});
