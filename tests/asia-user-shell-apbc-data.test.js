import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function createElement({ id = "", hidden = false, dataset = {} } = {}) {
  const classes = new Set();
  return {
    id,
    hidden,
    dataset,
    classList: {
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    setAttribute() {}
  };
}

function loadShell(href) {
  const npb = createElement({ id: "npbEditionContent" });
  const asia = createElement({ id: "asiaEditionContent" });
  const switcher = createElement({ dataset: { userEditionSwitcher: "" } });
  const buttons = [
    createElement({ dataset: { editionSelect: "NPB" } }),
    createElement({ dataset: { editionSelect: "ASIA_CS" } })
  ];
  const npbOnly = [createElement(), createElement()];
  const document = {
    readyState: "complete",
    documentElement: { dataset: {} },
    getElementById(id) { return { npbEditionContent: npb, asiaEditionContent: asia }[id] || null; },
    querySelector(selector) { return selector === "[data-user-edition-switcher]" ? switcher : null; },
    querySelectorAll(selector) {
      if (selector === "[data-edition-select]") return buttons;
      if (selector === "[data-npb-only]") return npbOnly;
      return [];
    },
    addEventListener() {}
  };
  const window = { location: { href }, document, history: { replaceState() {} } };
  const context = { window, document, URL, Date };
  vm.runInNewContext(read("frontend/shared/edition.js"), context);
  vm.runInNewContext(read("frontend/shared/edition-shell.js"), context);
  return { window, document, npb, asia, switcher, npbOnly };
}

test("Asia user shell hides every NPB-only node without throwing on frozen edition state", () => {
  const state = loadShell("https://starting9.test/?edition=asia");
  state.window.Starting9EditionShell.sync("ASIA_CS");
  assert.equal(state.npb.classList.contains("hidden"), true);
  assert.equal(state.asia.classList.contains("hidden"), false);
  assert.equal(state.switcher.hidden, true);
  assert.equal(state.npbOnly.every((node) => node.classList.contains("hidden")), true);
  assert.equal(state.window.Starting9Edition.active, "ASIA_CS");
  assert.equal(state.document.documentElement.dataset.starting9Edition, "ASIA_CS");
});

test("NPB user shell remains selectable outside the Asia exclusive window", () => {
  const state = loadShell("https://starting9.test/?edition=npb");
  state.window.Starting9EditionShell.sync("NPB");
  assert.equal(state.npb.classList.contains("hidden"), false);
  assert.equal(state.asia.classList.contains("hidden"), true);
  assert.equal(state.switcher.hidden, false);
  assert.equal(state.npbOnly.every((node) => node.classList.contains("hidden")), false);
  assert.equal(state.window.Starting9Edition.active, "NPB");
});

test("Asia game serialization groups roster UUIDs under the game team keys", async () => {
  const { serializeGame } = await import(pathToFileURL(path.join(ROOT, "asia-cs/worker.js")).href);
  const game = serializeGame({
    id: "g2",
    title: "GAME2",
    competition_type: "ASIA_CS",
    competition_id: "apbc-2026",
    game_date: "2026-11-12",
    start_at: "2026-11-12T10:00:00.000Z",
    prediction_deadline_at: "2026-11-12T09:00:00.000Z",
    home_team_id: "tpe",
    home_team_name: "チャイニーズ・タイペイ",
    away_team_id: "jpn",
    away_team_name: "日本",
    status: "open",
    publication_status: "pending",
    current_lineup_revision: null
  }, [
    { id: "p1", game_id: "g2", name: "宗山塁", team: "楽天", team_id: "team-row-jpn", position: "内野手", active: 1 }
  ], [
    { id: "team-row-jpn", team_key: "jpn", display_name: "日本", short_name: "日本" },
    { id: "team-row-tpe", team_key: "tpe", display_name: "チャイニーズ・タイペイ", short_name: "台湾" }
  ]);
  assert.equal(game.playersByTeam.home.length, 0);
  assert.equal(game.playersByTeam.away.length, 1);
  assert.equal(game.playersByTeam.away[0].registeredPosition, "内野手");
});

test("Asia UI has a finite loading failure state and a non-Japan empty roster state", () => {
  const app = read("asia-cs/public/app.js");
  assert.match(app, /選手情報は準備中です/);
  assert.match(app, /大会情報を読み込めませんでした/);
  assert.match(app, /次の試合は確認できません/);
});
