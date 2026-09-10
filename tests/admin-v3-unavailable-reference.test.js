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

test("admin-v3は旧manual controlsを通常UIへ公開しない", () => {
  const renderer = createRenderer();
  assert.equal(typeof renderer.renderManualControls, "undefined");
  assert.doesNotMatch(rendererSource, /data-v3-job-diagnose|data-v3-job-run|data-v3-state-reconcile/);
});

test("admin-v3の通常UIは状態再同期導線を持たない", () => {
  assert.doesNotMatch(rendererSource, /成果物を確認して状態を再同期|data-v3-state-reconcile/);
});

test("admin-v3の静的asset cache busterはReferenceError修正版を指す", () => {
  assert.match(pageSource, /v4-canonical-status-1/);
  assert.doesNotMatch(pageSource, /admin-v3-add-game-preview-1/);
});
