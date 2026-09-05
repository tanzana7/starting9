import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "frontend", "admin-v3");

function loadModules(...names) {
  const context = { window: {}, Intl, Date, Map, Set };
  vm.createContext(context);
  names.forEach((name) => vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context));
  return context.window.Starting9AdminV3;
}

function game(overrides = {}) {
  return {
    internalGameId: "game-1",
    gameDate: "2026-09-05",
    startAt: "2026-09-05T09:00:00Z",
    homeTeam: "fighters",
    awayTeam: "hawks",
    state: { state: "scheduled" },
    ...overrides
  };
}

test("対象試合を今日/明日/今後/過去に分類し、試合セレクト用ラベルを付ける", () => {
  const safety = loadModules("selection-safety").createAdminV3SelectionSafety();
  const now = new Date("2026-09-05T03:00:00Z");
  assert.equal(safety.gameDayStatus(game(), now).label, "今日");
  assert.equal(safety.gameDayStatus(game({ gameDate: "2026-09-06" }), now).label, "明日");
  assert.equal(safety.gameDayStatus(game({ gameDate: "2026-09-08" }), now).label, "今後");
  assert.equal(safety.gameDayStatus(game({ gameDate: "2026-09-04" }), now).label, "過去/別日");
  assert.match(safety.optionLabel(game({ gameDate: "2026-09-06" }), now), /^\[明日\]/);
});

test("今日の未完了Fighters戦を安全な初期対象として優先する", () => {
  const safety = loadModules("selection-safety").createAdminV3SelectionSafety();
  const now = new Date("2026-09-05T03:00:00Z");
  const preferred = safety.preferredOperationalGame([
    game({ internalGameId: "future", gameDate: "2026-09-08" }),
    game({ internalGameId: "today-completed", state: { state: "published" } }),
    game({ internalGameId: "today", startAt: "2026-09-05T10:00:00Z" }),
    game({ internalGameId: "today-earlier", startAt: "2026-09-05T08:00:00Z" })
  ], now);
  assert.equal(preferred.internalGameId, "today-earlier");
});

test("未来/別日選択には強い警告を出し、今日の選択は警告しない", () => {
  const safety = loadModules("selection-safety").createAdminV3SelectionSafety();
  const now = new Date("2026-09-05T03:00:00Z");
  assert.equal(safety.selectionWarning(game(), now), "");
  assert.match(safety.selectionWarning(game({ gameDate: "2026-09-08" }), now), /未来試合/);
  assert.match(safety.selectionWarning(game({ gameDate: "2026-09-04" }), now), /過去\/別日試合/);
  assert.match(safety.selectionWarning(game(), now, { corrected: true }), /保存済みの選択を補正/);
});

test("manual lineup対象カードに日付・カード・workflow状態・安全警告を表示する", () => {
  const modules = loadModules("selection-safety", "render-manual-lineup");
  const lineup = modules.createAdminV3ManualLineupRenderer({
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])),
    formatJst: () => "2026/09/08 18:00",
    getFinalizeSafety: () => ({ allowed: false, message: "本日以外の試合には正式スタメンを確定できません。" }),
    getGameDayStatus: () => ({ key: "future", label: "今後", tone: "future", isFuture: true, isPast: false })
  });
  const markup = lineup.render(game({ gameDate: "2026-09-08", effectiveState: "lineup_ready" }), {
    lineup: { playerCatalog: [] }
  }, { rows: lineup.createBlankRows() });
  assert.match(markup, /data-v3-manual-lineup-target/);
  assert.match(markup, /今後/);
  assert.match(markup, /workflow: persisted scheduled \/ effective lineup_ready/);
  assert.match(markup, /未来試合/);
  assert.match(markup, /data-v3-manual-lineup-finalize[^>]*disabled/);
});

test("roster画面はFighters-wideであり、試合選択UIを持たない", () => {
  const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  const roster = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  assert.match(page, /data-v3-game-selection-controls/);
  assert.match(admin, /v3State\.view === "roster"/);
  assert.match(roster, /Fighters-wide/);
  assert.match(roster, /試合日・対象試合の選択には依存しません/);
});

test("staleなlocalStorageも今日の運用対象へ補正できる経路を持つ", () => {
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  assert.match(admin, /window\.localStorage/);
  assert.match(admin, /selectionSource !== "hash"/);
  assert.match(admin, /本日の未完了Fighters戦/);
});
