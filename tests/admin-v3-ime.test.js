import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "frontend", "admin-v3");

function loadModule(name, extra = {}) {
  const context = { window: {}, ...extra };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context);
  return context.window.Starting9AdminV3;
}

function manualSearchField(value = "") {
  return {
    value,
    dataset: { v3ManualLineupSearch: "0" },
    closest(selector) { return selector === "[data-v3-manual-lineup-search]" ? this : null; }
  };
}

test("manual lineup検索はIME変換中に再描画せずcompositionend後だけ検索を反映する", () => {
  const modules = loadModule("app-coordinator", { Set, Number });
  const listeners = new Map();
  const calls = [];
  const document = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    getElementById() { return null; }
  };
  const actions = new Proxy({
    updateManualLineupSearch(index, value) { calls.push({ index, value }); },
    restoreInitialRoute() {},
    load() {}
  }, { get(target, property) { return target[property] || (() => {}); } });
  const coordinator = modules.createAdminV3Coordinator({ document, window: { addEventListener() {} }, state: {}, actions });
  coordinator.start();
  const field = manualSearchField("");
  listeners.get("compositionstart")({ target: field });
  field.value = "西";
  listeners.get("input")({ target: field, isComposing: true });
  assert.equal(calls.length, 0);
  let prevented = false;
  listeners.get("keydown")({ target: field, key: "Enter", isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  listeners.get("compositionend")({ target: field });
  assert.deepEqual(calls, [{ index: 0, value: "西" }]);
});

test("manual lineup検索は通常のinputでは候補更新だけを依頼する", () => {
  const modules = loadModule("app-coordinator", { Set, Number });
  const listeners = new Map();
  const calls = [];
  const document = { addEventListener(type, handler) { listeners.set(type, handler); }, getElementById() { return null; } };
  const actions = new Proxy({
    updateManualLineupSearch(index, value) { calls.push({ index, value }); },
    restoreInitialRoute() {},
    load() {}
  }, { get(target, property) { return target[property] || (() => {}); } });
  modules.createAdminV3Coordinator({ document, window: { addEventListener() {} }, state: {} , actions }).start();
  const field = manualSearchField("tan");
  listeners.get("input")({ target: field, isComposing: false });
  assert.deepEqual(calls, [{ index: 0, value: "tan" }]);
});

test("manual lineup rendererは候補欄を独立更新できるDOM境界を持つ", () => {
  const modules = loadModule("render-manual-lineup");
  const renderer = modules.createAdminV3ManualLineupRenderer({ escapeHtml: (value) => String(value ?? "") });
  const markup = renderer.render(
    { state: { state: "scheduled" } },
    { lineup: { playerCatalog: [{ playerId: "p1", playerName: "Tanaka", uniformNumber: "1" }] } },
    { rows: renderer.createBlankRows() }
  );
  assert.match(markup, /data-v3-manual-lineup-candidates="0"/);
  assert.match(renderer.renderCandidates([{ playerId: "p1", playerName: "田中", uniformNumber: "1" }], { search: "田" }, 0), /田中/);
});

test("manual lineup入力中のスタメン確認は9枠・守備・背番号・左右ライン・重複を表示する", () => {
  const modules = loadModule("render-manual-lineup");
  const renderer = modules.createAdminV3ManualLineupRenderer({ escapeHtml: (value) => String(value ?? "") });
  const rows = renderer.createBlankRows();
  rows[0] = { ...rows[0], playerId: "p1", playerName: "水谷 瞬", uniformNumber: "53", position: "右" };
  rows[1] = { ...rows[1], playerId: "p1", playerName: "水谷 瞬", uniformNumber: "53", position: "左" };
  rows[2] = { ...rows[2], playerId: "p2", playerName: "水野 達稀", uniformNumber: "43", position: "遊" };
  const markup = renderer.render(
    { gameDate: "2026-09-04", homeTeam: "fighters", awayTeam: "hawks", startAt: "2026-09-04T09:00:00.000Z", internalGameId: "game-1" },
    { lineup: { playerCatalog: [
      { playerId: "p1", playerName: "水谷 瞬", uniformNumber: "53", bats: "R" },
      { playerId: "p2", playerName: "水野 達稀", uniformNumber: "43", bats: "L" }
    ] } },
    { rows }
  );
  assert.equal((markup.match(/data-v3-manual-lineup-confirmation-row/g) || []).length, 9);
  assert.match(markup, /data-v3-manual-lineup-confirmation/);
  assert.match(markup, /水谷 瞬/);
  assert.match(markup, /\[53\]/);
  assert.match(markup, /水野 達稀/);
  assert.match(markup, /player-name--bat-right/);
  assert.match(markup, /player-name--bat-left/);
  assert.match(markup, /守備未設定/);
  assert.match(markup, /manual-lineup-duplicate-warning/);
  assert.match(markup, /重複/);
});
