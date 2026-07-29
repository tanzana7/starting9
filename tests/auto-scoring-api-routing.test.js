import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const authWorker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

test("自動採点テストのクライアントURLとWorkerルートのmethodが一致する", () => {
  assert.match(script, /\/api\/admin\/auto-scoring-tests\$\{path \? `\//);
  assert.match(script, /fetch\(buildAutoScoringTestApiUrl\(encodeURIComponent\(gameId\)\)/);
  assert.match(script, /fetch\(buildAutoScoringTestApiUrl\(\), \{ method: "POST"/);
  assert.match(script, /autoScoringTestRequest\(gameId, "answer-lineup"/);
  assert.match(script, /autoScoringTestRequest\(gameId, "prediction"/);
  assert.match(script, /data-auto-test-action="run"/);
  assert.match(script, /data-auto-test-action="retry"/);

  assert.match(authWorker, /path === "\/api\/admin\/auto-scoring-tests"/);
  assert.match(authWorker, /answer-lineup\|prediction\|run\|retry/);
  assert.match(authWorker, /route\.action === "collection" && request\.method === "GET"/);
  assert.match(authWorker, /route\.action === "collection" && request\.method === "POST"/);
  assert.match(authWorker, /route\.action === "detail" && request\.method === "GET"/);
  assert.match(authWorker, /route\.action === "answer-lineup" && request\.method === "POST"/);
  assert.match(authWorker, /route\.action === "prediction" && request\.method === "POST"/);
  assert.match(authWorker, /route\.action === "run" && request\.method === "POST"/);
  assert.match(authWorker, /route\.action === "retry" && request\.method === "POST"/);
});

test("状態再取得は未登録のrefresh APIへ送らず、既存の詳細GETを使う", () => {
  const refreshBranch = /if \(action === "refresh"\) \{([\s\S]*?)\n  \}/.exec(script)?.[1] || "";
  assert.match(refreshBranch, /loadAutoScoringTest\(gameId\)/);
  assert.doesNotMatch(refreshBranch, /autoScoringTestRequest/);
});

test("修正前に到達していたrefresh URLはWorkerのフォールバックへ到達する", async () => {
  const response = await worker.fetch(
    new Request("https://auth.test/api/admin/auto-scoring-tests/test-game/refresh", { method: "POST" }),
    { AUTH_DB: {} },
    {}
  );
  const payload = await response.json();
  assert.equal(response.status, 404);
  assert.equal(payload.error, "認証APIのパスまたはHTTPメソッドが不正です。");
});
