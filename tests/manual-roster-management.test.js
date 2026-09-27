import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import worker from "../auth-worker.js";
import {
  getManualLineupPlayerCatalog,
  normalizeManualLineupInput
} from "../auth-worker.js";
import {
  MANUAL_ROSTER_TEAM,
  getManualRoster,
  prioritizeManualRosterCatalog,
  saveManualRoster,
  applyManualRosterToPublicRoster,
  applyLiveRosterToManualLineupCatalog,
  validateManualRosterEntries
} from "../backend/automation-v3/manual-roster-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const token = "manual-roster-test-session";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        },
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } })
      };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); }
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function makeEnv({ withRosterTable = true } = {}) {
  const database = new DatabaseSync(":memory:");
  const tokenHash = await sha256(token);
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, status TEXT, role TEXT, password_hash TEXT, password_salt TEXT, password_iterations INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, created_at TEXT, expires_at TEXT, last_used_at TEXT);
    ${withRosterTable ? `CREATE TABLE manual_team_rosters (
      team_code TEXT NOT NULL, team_id TEXT NOT NULL, player_id TEXT NOT NULL, status TEXT NOT NULL,
      mode TEXT CHECK (mode IN ('auto', 'active', 'inactive')),
      roster_source TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      PRIMARY KEY (team_code, player_id), UNIQUE (team_id, player_id)
    );` : ""}
    INSERT INTO users (id, username, status, role) VALUES ('admin-1', 'operator', 'active', 'admin');
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
      VALUES ('session-1', 'admin-1', '${tokenHash}', '2026-09-02T00:00:00Z', '2099-01-01T00:00:00Z', '2026-09-02T00:00:00Z');
  `);
  return { database, env: { AUTH_DB: d1(database), AUTH_ALLOWED_ORIGINS: "https://starting9.test" } };
}

function request(pathname, method = "GET", body) {
  return new Request(`https://starting9.test${pathname}`, {
    method,
    headers: { Origin: "https://starting9.test", Cookie: `s9_session=${encodeURIComponent(token)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("manual rosterは既知カタログだけを受け付け、未知・重複・別チームを拒否する", () => {
  const catalog = getManualLineupPlayerCatalog();
  assert.deepEqual(MANUAL_ROSTER_TEAM.teamCode, "fighters");
  assert.doesNotThrow(() => validateManualRosterEntries([{ playerId: catalog[0].playerId, status: "active" }], catalog));
  assert.throws(() => validateManualRosterEntries([{ playerId: "unknown" }], catalog), /選手カタログ/);
  assert.throws(() => validateManualRosterEntries([{ playerId: catalog[0].playerId }, { playerId: catalog[0].playerId }], catalog), /重複/);
});

test("manual rosterはcatalog優先順位を変えるがmanual lineupの9人制約を変えない", () => {
  const catalog = getManualLineupPlayerCatalog();
  const prioritized = prioritizeManualRosterCatalog(catalog, [{ playerId: catalog[4].playerId, status: "active" }, { playerId: catalog[1].playerId, status: "inactive" }]);
  assert.equal(prioritized[0].playerId, catalog[4].playerId);
  assert.equal(prioritized[0].manualRosterActive, true);
  assert.equal(prioritized.find((player) => player.playerId === catalog[1].playerId).manualRosterActive, false);
  assert.equal(normalizeManualLineupInput(catalog.slice(0, 8).map((player, index) => ({ playerName: player.playerName, battingOrder: index + 1, position: "捕" }))).ok, false);
});

test("manual rosterはACTIVE→INACTIVE→ACTIVEの保存往復で状態を維持する", async () => {
  const { env } = await makeEnv();
  const catalog = getManualLineupPlayerCatalog();
  const playerId = catalog[0].playerId;
  await saveManualRoster(env.AUTH_DB, { teamCode: "fighters", entries: [{ playerId, status: "active" }], updatedBy: "admin:roundtrip", catalog });
  await saveManualRoster(env.AUTH_DB, { teamCode: "fighters", entries: [{ playerId, status: "inactive" }], updatedBy: "admin:roundtrip", catalog });
  assert.equal((await getManualRoster(env.AUTH_DB)).entries.find((entry) => entry.playerId === playerId)?.status, "inactive");
  await saveManualRoster(env.AUTH_DB, { teamCode: "fighters", entries: [{ playerId, status: "active" }], updatedBy: "admin:roundtrip", catalog });
  const reread = await getManualRoster(env.AUTH_DB);
  assert.equal(reread.entries.find((entry) => entry.playerId === playerId)?.status, "active");
  assert.equal(reread.source, "manual");
});

test("manual rosterのAUTOは対象行をmode=autoで保持し、他選手のoverrideを保持する", async () => {
  const { env } = await makeEnv();
  const catalog = getManualLineupPlayerCatalog();
  const activeId = catalog[0].playerId;
  const inactiveId = catalog[1].playerId;
  await saveManualRoster(env.AUTH_DB, {
    teamCode: "fighters",
    entries: [{ playerId: activeId, status: "active" }, { playerId: inactiveId, status: "inactive" }],
    updatedBy: "admin:auto-release",
    catalog
  });
  await saveManualRoster(env.AUTH_DB, {
    teamCode: "fighters",
    entries: [{ playerId: activeId, status: "auto" }, { playerId: inactiveId, status: "inactive" }],
    updatedBy: "admin:auto-release",
    catalog
  });
  const reread = await getManualRoster(env.AUTH_DB);
  assert.equal(reread.entries.find((entry) => entry.playerId === activeId)?.mode, "auto");
  assert.equal(reread.entries.find((entry) => entry.playerId === activeId)?.status, "auto");
  assert.equal(reread.entries.find((entry) => entry.playerId === inactiveId)?.status, "inactive");
});

test("0043 migrationはlegacy active/inactiveを同じmodeへbackfillし、AUTOへ変換しない", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE manual_team_rosters (
    team_code TEXT NOT NULL, team_id TEXT NOT NULL, player_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    roster_source TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
    PRIMARY KEY (team_code, player_id), UNIQUE (team_id, player_id)
  );
  INSERT INTO manual_team_rosters VALUES
    ('fighters', 'F', 'F-1', 'active', 'manual', NULL, '2026-09-01', 'admin:test'),
    ('fighters', 'F', 'F-2', 'inactive', 'manual', NULL, '2026-09-01', 'admin:test');`);
  const migration = fs.readFileSync(path.join(root, "migrations", "0043_manual_team_roster_modes.sql"), "utf8");
  assert.doesNotMatch(migration, /mode\s+TEXT[^\n]*DEFAULT\s+'auto'/i);
  database.exec(migration);
  assert.deepEqual(database.prepare("SELECT player_id, mode FROM manual_team_rosters ORDER BY player_id").all().map((row) => ({ player_id: row.player_id, mode: row.mode })), [
    { player_id: "F-1", mode: "active" },
    { player_id: "F-2", mode: "inactive" }
  ]);
});

