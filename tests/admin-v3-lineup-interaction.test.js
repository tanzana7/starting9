import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createRenderer() {
  const context = vm.createContext({ window: {}, Map, Set, Intl, Date });
  vm.runInContext(rendererSource, context);
  return context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({
    escapeHtml,
    formatJst: (value) => String(value || "-"),
    getFinalizeSafety: () => ({ allowed: true, message: "" }),
    getGameDayStatus: () => ({ key: "today", label: "今日", tone: "today", isFuture: false, isPast: false })
  });
}

function makeGame(id, workflowState = "scheduled") {
  return {
    internalGameId: id,
    gameDate: "2026-09-08",
    startAt: "2026-09-08T18:00:00+09:00",
    homeTeam: "fighters",
    awayTeam: "hawks",
    workflowState
  };
}

function makeDetails(id, overrides = {}) {
  return {
    internalGameId: id,
    lineup: { playerCatalog: [] },
    lineupStatus: "pending",
    finalRevision: null,
    publication: { publication: { status: "draft", publishedAt: null } },
    ...overrides
  };
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
    if (match[1] === "input" || match[1] === "select") continue;
    attributes[match[1]] = match[2] ?? "";
  }
  return attributes;
}

function controlsFor(markup, attribute) {
  return [...markup.matchAll(/<(input|select)\b[^>]*>/g)]
    .map((match) => ({ tagName: match[1], attributes: parseAttributes(match[0]) }))
    .filter(({ attributes }) => Object.hasOwn(attributes, attribute))
    .map(({ tagName, attributes }) => new DomControl(tagName, attributes));
}

class DomControl {
  constructor(tagName, attributes) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.disabled = Object.hasOwn(attributes, "disabled");
    this.readOnly = Object.hasOwn(attributes, "readonly");
    this.value = attributes.value || "";
    this.document = { activeElement: null };
  }

  focus() {
    if (!this.disabled && !this.readOnly) this.document.activeElement = this;
  }

  type(value) {
    if (this.disabled || this.readOnly || this.document.activeElement !== this) throw new Error("control is not editable");
    this.value = value;
  }

  change(value) {
    if (this.disabled || this.readOnly) throw new Error("control is not editable");
    this.value = value;
  }
}

function assertEditableMarkup(markup) {
  assert.match(markup, /data-v3-manual-lineup-interaction="editable"/);
  assert.match(markup, /data-v3-manual-lineup-loading="false"/);
  assert.doesNotMatch(markup, /data-v3-manual-lineup-lock-reason/);
  const searches = controlsFor(markup, "data-v3-manual-lineup-search");
  const positions = controlsFor(markup, "data-v3-manual-lineup-position");
  assert.equal(searches.length, 9);
  assert.equal(positions.length, 9);
  for (const control of [...searches, ...positions]) {
    assert.equal(control.disabled, false);
    assert.equal(control.readOnly, false);
  }
  searches[0].focus();
  searches[0].type("柴田");
  positions[0].change("中");
  assert.equal(searches[0].value, "柴田");
  assert.equal(positions[0].value, "中");
}

function assertLockedMarkup(markup, expectedReason) {
  assert.match(markup, /data-v3-manual-lineup-interaction="locked"/);
  assert.match(markup, /data-v3-manual-lineup-loading="false"/);
  assert.match(markup, /data-v3-manual-lineup-lock-reason/);
  assert.match(markup, new RegExp(expectedReason));
  for (const control of [
    ...controlsFor(markup, "data-v3-manual-lineup-search"),
    ...controlsFor(markup, "data-v3-manual-lineup-position")
  ]) assert.equal(control.disabled, true);
}

test("manual lineupのeditable fixtureは検索・守備位置変更を許可する", () => {
  const renderer = createRenderer();
  const details = makeDetails("today-game", { lineup: null });
  const interaction = renderer.manualLineupInteractionState(makeGame("today-game"), details, { loading: false });
  assert.equal(interaction.locked, false);
  assert.equal(interaction.loading, false);
  assert.equal(interaction.reason, "");
  const markup = renderer.render(makeGame("today-game"), details, {
    rows: renderer.createBlankRows(),
    confirmed: false,
    latestRevision: null,
    loading: false
  });
  assertEditableMarkup(markup);
});

