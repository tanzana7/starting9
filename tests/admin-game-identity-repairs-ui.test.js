const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面に試合ID修復のdry-run一覧と更新操作を追加する", () => {
  const html = read("index.html");
  const script = read("script.js");

  assert.match(html, /id="adminGameIdentityRepairsPanel"/);
  assert.match(html, /id="refreshAdminGameIdentityRepairsButton"/);
  assert.match(html, />修復候補を確認<\/button>/);
  assert.match(html, /id="adminGameIdentityRepairsList"/);
  assert.match(script, /function buildAdminGameIdentityRepairPreviewApiUrl\(\)/);
  assert.match(script, /\/api\/admin\/audit\/game-identity-repairs/);
  assert.match(script, /void refreshAdminGameIdentityRepairs\(\{ force: true \}\);/);
  assert.match(script, /credentials: "include", cache: "no-store"/);
});

test("SAFE計画だけを1件ずつ最新planHashで実行する", () => {
  const script = read("script.js");

  assert.match(script, /plan\?\.classification === "SAFE_CREATE_INTERNAL_GAME" \|\| plan\?\.classification === "SAFE_AUTO_LINK"/);
  assert.match(script, /repairIds: \[repairId\], expectedPlanHashes: \{ \[repairId\]: plan\.planHash \}/);
  assert.match(script, /getGameIdentityRepairAction\(repairId\)\.isBusy/);
  assert.match(script, /data-game-identity-repair-action="execute"/);
  assert.match(script, /\$\{safe \? `<div class="game-identity-repair-actions">/);
  assert.match(script, /この分類は自動実行できません。理由を確認して手動で対応してください。/);
  assert.match(script, /MANUAL_REVIEW/);
});

test("修復パネルは管理者画面で維持され、dry-run失敗時もAPI詳細を表示できる", () => {
  const script = read("script.js");

  assert.match(script, /const available = state\.appMode === "admin" && state\.adminAccess\.status === "authorized"/);
  assert.match(script, /panel\.classList\.toggle\("hidden", !available\)/);
  assert.match(script, /state\.isAdminMode = isAdminScreenOpen;\s+renderAdminGameIdentityRepairs\(\);/);
  assert.match(script, /function createAdminGameIdentityRepairApiError\(response, payload, fallbackMessage\)/);
  assert.match(script, /expectedPlanHash = payload\?\.expectedPlanHash/);
  assert.match(script, /currentPlanHash = payload\?\.currentPlanHash/);
  assert.match(script, /storedPlanHash = payload\?\.storedPlanHash/);
  assert.match(script, /mismatchReason = payload\?\.mismatchReason/);
  assert.match(script, /repairs\.errorDetails = getGameIdentityRepairErrorDetails\(error\)/);
});

test("部分書き込みと失敗中の別計画を止め、成功状態を厳密に確認する", () => {
  const script = read("script.js");

  assert.match(script, /function canExecuteGameIdentityRepairPlan\(plan\)/);
  assert.match(script, /action\.partialWriteDetected === true/);
  assert.match(script, /repairs\.activeRepairId/);
  assert.match(script, /function repairsBlockedByOtherFailure\(plan\)/);
  assert.match(script, /if \(!result \|\| result\.status !== "completed"\)/);
  assert.match(script, /state\.gameIdentityRepairs\.activeRepairId = repairId/);
  assert.match(script, /state\.gameIdentityRepairs\.activeRepairId = ""/);
});

test("実行後は個別監査と全体dry-runを再取得し、計画を安定順で表示する", () => {
  const script = read("script.js");

  assert.match(script, /function formatGameIdentityRepairPreviewSummary\(preview\)/);
  assert.match(script, /projected coverage/);
  assert.match(script, /classificationIntegrity\?\.valid === false/);
  assert.match(script, /function sortGameIdentityRepairPlans\(plans\)/);
  assert.match(script, /getGameIdentityRepairTableCount\(left\) - getGameIdentityRepairTableCount\(right\)/);
  assert.match(script, /await loadAdminGameIdentityRepairAudit\(repairId\)/);
  assert.match(script, /await refreshAdminGameIdentityRepairs\(\{ force: true \}\)/);
  assert.match(script, /identifier: \$\{identifierStates/);
  assert.match(script, /rollback: \$\{rollbackAllowed/);
});

test("修復結果はエラーコードと部分書き込み状態を表示し、完了済みだけロールバック可能にする", () => {
  const script = read("script.js");

  assert.match(script, /buildAdminGameIdentityRepairAuditApiUrl/);
  assert.match(script, /await refreshAdminGameIdentityRepairAudits\(payload\.repairPlans, requestId\)/);
  assert.match(script, /partialWriteDetected: Boolean\(audit\.observed\?\.partialWriteDetected\)/);
  assert.match(script, /rollbackAllowed = action\.auditStatus === "completed" && action\.rollbackAvailable === true/);
  assert.match(script, /data-game-identity-repair-action="rollback"/);
  assert.match(script, /action\.auditStatus !== "completed" \|\| action\.rollbackAvailable !== true/);
  assert.match(script, /\/api\/admin\/game-identities\/repairs\/\$\{encodeURIComponent\(repairId\)\}\/rollback/);
});

test("修復パネルの管理画面スタイルはモバイルでも更新対象と操作を収める", () => {
  const css = read("style.css");

  assert.match(css, /\.admin-game-identity-repairs/);
  assert.match(css, /\.game-identity-repair-details > div/);
  assert.match(css, /\.game-identity-repair-actions \{\s+display: grid;/);
  assert.match(css, /overflow-wrap: anywhere/);
});