test("AUTOはunsetと区別され、公式rosterの昇格・降格だけeffective状態を変える", () => {
  const catalog = [{ playerId: "F-1", playerName: "有薗直輝", uniformNumber: "39", category: "内野手" }];
  const explicitAuto = { source: "manual", isManualSaved: true, entries: [{ playerId: "F-1", mode: "auto", status: "auto" }] };
  const unset = prioritizeManualRosterCatalog(catalog, { source: "manual", isManualSaved: true, entries: [] });
  const autoCatalog = prioritizeManualRosterCatalog(catalog, explicitAuto);
  assert.equal(unset[0].manualRosterMode, null);
  assert.equal(autoCatalog[0].manualRosterMode, "auto");
  assert.notEqual(unset[0].manualRosterSource, autoCatalog[0].manualRosterSource);

  const outside = applyLiveRosterToManualLineupCatalog(catalog, { players: [] }, explicitAuto);
  assert.equal(outside, null, "空live rosterは既存契約どおり置換しない");
  const demoted = applyLiveRosterToManualLineupCatalog(catalog, { players: [{ name: "別選手", number: "1", position: "外野手" }] }, explicitAuto);
  assert.equal(demoted[0].manualRosterMode, "auto");
  assert.equal(demoted[0].manualRosterEffectiveActive, false);
  const promoted = applyLiveRosterToManualLineupCatalog(catalog, { players: [{ name: "有薗 直輝", number: "39", position: "内野手" }] }, explicitAuto);
  assert.equal(promoted[0].manualRosterMode, "auto");
  assert.equal(promoted[0].manualRosterEffectiveActive, true);
});

