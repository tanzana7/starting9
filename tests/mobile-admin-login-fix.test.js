import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const adminApiSource = fs.readFileSync(path.join(root, "frontend/admin-v3/api-client.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

test("admin-v3はログイン画面へ安全に遷移し、元のURLへ戻れる", () => {
  assert.match(adminHtml, /id="adminLoginLink"/);
  assert.match(adminHtml, /auth=login/);
  assert.match(adminHtml, /returnTo=/);
  assert.match(adminSource, /function configureAdminLoginLink\(\)/);
  assert.match(adminSource, /loginUrl\.searchParams\.set\("returnTo", returnTo\)/);
  assert.match(authSource, /function redirectToAuthReturnTo\(\)/);
  assert.match(authSource, /window\.location\.replace\(returnTo\)/);
});

test("returnToは同一オリジンの相対URLだけを許可し、認証要求はcookie credentialsを送る", () => {
  assert.ok(authSource.includes('if (!value.startsWith("/") || value.startsWith("//")) return ""'));
  assert.match(authSource, /if \(target\.origin !== window\.location\.origin\) return ""/);
  assert.match(authSource, /credentials: "include"/);
  assert.match(adminApiSource, /credentials: "include"/);
});

test("login queryは認証状態確認後に未ログイン時だけモーダルを開く", () => {
  assert.match(authSource, /if \(!authState\.user && shouldOpenLoginFromQuery\(\)\)/);
  assert.match(authSource, /openAuthModal\("login"\)/);
  assert.match(authSource, /authState\.user = response\.authenticated \? response\.user : null/);
  assert.match(authSource, /redirectToAuthReturnTo\(\);/);
});

test("admin-v3は401、403、503、通信失敗を区別し、権限境界を変更しない", () => {
  assert.match(adminSource, /status === 401 \|\| error\?\.code === "AUTH_REQUIRED"/);
  assert.match(adminSource, /status === 403 \|\| error\?\.code === "ADMIN_ROLE_REQUIRED"/);
  assert.match(adminSource, /status === 503 \|\| error\?\.code === "D1_READ_LIMIT_EXCEEDED"/);
  assert.match(adminSource, /認証APIへ接続できません/);
  assert.match(workerSource, /SameSite=\$\{sameSite\}/);
  assert.match(workerSource, /"Access-Control-Allow-Credentials": "true"/);
  assert.match(workerSource, /if \(resolvedRole !== "admin"\)/);
});

test("既存manual roster / lineupの認証・IME・V4契約を変更しない", () => {
  const rosterSource = fs.readFileSync(path.join(root, "frontend/admin-v3/render-manual-roster.js"), "utf8");
  const lineupSource = fs.readFileSync(path.join(root, "frontend/admin-v3/render-manual-lineup.js"), "utf8");
  const coordinatorSource = fs.readFileSync(path.join(root, "frontend/admin-v3/app-coordinator.js"), "utf8");
  assert.match(adminApiSource, /manualRoster: "\/api\/admin\/v3\/manual-roster"/);
  assert.match(rosterSource, /data-v3-manual-roster-confirm/);
  assert.match(lineupSource, /data-v3-manual-lineup-finalize/);
  assert.match(coordinatorSource, /compositionend/);
  assert.match(fs.readFileSync(path.join(root, "admin-v3.html"), "utf8"), /render-manual-roster\.js/);
});
