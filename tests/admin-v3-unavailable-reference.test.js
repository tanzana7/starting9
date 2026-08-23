import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function createRenderer() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(rendererSource, context);
  return context.window.Starting9AdminV3.createAdminV3GameProgressRenderer({
    escapeHtml: (value) => String(value ?? ""),
    manualOperation: () => ({})
  });
}

test("admin-v3のmanual controlsは通常試合と対象外試合の両方で描画時例外を投げない", () => {
  const renderer = createRenderer();
  const baseGame = { internalGameId: "game-1", state: { state: "scheduled" }, gameStatus: "scheduled" };

  assert.doesNotThrow(() => renderer.renderManualControls(baseGame));
  assert.doesNotThrow(() => renderer.renderManualControls({ ...baseGame, gameStatus: "service_unavailable" }));
  assert.match(renderer.renderManualControls({ ...baseGame, gameStatus: "service_unavailable" }), /中止・対象外 \/ 停止/);
});

test("admin-v3の対象外判定は行ループ外の再同期ボタンでも同じ値を使う", () => {
  assert.match(rendererSource, /const gameUnavailable = \["cancelled", "canceled", "postponed", "service_unavailable"\]/);
  assert.match(rendererSource, /reconcileLoading \|\| gameUnavailable/);
  assert.doesNotMatch(rendererSource, /reconcileLoading \|\| unavailable/);
});

test("admin-v3の静的asset cache busterはReferenceError修正版を指す", () => {
  assert.match(pageSource, /admin-v3-ranking-status-labels-1/);
  assert.doesNotMatch(pageSource, /admin-v3-add-game-preview-1/);
});
