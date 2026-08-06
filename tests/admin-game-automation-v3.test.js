import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");

test("V3管理画面は既存セッションと管理者APIを使い、サーバー認可を要求する", () => {
  assert.match(page, /admin-v3\.js/);
  assert.match(client, /credentials:\s*["']include/);
  assert.match(client, /\/api\/admin\/me/);
  assert.match(worker, /\/api\/admin\/v3\/overview/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
});

test("V3管理操作は巨大処理を直接実行せず、V3 jobを投入する", () => {
  assert.match(worker, /parseAdminV3JobRoute/);
  assert.match(worker, /createV3Job\(env\.AUTH_DB/);
  assert.doesNotMatch(worker, /handleAdminV3JobCreate[\s\S]{0,500}runScheduledGameAutomation\(/);
});

test("V3管理画面はNPB自動解決jobの予定・結果・retryを表示する", () => {
  assert.match(client, /npb_identity_resolve/);
  assert.match(client, /次回予定/);
  assert.match(client, /最終実行/);
  assert.match(client, /次回retry/);
  assert.match(worker, /completed_at/);
  assert.match(worker, /claimed_at/);
});

test("V3の通常Cronはfeature flag有効時だけ実行し、旧Cronを自動起動しない", () => {
  const scheduled = worker.slice(worker.indexOf("async scheduled(event, env, ctx)"), worker.indexOf("export async function runScheduledGameAutomation"));
  assert.match(scheduled, /isGameAutomationV3Enabled\(env\)/);
  assert.match(scheduled, /runScheduledGameAutomationV3\(env, scheduledAt\)/);
  assert.doesNotMatch(scheduled, /runScheduledGameAutomation\(env, scheduledAt\)/);
});