test("ACTIVE/INACTIVEはofficial roster更新後もstickyで、AUTOへの変更だけが解除する", () => {
  const catalog = [{ playerId: "F-1", playerName: "選手", uniformNumber: "1", category: "外野手" }];
  const live = { players: [{ name: "選手", number: "1", position: "外野手" }] };
  const active = applyLiveRosterToManualLineupCatalog(catalog, live, { entries: [{ playerId: "F-1", mode: "active" }] });
  const inactive = applyLiveRosterToManualLineupCatalog(catalog, live, { entries: [{ playerId: "F-1", mode: "inactive" }] });
  assert.equal(active[0].manualRosterMode, "active");
  assert.equal(active[0].manualRosterEffectiveActive, true);
  assert.equal(inactive[0].manualRosterMode, "inactive");
  assert.equal(inactive[0].manualRosterEffectiveActive, false);
});

test("manual roster modeの全遷移とAUTO再保存はrowを削除しない", async () => {
  const { env } = await makeEnv();
  const catalog = getManualLineupPlayerCatalog();
  const playerId = catalog.find((player) => player.playerName === "有薗直輝")?.playerId || catalog[0].playerId;
  for (const mode of ["inactive", "auto", "active", "auto", "inactive", "auto", "active"]) {
    await saveManualRoster(env.AUTH_DB, { teamCode: "fighters", entries: [{ playerId, mode }], updatedBy: "admin:transition", catalog });
    assert.equal((await getManualRoster(env.AUTH_DB)).entries.find((entry) => entry.playerId === playerId)?.mode, mode);
  }
});

test("manual rosterのactive/inactive投影はpublicとadminの候補状態を一致させる", () => {
  const catalog = [
    { playerId: "F-1", playerName: "現行選手", uniformNumber: "1", category: "外野手" },
    { playerId: "F-2", playerName: "復帰選手", uniformNumber: "2", category: "内野手" }
  ];
  const manualRoster = {
    source: "manual",
    isManualSaved: true,
    entries: [{ playerId: "F-1", status: "inactive" }, { playerId: "F-2", status: "active" }]
  };
  const publicRoster = applyManualRosterToPublicRoster({
    sourceOfTruth: "official_live",
    players: [{ playerId: "npb:20260001", name: "現行選手", number: "1", position: "外野手" }]
  }, manualRoster, catalog);
  const adminCatalog = applyLiveRosterToManualLineupCatalog(catalog, {
    sourceOfTruth: "official_live",
    players: [{ playerId: "npb:20260001", name: "現行選手", number: "1", position: "外野手" }]
  }, manualRoster);
  assert.deepEqual(publicRoster.players.map((player) => player.number), ["2"]);
  assert.deepEqual(adminCatalog.filter((player) => player.effectiveRosterActive).map((player) => player.uniformNumber), ["2"]);
  assert.equal(publicRoster.manualRosterApplied, true);
});

test("manual roster APIはadmin認証・確認・入力検証を要求する", async () => {
  const { env } = await makeEnv();
  const catalog = getManualLineupPlayerCatalog();
  const noAuth = await worker.fetch(new Request("https://starting9.test/api/admin/v3/manual-roster", { headers: { Origin: "https://starting9.test" } }), env, {});
  assert.equal(noAuth.status, 401);
  const unconfirmed = await worker.fetch(request("/api/admin/v3/manual-roster", "PUT", { teamCode: "fighters", entries: [], confirmed: false }), env, {});
  assert.equal(unconfirmed.status, 409);
  const unknown = await worker.fetch(request("/api/admin/v3/manual-roster", "PUT", { teamCode: "fighters", entries: [{ playerId: "X-1" }], confirmed: true }), env, {});
  assert.equal(unknown.status, 400);
  const invalidTeam = await worker.fetch(request("/api/admin/v3/manual-roster", "PUT", { teamCode: "hawks", entries: [], confirmed: true }), env, {});
  assert.equal(invalidTeam.status, 400);
  const valid = await worker.fetch(request("/api/admin/v3/manual-roster", "PUT", { teamCode: "fighters", entries: [{ playerId: catalog[0].playerId, status: "active", note: "開幕登録" }, { playerId: catalog[1].playerId, status: "inactive" }], confirmed: true }), env, {});
  assert.equal(valid.status, 200);
  const body = await valid.json();
  assert.equal(body.roster.entries.length, 2);
  assert.equal(body.roster.entries[0].mode, "active");
  assert.equal(body.roster.entries[0].rosterSource, "manual");
  assert.match(body.roster.entries[0].updatedBy, /^admin:/);
  const read = await worker.fetch(request("/api/admin/v3/manual-roster?teamCode=fighters"), env, {});
  assert.equal(read.status, 200);
  assert.equal((await read.json()).roster.entries[0].playerId, catalog[0].playerId);
  const auto = await worker.fetch(request("/api/admin/v3/manual-roster", "PUT", {
    teamCode: "fighters",
    entries: [{ playerId: catalog[0].playerId, mode: "auto" }],
    confirmed: true
  }), env, {});
  assert.equal(auto.status, 200);
  assert.equal((await auto.json()).roster.entries[0].mode, "auto");
});