test("manual lineupはloading中に編集を止め、成功後にロック理由を消す", () => {
  const renderer = createRenderer();
  const game = makeGame("today-game");
  const loadingMarkup = renderer.render(game, {}, { rows: renderer.createBlankRows(), loading: false });
  assert.match(loadingMarkup, /data-v3-manual-lineup-loading="true"/);
  assert.match(loadingMarkup, /スタメン情報を読み込み中です/);
  for (const control of controlsFor(loadingMarkup, "data-v3-manual-lineup-search")) assert.equal(control.disabled, true);

  const successMarkup = renderer.render(game, makeDetails("today-game", { lineup: null }), { rows: renderer.createBlankRows(), loading: false });
  assertEditableMarkup(successMarkup);
});

test("manual lineupの保存中も編集を止め、保存完了後に再び編集可能にする", () => {
  const renderer = createRenderer();
  const game = makeGame("today-game");
  const details = makeDetails("today-game", { lineup: null });
  const savingMarkup = renderer.render(game, details, { rows: renderer.createBlankRows(), loading: true });
  assert.match(savingMarkup, /スタメン情報を保存中です/);
  for (const control of controlsFor(savingMarkup, "data-v3-manual-lineup-position")) assert.equal(control.disabled, true);
  assertEditableMarkup(renderer.render(game, details, { rows: renderer.createBlankRows(), loading: false }));
});

test("finalized・scoring・publishedのmanual lineupはロック理由を表示する", () => {
  const renderer = createRenderer();
  const game = makeGame("game-1");
  const fixtures = [
    [makeDetails("game-1", { finalRevision: { isFinal: true } }), "スタメン確定済み"],
    [makeDetails("game-1", { lineupStatus: "processing" }), "採点処理が開始済み"],
    [makeDetails("game-1", { lineupStatus: "scored" }), "採点済み"],
    [makeDetails("game-1", { publication: { publication: { status: "published", publishedAt: "2026-09-08T20:00:00Z" } } }), "公開済み"]
  ];
  for (const [details, reason] of fixtures) assertLockedMarkup(renderer.render(game, details, { rows: renderer.createBlankRows(), loading: false }), reason);
});

test("manual lineupはlineup以外の必須詳細取得失敗も編集停止として表示する", () => {
  const renderer = createRenderer();
  const details = makeDetails("game-1", { publication: { ok: false, errorCode: "PUBLICATION_FAILED" } });
  const markup = renderer.render(makeGame("game-1"), details, { rows: renderer.createBlankRows(), loading: false });
  assertLockedMarkup(markup, "試合詳細の取得に失敗");
});

test("manual lineupは試合切替時にロック状態と詳細試合IDを混ぜない", () => {
  const renderer = createRenderer();
  const rows = renderer.createBlankRows();
  const lockedGame = renderer.render(makeGame("game-a"), makeDetails("game-a", { lineupStatus: "scored" }), { rows, loading: false });
  const editableGame = renderer.render(makeGame("game-b"), makeDetails("game-b", { lineup: null }), { rows, loading: false });
  const lockedAgain = renderer.render(makeGame("game-a"), makeDetails("game-a", { finalRevision: { isFinal: true } }), { rows, loading: false });
  assertLockedMarkup(lockedGame, "採点済み");
  assertEditableMarkup(editableGame);
  assertLockedMarkup(lockedAgain, "スタメン確定済み");
  assertLockedMarkup(renderer.render(makeGame("game-b"), makeDetails("game-a", { lineup: null }), { rows, loading: false }), "詳細が一致しない");
});

test("manual lineupのロックはCSSやcoordinatorの親イベントで追加されていない", () => {
  assert.doesNotMatch(cssSource, /pointer-events\s*:\s*none/i);
  assert.doesNotMatch(cssSource, /fieldset|\binert\b/i);
  assert.doesNotMatch(coordinatorSource, /addEventListener\((?:"|')?(?:mousedown|pointerdown|touchstart)/);
  assert.match(coordinatorSource, /isManualSearchComposing\(event, field\).*event\.preventDefault\(\)/);
});
