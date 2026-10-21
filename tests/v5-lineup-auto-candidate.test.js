import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FIGHTERS_PLAYER_MASTER, createFightersPlayerId } from "../fighters-player-master.js";
import {
  buildLineupAlertSignal,
  createLineupCandidate,
  fetchLineupCandidateForGame,
  finalizeVerifiedLineupCandidate,
  isAutoFinalEligible,
  persistLineupCandidate,
  runLineupCandidatePipeline
} from "../backend/automation-v3/lineup-candidate-service.js";
import { evaluateAdminAlertCandidates } from "../backend/admin-alerts/evaluator.js";
import teamContext from "../frontend/shared/team-context.js";

const TARGET = {
  internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee",
  gameDate: "2026-09-28",
  homeTeam: "marines",
  awayTeam: "fighters",
  npbGameCode: "m-f-25"
};

const MASTER_LINEUP = [
  ["マルティネス", "捕"], ["上川畑大悟", "二"], ["野村佑希", "三"],
  ["清宮幸太郎", "一"], ["水野達稀", "遊"], ["郡司裕也", "左"],
  ["五十幡亮汰", "中"], ["万波中正", "右"], ["レイエス", "指"]
];

function makeLineup(overrides = {}) {
  return MASTER_LINEUP.map(([playerName, position], index) => ({
    battingOrder: index + 1,
    playerId: createFightersPlayerId(FIGHTERS_PLAYER_MASTER.find((player) => player.name === playerName)?.uniformNumber || ""),
    playerName,
    position,
    uniformNumber: FIGHTERS_PLAYER_MASTER.find((player) => player.name === playerName)?.uniformNumber || "",
    teamCode: "fighters",
    teamId: "F",
    ...(overrides[index] || {})
  }));
}

function makePayload(lineup = makeLineup(), extra = {}) {
  return {
    date: TARGET.gameDate,
    homeTeam: TARGET.homeTeam,
    awayTeam: TARGET.awayTeam,
    gameCode: TARGET.npbGameCode,
    status: "lineup_announced",
    fetchedAt: "2026-09-28T09:00:00.000Z",
    lineup,
    ...extra
  };
}

function simulatorHtml(lineup = makeLineup(), extra = {}) {
  const rows = lineup.map((row) => `<tr data-batting-order="${row.battingOrder}" data-player-id="${row.playerId || ""}" data-player-name="${row.playerName || ""}" data-position="${row.position || ""}" data-jersey-number="${row.uniformNumber || ""}"></tr>`).join("");
  return `<div data-game-code="${extra.gameCode || TARGET.npbGameCode}" data-game-date="${extra.date || TARGET.gameDate}" data-home-team="${extra.homeTeam || TARGET.homeTeam}" data-away-team="${extra.awayTeam || TARGET.awayTeam}" data-game-status="${extra.status || "lineup_announced"}"><table data-lineup-team="fighters">${rows}</table></div>`;
}

