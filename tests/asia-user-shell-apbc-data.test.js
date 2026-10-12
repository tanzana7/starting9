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
  assert.equal(state.switcher.classList.contains("hidden"), true);
  assert.equal(state.npbOnly.every((node) => node.classList.contains("hidden")), true);
  assert.equal(state.window.Starting9Edition.active, "ASIA_CS");
  assert.equal(state.document.documentElement.dataset.starting9Edition, "ASIA_CS");
});

test("Asia selection is protected from author display rules and NPB probable rendering", () => {
  const css = read("style.css");
  const shell = read("frontend/shared/edition-shell.js");
  const script = read("script.js");
  assert.match(css, /\.edition-switcher\[hidden\][\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /html\[data-starting9-edition="ASIA_CS"\]\s+\[data-npb-only\][\s\S]*?display:\s*none\s*!important/);
  assert.match(shell, /nodes\.switcher\.classList\.toggle\("hidden", hideSwitcher\)/);
  assert.match(script, /async function initializeProbableStarter\(\)\s*\{\s*if \(!isNpbUserEditionActive\(\)\) return;/);
  assert.match(script, /async function fetchStoredProbableStarter\(\)\s*\{\s*if \(!isNpbUserEditionActive\(\)\) return;/);
  assert.match(script, /if \(!isNpbUserEditionActive\(\)\)\s*\{\s*container\.hidden = true;[\s\S]*?container\.replaceChildren\(\)/);
});

test("Asia-selected public coordinator refuses initialization from any caller", async () => {
  let initialized = false;
  const edition = {
    ASIA_CS: "ASIA_CS",
    active: "ASIA_CS",
    resolveSelectedEdition() { return "ASIA_CS"; }
  };
  const context = {
    window: { Starting9Edition: edition, location: { href: "https://starting9.test/?edition=asia" } },
    document: { documentElement: { dataset: { starting9Edition: "ASIA_CS" } } },
    Date,
    setTimeout
  };
  vm.runInNewContext(read("frontend/public/app-coordinator.js"), context);
  const coordinator = new context.window.Starting9Public.PublicAppCoordinator({
    appState: {},
    state: {},
    operations: { buildLineupPicker() { initialized = true; } }
  });
  assert.equal(await coordinator.start(), null);
  assert.equal(initialized, false);
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
  const html = read("index.html");
  assert.match(html, /asia-cs\/app\.js\?v=apbc-japan-games-only-1/);
  assert.match(html, /asia-user-shell-lock-1/);
  assert.match(html, /script\.js\?v=[^\"]*asia-user-shell-lock-1/);
});

test("embedded APBC client resolves camel-cased IDs and renders anonymous public data", async () => {
  const html = read("index.html");
  const app = read("asia-cs/public/app.js");
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(id, {
      id,
      dataset: {},
      textContent: "",
      innerHTML: "",
      disabled: false,
      children: [],
      listeners: {},
      classList: {
        values: new Set(),
        add(value) { this.values.add(value); },
        remove(value) { this.values.delete(value); },
        toggle(value, force) { if (force) this.values.add(value); else this.values.delete(value); }
      },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute() {},
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return []; }
    });
  }
  const document = {
    scripts: [{ dataset: { asiaPrefix: "asiaEdition", competitionId: "apbc-2026" } }],
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return { dataset: {}, children: [], setAttribute() {}, append(...children) { this.children.push(...children); }, className: "", textContent: "", innerHTML: "", value: "" }; }
  };
  const games = Array.from({ length: 6 }, (_, index) => ({
    id: `apbc-2026-g${index + 1}`,
    title: `GAME${index + 1}`,
    gameDate: "2026-11-12",
    startAt: "2026-11-12T03:00:00.000Z",
    predictionDeadlineAt: "2026-11-12T02:00:00.000Z",
    homeTeam: { id: "kor", name: "韓国" },
    awayTeam: { id: "aus", name: "オーストラリア" },
    status: "open",
    canPredict: true
  }));
  games[1].homeTeam = { id: "tpe", name: "チャイニーズ・タイペイ" };
  games[1].awayTeam = { id: "jpn", name: "日本" };
  games[3].homeTeam = { id: "jpn", name: "日本" };
  games[3].awayTeam = { id: "kor", name: "韓国" };
  games[4].homeTeam = { id: "aus", name: "オーストラリア" };
  games[4].awayTeam = { id: "jpn", name: "日本" };
  const requests = [];
  const japanRoster = Array.from({ length: 15 }, (_, index) => ({
    id: `apbc-player-${index + 1}`,
    name: `選手${index + 1}`,
    club: "球団",
    registeredPosition: "内野手",
    active: true
  }));
  const fetch = async (url) => {
    requests.push(String(url));
    let payload;
    if (String(url).includes("/auth/me")) payload = { ok: true, authenticated: false, isAdmin: false, user: null };
    else if (String(url).includes("/competition?")) payload = { ok: true, competition: { id: "apbc-2026", displayName: "APBC 2026", startDate: "2026-11-12", endDate: "2026-11-15", status: "draft" }, games, nextGame: games[0], acceptingGames: [] };
    else if (String(url).includes("/rankings?")) payload = { ok: true, ranking: [] };
    else if (String(url).includes("/best-nine?")) payload = { ok: true, publishedGameCount: 0, bestNine: [] };
    else if (String(url).includes("/games/apbc-2026-g1")) payload = { ok: true, game: games[0] };
    else if (["g2", "g4", "g5"].some((suffix) => String(url).includes(`/games/apbc-2026-${suffix}`))) {
      const id = String(url).match(/apbc-2026-(g[245])/)?.[1];
      const matchup = { g2: [{ id: "tpe", name: "チャイニーズ・タイペイ" }, { id: "jpn", name: "日本" }], g4: [{ id: "jpn", name: "日本" }, { id: "kor", name: "韓国" }], g5: [{ id: "aus", name: "オーストラリア" }, { id: "jpn", name: "日本" }] }[id];
      payload = { ok: true, game: { ...games[Number(id.slice(1)) - 1], homeTeam: matchup[0], awayTeam: matchup[1], playersByTeam: { home: matchup[0].id === "jpn" ? japanRoster : [], away: matchup[1].id === "jpn" ? japanRoster : [] } } };
    }
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => payload };
  };
  const context = {
    document,
    window: { scrollTo() {} },
    location: { search: "" },
    URLSearchParams,
    Date,
    fetch,
    console
  };

  assert.doesNotThrow(() => vm.runInNewContext(app, context));
  await context.window.Starting9AsiaCsApp.load();

  assert.ok(requests.includes("/api/asia-cs/competition?competitionId=apbc-2026"));
  assert.ok(requests.includes("/api/asia-cs/games/apbc-2026-g1"));
  assert.equal(elements.get("asiaEditionNextGame").innerHTML.includes("韓国 vs オーストラリア"), true);
  assert.equal(elements.get("asiaEditionScheduleStatus").textContent, "6試合");
  assert.equal((elements.get("asiaEditionScheduleList").innerHTML.match(/class=\"schedule-row\"/g) || []).length, 6);
  assert.match(elements.get("asiaEditionRankingList").innerHTML, /大会開始後に表示されます/);
  assert.match(elements.get("asiaEditionBestNineList").innerHTML, /大会終了後に公開予定です/);
  assert.equal(elements.get("asiaEditionAuthStatus").textContent, "Starting9でログインしてください");

  const scheduleClick = elements.get("asiaEditionScheduleList").listeners.click;
  for (const gameId of ["apbc-2026-g2", "apbc-2026-g4", "apbc-2026-g5"]) {
    scheduleClick({ target: { closest(selector) { return selector === "[data-game]" ? { dataset: { game: gameId } } : null; } } });
    for (let attempt = 0; attempt < 12 && elements.get("asiaEditionPredictionLineup").children.length !== 9; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(elements.get("asiaEditionPredictionTeamId").value, "jpn");
    assert.equal(elements.get("asiaEditionPredictionLineup").children.length, 9);
    assert.match(elements.get("asiaEditionPredictionLineup").children[0].children[1].innerHTML, /選手1.*球団.*登録: 内野手/);
    assert.equal(elements.get("asiaEditionPredictionLineup").children[0].children[1].value, "");
    elements.get("asiaEditionPredictionLineup").children = [];
  }
});
