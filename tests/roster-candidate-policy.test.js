import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { getManualLineupPlayerCatalog } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lineupRendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");

function loadLineupRenderer() {
  const context = { window: {}, Map, Set, Number, Intl, Date };
  vm.createContext(context);
  vm.runInContext(lineupRendererSource, context);
  return context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({
    escapeHtml: (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
    }[character]))
  });
}

test("lineup catalog exposes explicit candidate visibility for special pitcher entries", () => {
  const catalog = getManualLineupPlayerCatalog();
  const byId = new Map(catalog.map((player) => [player.playerId, player]));
  assert.equal(byId.get("F-18")?.candidateVisibility, "hide");
  assert.equal(byId.get("F-31")?.candidateVisibility, "show");
  assert.equal(byId.get("F-12")?.candidateVisibility, "show");
  assert.equal(byId.get("F-53")?.candidateVisibility, "auto");
});

test("admin lineup candidates hide normal pitcher policy but keep Shibata and Yawaza", () => {
  const renderer = loadLineupRenderer();
  const html = renderer.renderCandidates(getManualLineupPlayerCatalog(), { search: "" }, 0);
  assert.doesNotMatch(html, /data-v3-manual-lineup-player-id="F-18"/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-31"/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-12"/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-53"/);
});

test("candidate policy is explicit and does not alter lineup payload markup", () => {
  const renderer = loadLineupRenderer();
  const html = renderer.renderCandidates([
    { playerId: "F-18", playerName: "通常投手", uniformNumber: "18", candidateVisibility: "hide" },
    { playerId: "F-31", playerName: "DH候補", uniformNumber: "31", candidateVisibility: "show" }
  ], { search: "" }, 0);
  assert.doesNotMatch(html, /通常投手/);
  assert.match(html, /DH候補/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-31"/);
  assert.doesNotMatch(html, /prediction|payload/i);
});