function response(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function createDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_lineup_revisions (
      game_id TEXT NOT NULL,
      internal_game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      revision_id TEXT,
      actual_lineup_json TEXT NOT NULL,
      lineup_fingerprint TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('npb-auto', 'manual', 'manual-revision', 'restore')),
      created_at TEXT NOT NULL,
      created_by TEXT,
      reason TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      superseded_at TEXT,
      captured_at TEXT,
      validation_json TEXT,
      unresolved_player_count INTEGER NOT NULL DEFAULT 0,
      is_final INTEGER NOT NULL DEFAULT 0,
      finalized_at TEXT,
      finalized_by TEXT,
      PRIMARY KEY (game_id, version)
    );
    CREATE UNIQUE INDEX game_lineup_revision_id ON game_lineup_revisions(revision_id);
    CREATE UNIQUE INDEX game_lineup_current ON game_lineup_revisions(internal_game_id) WHERE is_current = 1;
    CREATE TABLE game_lineups (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      internal_game_id TEXT NOT NULL UNIQUE,
      actual_lineup_json TEXT,
      lineup_fingerprint TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      lineup_detected_at TEXT,
      scoring_due_at TEXT,
      scoring_started_at TEXT,
      scored_at TEXT,
      scoring_status TEXT NOT NULL DEFAULT 'pending',
      scoring_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      processed_predictions INTEGER,
      perfect_count INTEGER,
      new_perfect_achievers TEXT,
      lineup_source TEXT,
      publication_status TEXT NOT NULL DEFAULT 'pending',
      published_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      final_lineup_revision_id TEXT,
      finalized_at TEXT,
      finalized_by TEXT,
      UNIQUE(game_id)
    );
  `);
  database.prepare("INSERT INTO game_lineups (id, game_id, internal_game_id) VALUES (?, ?, ?)").run("lineup-1", TARGET.internalGameId, TARGET.internalGameId);
  return {
    database,
    db: {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          bind(...values) {
            return {
              all: async () => ({ results: statement.all(...values) }),
              first: async () => statement.get(...values),
              run: async () => ({ meta: { changes: statement.run(...values).changes } })
            };
          }
        };
      },
      batch: async (statements) => statements.map((statement) => statement.run())
    }
  };
}

function simulatorEnv(extra = {}) {
  return {
    ENVIRONMENT: "test",
    ENABLE_DEVELOPMENT_MODE: "true",
    NPB_SOURCE: "simulator",
    S9SIMU_BASE_URL: "https://s9simu.example.test",
    ...extra
  };
}

function simulatorFetch(body, status = 200) {
  return async () => response(body, status);
}

test("normal S9simu lineupはcandidateへ変換され、strict validation後にverifiedになる", async () => {
  const fixture = createDb();
  const result = await runLineupCandidatePipeline({
    env: simulatorEnv(), target: TARGET, db: fixture.db,
    fetchImpl: simulatorFetch(simulatorHtml()), now: new Date("2026-09-28T09:01:00.000Z")
  });
  assert.equal(result.status, "verified");
  assert.equal(result.candidate.lineup.length, 9);
  assert.equal(result.candidate.lineup[0].playerId, "F-2");
  assert.equal(result.persisted.status, "created");
  assert.equal(result.persisted.revision.is_final, 0);
  fixture.database.close();
});

test("shadow candidateはrevisionへ明示記録されるがfinalへ進まない", async () => {
  const fixture = createDb();
  const result = await runLineupCandidatePipeline({
    env: simulatorEnv(), target: TARGET, db: fixture.db,
    fetchImpl: simulatorFetch(simulatorHtml()), shadowMode: true, autoFinalEnabled: true,
    now: new Date("2026-09-28T09:01:00.000Z")
  });
  const stored = fixture.database.prepare("SELECT validation_json, is_final FROM game_lineup_revisions WHERE internal_game_id = ?").get(TARGET.internalGameId);
  assert.equal(result.persisted.status, "created");
  assert.equal(JSON.parse(stored.validation_json).shadowMode, true);
  assert.equal(stored.is_final, 0);
  assert.equal(fixture.database.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?").get(TARGET.internalGameId).final_lineup_revision_id, null);
  fixture.database.close();
});

test("lineup delayedは未発表のまま待機し、後刻の取得でverifiedになる", async () => {
  const first = await fetchLineupCandidateForGame(simulatorEnv(), TARGET, { fetchImpl: simulatorFetch(`<div data-game-code="${TARGET.npbGameCode}" data-game-date="${TARGET.gameDate}" data-home-team="${TARGET.homeTeam}" data-away-team="${TARGET.awayTeam}" data-game-status="scheduled"><table data-lineup-team="fighters"></table></div>`) });
  assert.equal(first.status, "not_published");
  const later = await runLineupCandidatePipeline({ env: simulatorEnv(), target: TARGET, fetchImpl: simulatorFetch(simulatorHtml()) });
  assert.equal(later.status, "verified");
  assert.deepEqual(buildLineupAlertSignal(first), {});
});

test("8人・10人は補完や切り捨てをせずrejectする", () => {
  for (const count of [8, 10]) {
    const lineup = count === 8 ? makeLineup().slice(0, 8) : [...makeLineup(), { ...makeLineup()[0], battingOrder: 10 }];
    const result = createLineupCandidate(makePayload(lineup), TARGET);
    assert.equal(result.status, "invalid_lineup");
    assert.equal(result.candidate.lineup.length, count);
  }
});

test("重複打順・重複選手・守備位置欠損はverifiedにしない", () => {
  const duplicateOrder = createLineupCandidate(makePayload(makeLineup({ 1: { battingOrder: 1 } })), TARGET);
  assert.equal(duplicateOrder.status, "invalid_lineup");
  const duplicatePlayer = createLineupCandidate(makePayload(makeLineup({ 1: { playerName: "マルティネス", playerId: "F-2", uniformNumber: "2" } })), TARGET);
  assert.equal(duplicatePlayer.status, "invalid_lineup");
  const missingPosition = createLineupCandidate(makePayload(makeLineup({ 2: { position: "" } })), TARGET);
  assert.equal(missingPosition.status, "invalid_lineup");
});

test("日付・対戦相手・NPB game codeの不一致はidentity_mismatch", () => {
  for (const field of ["date", "homeTeam", "awayTeam", "gameCode"]) {
    const payload = makePayload();
    payload[field] = field === "date" ? "2026-09-29" : field === "homeTeam" ? "fighters" : field === "awayTeam" ? "marines" : "m-f-24";
    const result = createLineupCandidate(payload, TARGET);
    assert.equal(result.status, "identity_mismatch", field);
  }
});

test("unknown playerはrejectし、roster外でも検証済みtemporary identityならhard rejectしない", () => {
  const unknown = createLineupCandidate(makePayload(makeLineup({ 0: { playerName: "存在しない選手", playerId: "", uniformNumber: "" } })), TARGET);
  assert.equal(unknown.status, "unknown_player");
  const temporary = makeLineup({ 0: { playerName: "育成選手", playerId: "npb:12345678", uniformNumber: "200" } });
  const rosterOut = createLineupCandidate(makePayload(temporary), TARGET, {
    trustedTemporaryPlayers: [{ playerId: "npb:12345678", name: "育成選手", number: "200" }]
  });
  assert.equal(rosterOut.status, "verified");
  assert.equal(rosterOut.candidate.lineup[0].resolutionStatus, "temporary_npb");
});

test("同名のtemporary identityが複数ある場合はambiguous_playerとして停止する", () => {
  const temporary = makeLineup({ 0: { playerName: "育成選手", playerId: "npb:12345678", uniformNumber: "200" } });
  const result = createLineupCandidate(makePayload(temporary), TARGET, {
    trustedTemporaryPlayers: [
      { playerId: "npb:12345678", name: "育成選手", number: "200" },
      { playerId: "npb:87654321", name: "育成選手", number: "201" }
    ]
  });
  assert.equal(result.status, "ambiguous_player");
});

test("非Fighters contest candidateは対象Team Contextのtrusted rosterだけで検証する", () => {
  const targetTeam = teamContext.NPB_TEAMS.marines;
  const target = { ...TARGET, homeTeam: "marines", awayTeam: "fighters" };
  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  const trustedTemporaryPlayers = positions.map((position, index) => ({
    playerId: `npb:${String(61000000 + index).padStart(8, "0")}`,
    name: `Marines player ${index + 1}`,
    number: String(index + 1),
    teamCode: "marines",
    teamId: targetTeam.playerTeamId
  }));
  const lineup = trustedTemporaryPlayers.map((player, index) => ({
    ...player,
    battingOrder: index + 1,
    playerName: player.name,
    uniformNumber: player.number,
    position: positions[index]
  }));
  const valid = createLineupCandidate(makePayload(lineup), target, {
    targetTeam,
    trustedTemporaryPlayers
  });
  assert.equal(valid.status, "verified");
  assert.ok(valid.candidate.lineup.every((player) => player.teamCode === "marines" && player.teamId === "M"));

  const wrongTeam = createLineupCandidate(makePayload(lineup.map((player, index) => index === 0
    ? { ...player, teamCode: "fighters", teamId: "F" }
    : player)), target, { targetTeam, trustedTemporaryPlayers });
  assert.equal(wrongTeam.status, "invalid_lineup");
  assert.equal(wrongTeam.code, "LINEUP_TEAM_MISMATCH");

  const noRoster = createLineupCandidate(makePayload(lineup), target, { targetTeam });
  assert.equal(noRoster.status, "unknown_player", "non-Fighters must not resolve through the Fighters master");
});

test("cancelled/no_gameはcandidateやfinalを作らない", async () => {
  for (const status of ["cancelled", "no-game"]) {
    const fixture = createDb();
    const result = await runLineupCandidatePipeline({
      env: simulatorEnv(), target: TARGET, db: fixture.db,
      fetchImpl: simulatorFetch(`<div data-game-code="${TARGET.npbGameCode}" data-game-date="${TARGET.gameDate}" data-home-team="${TARGET.homeTeam}" data-away-team="${TARGET.awayTeam}" data-game-status="${status}"></div>`)
    });
    assert.equal(result.status, status === "no-game" ? "no_game" : "cancelled");
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions").get().count, 0);
    fixture.database.close();
  }
});

test("temporary 500/404・malformedはtemporaryまたはinvalidとなりfinalを作らない", async () => {
  const fiveHundred = await fetchLineupCandidateForGame(simulatorEnv(), TARGET, { fetchImpl: simulatorFetch("error", 500) });
  assert.equal(fiveHundred.status, "temporary_failure");
  const notFound = await fetchLineupCandidateForGame(simulatorEnv(), TARGET, { fetchImpl: simulatorFetch("", 404) });
  assert.equal(notFound.status, "temporary_failure");
  const malformed = await fetchLineupCandidateForGame(simulatorEnv(), TARGET, { fetchImpl: simulatorFetch("<article>malformed</article>") });
  assert.equal(malformed.status, "invalid_lineup");
  assert.deepEqual(buildLineupAlertSignal(fiveHundred), {});
});

test("同一candidateの再取得はrevisionを増やさず、変更後candidateだけ新versionになる", async () => {
  const fixture = createDb();
  const env = simulatorEnv();
  const first = await runLineupCandidatePipeline({ env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml()) });
  const same = await runLineupCandidatePipeline({ env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml()) });
  assert.equal(same.persisted.status, "no_op");
  const changed = makeLineup({ 0: { playerName: "田宮裕涼", playerId: "F-64", uniformNumber: "64" } });
  const updated = await runLineupCandidatePipeline({ env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml(changed)) });
  assert.equal(updated.status, "verified");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions").get().count, 2);
  assert.notEqual(first.persisted.revision.version, updated.persisted.revision.version);
  fixture.database.close();
});

test("manual final済み試合はauto candidateをfinalにせず、manual final raceも拒否する", async () => {
  const fixture = createDb();
  const env = simulatorEnv();
  const manual = makeLineup();
  const manualJson = JSON.stringify(manual);
  fixture.database.prepare(`INSERT INTO game_lineup_revisions
    (game_id, internal_game_id, version, revision_id, actual_lineup_json, lineup_fingerprint, source, created_at, reason, is_current, is_final)
    VALUES (?, ?, 1, ?, ?, 'manual-fingerprint', 'manual', '2026-09-28T09:00:00.000Z', 'manual final', 1, 1)`)
    .run(TARGET.internalGameId, TARGET.internalGameId, `${TARGET.internalGameId}:1`, manualJson);
  const skipped = await runLineupCandidatePipeline({ env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml()), autoFinalEnabled: true });
  assert.equal(skipped.status, "manual_final_exists");

  const raceFixture = createDb();
  const candidate = await runLineupCandidatePipeline({ env, target: TARGET, db: raceFixture.db, fetchImpl: simulatorFetch(simulatorHtml()) });
  raceFixture.database.prepare(`INSERT INTO game_lineup_revisions
    (game_id, internal_game_id, version, revision_id, actual_lineup_json, lineup_fingerprint, source, created_at, reason, is_current, is_final)
    VALUES (?, ?, 2, ?, ?, 'race-manual', 'manual-revision', '2026-09-28T09:00:00.000Z', 'race final', 1, 1)`)
    .run(TARGET.internalGameId, TARGET.internalGameId, `${TARGET.internalGameId}:2`, manualJson);
  const race = await finalizeVerifiedLineupCandidate(raceFixture.db, { candidate: candidate.candidate, revision: candidate.persisted.revision });
  assert.equal(race.status, "manual_final_exists");
  fixture.database.close();
  raceFixture.database.close();
});

test("新しいcandidateが後から保存された場合、遅延した古いcandidateはfinalizeしない", async () => {
  const fixture = createDb();
  const env = simulatorEnv();
  const first = await runLineupCandidatePipeline({
    env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml())
  });
  const changed = makeLineup({ 0: { playerName: "田宮裕涼", playerId: "F-64", uniformNumber: "64" } });
  await runLineupCandidatePipeline({
    env, target: TARGET, db: fixture.db, fetchImpl: simulatorFetch(simulatorHtml(changed))
  });
  const stale = await finalizeVerifiedLineupCandidate(fixture.db, {
    candidate: first.candidate,
    revision: first.persisted.revision
  });
  assert.equal(stale.status, "conflict");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE is_final = 1").get().count, 0);
  fixture.database.close();
});

test("verified candidateはdevelopment/testで明示的に有効化した場合だけcanonical finalへ進む", async () => {
  const fixture = createDb();
  const result = await runLineupCandidatePipeline({
    env: simulatorEnv(), target: TARGET, db: fixture.db,
    fetchImpl: simulatorFetch(simulatorHtml()), autoFinalEnabled: true
  });
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.finalized.status, "finalized");
  const lineup = fixture.database.prepare("SELECT final_lineup_revision_id, lineup_source FROM game_lineups WHERE internal_game_id = ?").get(TARGET.internalGameId);
  assert.equal(lineup.final_lineup_revision_id, result.finalized.revision.revision_id);
  assert.equal(lineup.lineup_source, "npb-auto");
  fixture.database.close();
});

test("productionではauto-finalとsimulatorがfail-closedし、official fetchでもfinalを作らない", async () => {
  let simulatorCalled = false;
  const production = await runLineupCandidatePipeline({
    env: simulatorEnv({ ENVIRONMENT: "production", ENABLE_DEVELOPMENT_MODE: "false" }),
    target: TARGET, autoFinalEnabled: true,
    fetchOfficial: async () => ({ ok: true, payload: makePayload() }),
    fetchImpl: async () => { simulatorCalled = true; return response(simulatorHtml()); }
  });
  assert.equal(production.source, "official");
  assert.equal(production.eligibility.eligible, false);
  assert.equal(production.eligibility.reason, "PRODUCTION_AUTO_FINAL_DISABLED");
  assert.equal(simulatorCalled, false);
});

test("Pushは通常待機を通知せず、grace超過・invalid・ambiguous・identity mismatchを既存alert modelへ変換する", () => {
  assert.deepEqual(buildLineupAlertSignal({ status: "not_published" }), {});
  assert.deepEqual(buildLineupAlertSignal({ status: "not_published" }, { missingAfterGrace: true }), { lineupAutoFailed: true });
  assert.deepEqual(buildLineupAlertSignal({ status: "invalid_lineup" }), { lineupInvalid: true });
  assert.deepEqual(buildLineupAlertSignal({ status: "ambiguous_player" }), { lineupPlayerAmbiguous: true });
  assert.deepEqual(buildLineupAlertSignal({ status: "identity_mismatch" }), { lineupIdentityMismatch: true });
  const alerts = evaluateAdminAlertCandidates({
    game: TARGET,
    signals: { lineupAutoFailed: true, lineupInvalid: true, lineupPlayerAmbiguous: true, lineupIdentityMismatch: true }
  });
  assert.deepEqual(alerts.map((alert) => alert.alertType), [
    "lineup_auto_failed", "lineup_invalid", "lineup_player_ambiguous", "lineup_identity_mismatch"
  ]);
  assert.ok(alerts.every((alert) => alert.actionPath.startsWith("/admin-v3.html")));
});

test("auto-final eligibilityはmanual final、terminal status、secondary source、productionを拒否する", () => {
  const candidate = { source: "official", status: "lineup_announced" };
  const verification = { status: "verified" };
  assert.equal(isAutoFinalEligible({ candidate, verification, environment: "test", autoFinalEnabled: true }).eligible, true);
  assert.equal(isAutoFinalEligible({ candidate, verification, environment: "production", autoFinalEnabled: true }).reason, "PRODUCTION_AUTO_FINAL_DISABLED");
  assert.equal(isAutoFinalEligible({ candidate, verification, environment: "test", autoFinalEnabled: true, manualFinalExists: true }).reason, "MANUAL_FINAL_EXISTS");
  assert.equal(isAutoFinalEligible({ candidate: { ...candidate, source: "secondary" }, verification, environment: "test", autoFinalEnabled: true }).reason, "SOURCE_NOT_TRUSTED");
});

test("source URLは環境設定からのみ構成され、production configはlineup autoを有効化しない", async () => {
  const official = await fetchLineupCandidateForGame({ ENVIRONMENT: "production", ENABLE_DEVELOPMENT_MODE: "false" }, TARGET, {
    fetchOfficial: async () => ({ ok: true, payload: makePayload() })
  });
  assert.equal(official.source, "official");
  assert.equal(official.status, "fetched");
});
