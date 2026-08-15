const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const authWorker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const publicRoster = fs.readFileSync(path.join(root, "frontend", "public", "roster.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
const players = fs.readFileSync(path.join(root, "players.js"), "utf8");

function getFunctionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < script.length; index += 1) {
    if (script[index] === "{") {
      depth += 1;
      bodyStarted = true;
    } else if (script[index] === "}") {
      depth -= 1;
      if (bodyStarted && depth === 0) {
        return script.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${name} の終端を見つけられません`);
}

function createRosterHelpers() {
  const context = vm.createContext({
    ROSTER_SNAPSHOT_CACHE_TTL_MS: 60 * 60 * 1000,
    normalizePlayerKey: (value) => String(value || "")
      .normalize("NFKC")
      .replace(/[\s\u3000]/g, "")
      .trim()
  });
  const names = [
    "createRosterEntryKey",
    "normalizeRosterEntries",
    "createRosterPlayerMap",
    "diffRosterPlayers",
    "rosterEntryMatchesPlayer",
    "isRosterSnapshotFresh"
  ];
  vm.runInContext(`${names.map(getFunctionSource).join("\n")}; this.helpers = { ${names.join(", ")} };`, context);
  return context.helpers;
}

test("公式の現在ロースタースナップショット差分で登録と抹消を検出する", () => {
  const { diffRosterPlayers } = createRosterHelpers();
  const diff = diffRosterPlayers(
    [{ number: "53", name: "水谷 瞬" }],
    [{ number: "12", name: "矢澤 宏太" }]
  );

  assert.deepEqual([...diff.added], ["矢澤宏太"]);
  assert.deepEqual([...diff.removed], ["水谷瞬"]);
});

test("背番号を優先して照合し、投手登録の矢澤宏太も野手候補として認識する", () => {
  const { rosterEntryMatchesPlayer } = createRosterHelpers();
  const yazawa = {
    name: "矢澤宏太",
    aliases: ["矢澤", "矢沢"],
    uniformNumber: "12",
    registeredPosition: "投手",
    isBatterCandidate: true
  };

  assert.equal(rosterEntryMatchesPlayer({ number: "12", name: "矢澤 宏太" }, yazawa), true);
  assert.equal(rosterEntryMatchesPlayer({ number: "012", name: "矢澤 宏太" }, yazawa), false);
  assert.match(players, /name:\s*"矢澤宏太"[\s\S]*?isBatterCandidate:\s*true/);
});

test("背番号文字列の先頭ゼロを保持し、同名でも背番号が違えば統合しない", () => {
  const { normalizeRosterEntries, createRosterEntryKey } = createRosterHelpers();
  const entries = normalizeRosterEntries([
    { number: "01", name: "同姓 選手" },
    { number: "001", name: "同姓 選手" }
  ]);

  assert.equal(entries.length, 2);
  assert.equal(createRosterEntryKey(entries[0]), "number:01");
  assert.equal(createRosterEntryKey(entries[1]), "number:001");
});

test("空白表記を正規化し、前回成功スナップショットを一定時間だけ新鮮として扱う", () => {
  const { normalizeRosterEntries, isRosterSnapshotFresh } = createRosterHelpers();
  const entries = normalizeRosterEntries([{ number: "61", name: "水谷　 瞬" }]);
  assert.equal(entries[0].name, "水谷瞬");

  const now = Date.parse("2026-07-21T09:00:00.000Z");
  assert.equal(isRosterSnapshotFresh({ fetchedAt: "2026-07-21T08:30:01.000Z" }, now), true);
  assert.equal(isRosterSnapshotFresh({ fetchedAt: "2026-07-21T07:59:59.000Z" }, now), false);
});

test("現在状態テキストを出さず、最新スナップショットで選手一覧タブを絞り込む", () => {
  const chip = getFunctionSource("createPlayerChip");
  assert.match(publicRoster, /deps\.isPlayerInCurrentRoster\(player\)/);
  assert.match(publicRoster, /player\?\.isBatterCandidate === true/);
  assert.match(publicRoster, /candidateRosterFilter/);
  assert.match(publicRoster, /data-roster-filter/);
  assert.match(html, /data-roster-filter="active"[^>]*>登録済み/);
  assert.match(html, /data-roster-filter="inactive"[^>]*>未登録/);
  assert.doesNotMatch(html, /predictionRosterFilterCurrent|現在：出場登録/);
  assert.doesNotMatch(chip, /roster-status-badge|出場登録外/);
  assert.doesNotMatch(script, /predictionRosterFilterCurrent|roster-status-badge/);
});

test("Workerは現在の出場選手一覧を直接取得し、ゼロ件を成功扱いにしない", () => {
  assert.match(worker, /https:\/\/npb\.jp\/announcement\/roster\//);
  assert.match(worker, /mode === "roster"/);
  assert.match(worker, /if \(!extraction\.players\.length\)/);
  assert.match(worker, /ROSTER_CACHE_TTL_SECONDS = 30 \* 60/);
  assert.match(worker, /cacheStatus: "stale-fallback"/);
});

test("正式roster refreshは取得Workerの30分Cacheを強制回避し、source取得情報を監査へ渡す", () => {
  assert.match(worker, /forceRefresh = \["1", "true", "yes"\]/);
  assert.match(worker, /if \(!forceRefresh\)/);
  assert.match(worker, /"Cache-Control": "no-cache, no-store, max-age=0"/);
  assert.match(worker, /cacheStatus: forceRefresh \? "bypass" : "miss"/);
  assert.match(authWorker, /mode: "roster",[\s\S]*force: force \|\| isV3 \? "1" : undefined/);
  assert.match(authWorker, /rosterSourceCacheStatus/);
  assert.match(authWorker, /rosterSourceFetchedAt/);
});