test("manual roster APIはschema未適用時に明示的な503を返す", async () => {
  const { env } = await makeEnv({ withRosterTable: false });
  const response = await worker.fetch(request("/api/admin/v3/manual-roster"), env, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MANUAL_ROSTER_SCHEMA_UNAVAILABLE");
});

test("manual roster repositoryはlineupテーブルへ触れず、取得件数をboundedにする", async () => {
  const { env } = await makeEnv();
  const result = await getManualRoster(env.AUTH_DB);
  assert.equal(result.schemaAvailable, true);
  assert.equal(result.entries.length, 0);
});

test("manual rosterの空保存は全野手をinactiveとして永続化し、static fallbackへ戻らない", async () => {
  const { env } = await makeEnv();
  const catalog = getManualLineupPlayerCatalog();
  const saved = await saveManualRoster(env.AUTH_DB, {
    teamCode: "fighters",
    entries: [],
    updatedBy: "admin:empty-roster",
    now: new Date("2026-09-04T00:00:00.000Z"),
    catalog
  });
  assert.equal(saved.source, "manual");
  assert.equal(saved.isManualSaved, true);
  assert.ok(saved.entries.length > 0);
  assert.ok(saved.entries.every((entry) => entry.status === "inactive"));
  assert.equal(saved.updatedBy, "admin:empty-roster");

  const reread = await getManualRoster(env.AUTH_DB);
  assert.equal(reread.source, "manual");
  assert.equal(reread.isManualSaved, true);
  assert.deepEqual(reread.entries.map((entry) => entry.status), saved.entries.map((entry) => entry.status));
  const prioritized = prioritizeManualRosterCatalog(catalog, reread);
  assert.equal(prioritized.some((player) => player.manualRosterActive === true), false);
  assert.ok(prioritized.filter((player) => player.manualRosterStatus === "inactive").length > 0);
});

test("manual保存済み空状態は行が空でもfallbackを使わない契約を維持する", () => {
  const catalog = [{ playerId: "F-1", playerName: "保存済み空状態" }];
  const prioritized = prioritizeManualRosterCatalog(catalog, {
    schemaAvailable: true,
    source: "manual",
    isManualSaved: true,
    entries: []
  });
  assert.equal(prioritized[0].manualRosterActive, false);
  assert.equal(prioritized[0].manualRosterSource, null);
});

test("manual roster UIはIME検索・確認保存・lineup分離を明示する", () => {
  assert.match(html, /render-manual-roster\.js/);
  assert.match(html, /data-v3-view="roster"/);
  assert.match(admin, /createAdminV3ManualRosterRenderer/);
  assert.match(admin, /updateManualRosterSearch/);
  assert.match(coordinator, /data-v3-manual-roster-search/);
  assert.match(coordinator, /compositionend/);
  assert.match(ui, /manual roster更新はmanual lineupを変更しません/);
  assert.match(ui, /data-v3-manual-roster-confirm/);
  assert.match(ui, /data-v3-manual-roster-auto/);
  assert.match(admin, /removeManualRosterOverride/);
  assert.match(coordinator, /data-v3-manual-roster-auto/);
  assert.match(ui, /AUTO \/ 公式ロースター追従/);
  assert.match(ui, /option value="auto"/);
  assert.doesNotMatch(ui, /data-v3-manual-roster-player-id-input/);
  assert.match(css, /manual-roster-row/);
});
