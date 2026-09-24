import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const workerUrl = pathToFileURL(workerPath).href;
const worker = fs.readFileSync(workerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0014_automation_settings.sql"), "utf8");

test("自動承認設定は未作成時にONとして正規化される", async () => {
  const { normalizeAutoApproveEnabled, getAutomationSettings } = await import(workerUrl);
  assert.equal(normalizeAutoApproveEnabled(undefined), true);
  assert.equal(normalizeAutoApproveEnabled(null), true);
  assert.equal(normalizeAutoApproveEnabled("1"), true);
  assert.equal(normalizeAutoApproveEnabled("0"), false);

  const settings = await getAutomationSettings({
    prepare() {
      return { bind: () => ({ first: async () => null }) };
    }
  });
  assert.deepEqual(settings, { autoApproveEnabled: true, updatedAt: null, available: true });
});

test("自動承認は検証済み9人スタメンかつ設定ONの場合だけ許可する", async () => {
  const { shouldAutoApproveOfficialLineup } = await import(workerUrl);
  const valid = { ok: true, lineup: Array.from({ length: 9 }, () => ({})) };
  assert.equal(shouldAutoApproveOfficialLineup(true, valid), true);
  assert.equal(shouldAutoApproveOfficialLineup(false, valid), false);
  assert.equal(shouldAutoApproveOfficialLineup(true, { ok: false, lineup: valid.lineup }), false);
  assert.equal(shouldAutoApproveOfficialLineup(true, { ok: true, lineup: valid.lineup.slice(0, 8) }), false);
});

test("設定はD1に保存され、管理者限定のGET/PUT APIでのみ更新する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS automation_settings/);
  assert.match(migration, /auto_approve_enabled/);
  assert.match(worker, /\/api\/admin\/automation\/settings/);
  assert.match(worker, /async function handleAdminAutomationSettingsGet/);
  assert.match(worker, /async function handleAdminAutomationSettingsPut/);
  assert.match(worker, /await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /INSERT INTO automation_settings/);
});

test("Cronはブラウザに依存せず、最終スタメンだけ同じ承認コアを通す", () => {
  assert.match(worker, /ctx\.waitUntil\(runScheduledGameAutomationV3\(env, scheduledAt,[\s\S]*runId/);
  assert.match(worker, /captureOfficialLineup\(env, target\.gameId, now/);
  assert.match(worker, /scoringDueAt: new Date\(identity\.startAt\.getTime\(\) \+ 2 \* 60 \* 1000\)/);
  assert.match(worker, /applyLineupRevisionService\(\{/);
  assert.match(worker, /operation: "finalize"/);
  assert.match(worker, /source: "cron"/);
  assert.match(worker, /provisional_lineup_json/);
});

test("手動承認とCron自動承認は同じサーバー側の承認コアを使い、既存スタメンを再承認しない", () => {
  assert.match(worker, /async function applyLineupRevisionService/);
  assert.match(worker, /operation: "finalize"/);
  assert.match(worker, /source: "cron"/);
  assert.match(worker, /source: "admin"/);
  assert.match(worker, /expectedCurrentRevisionId/);
  assert.match(worker, /async function approveActualLineupForAutoScoring/);
  assert.match(worker, /const record = updateCanonical\s+\? await approveActualLineupForAutoScoring\(env, gameId, normalizedLineup, effectiveDetectedAt/);
  assert.match(worker, /if \(existing && options\.preventOverwrite\) \{\s+return existing;/s);
  assert.match(worker, /const existing = await getGameLineup\(env\.AUTH_DB, \{ gameId, internalGameId \}\);\s+const existingLineup = parseStoredActualLineup\(existing\?\.actual_lineup_json\);\s+const existingArtifact = assessV3LineupArtifact\(existingLineup\);\s+if \(existing && existingArtifact\.ok\)/s);
});

test("自動承認設定はWorker側に残し、通常公開bundleへ管理UIを含めない", () => {
  assert.doesNotMatch(html, /autoApproveCheckbox/);
  assert.doesNotMatch(script, /\/api\/admin\/automation\/settings|state\.autoApproval/);
  assert.match(worker, /async function handleAdminAutomationSettingsGet/);
});
