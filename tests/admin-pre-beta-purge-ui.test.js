import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("admin-v3.html");
const admin = read("admin-v3.js");
const api = read("frontend/admin-v3/api-client.js");
const coordinator = read("frontend/admin-v3/app-coordinator.js");
const renderer = read("frontend/admin-v3/render-pre-beta-purge.js");
const worker = read("auth-worker.js");

test("公開前データdry-runはadmin-v3の一時viewとして読み取り専用で配信される", () => {
  assert.match(html, /data-v3-view="pre-beta-purge">公開前データdry-run/);
  assert.match(html, /render-pre-beta-purge\.js\?v=pre-beta-purge-1/);
  assert.match(html, /admin-v3\.css\?v=[^\"]*pre-beta-purge-ui-1/);
  assert.match(html, /admin-v3\.js\?v=[^\"]*pre-beta-purge-1/);
  assert.match(admin, /"pre-beta-purge"/);
  assert.match(admin, /loadPreBetaPurge/);
});

test("dry-run画面は対象試合・件数・保持対象・Cron・active jobを表示する", () => {
  assert.match(renderer, /targetGames/);
  assert.match(renderer, /counts/);
  assert.match(renderer, /gameAutomationV3/);
  assert.match(renderer, /gameJobs/);
  assert.match(renderer, /users、sessions/);
  assert.match(renderer, /削除POST/);
  assert.doesNotMatch(renderer, /data-v3-pre-beta-purge-execute/);
});

test("dry-run API clientは同一originのGETだけを提供する", () => {
  assert.match(api, /preBetaPurge: "\/api\/admin\/maintenance\/pre-beta-purge"/);
  assert.match(api, /getPreBetaPurgePlan: \(\) => request\(ADMIN_V3_ENDPOINTS\.preBetaPurge\)/);
  assert.match(api, /credentials: "include"/);
  assert.doesNotMatch(api, /executePreBetaPurge/);
});

test("dry-run view refreshは既存のevent delegationへ接続される", () => {
  assert.match(coordinator, /data-v3-pre-beta-purge-refresh/);
  assert.match(admin, /refreshPreBetaPurge: loadPreBetaPurge/);
});

test("削除POSTは別の明示的な実行フラグがない限りWorker側でも無効", () => {
  assert.match(worker, /PRE_BETA_PURGE_ALLOW_EXECUTE/);
  assert.match(worker, /PRE_BETA_PURGE_CRON_MUST_BE_STOPPED/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /request\.method === "GET"/);
});

test("非adminは既存のadmin session境界を通過しないと画面データを取得できない", () => {
  assert.match(admin, /const session = await v3Api\.getSession\(\);[\s\S]*?if \(!session\.admin\)/);
  assert.match(worker, /async function handleAdminPreBetaPurge\(request, env, cors\)[\s\S]*?await requireAdminUser\(request, env, cors\)/);
});
