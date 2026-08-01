import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createScheduleGameIdentifiers,
  getOrCreateInternalGame,
  resolveGameIdentifier
} from "../game-identity-registry.js";
import { buildGameIdentityAuditReport } from "../auth-worker.js";

const firstInternalGameId = "7fe6db3e-8a09-4d67-8f0e-18b6507d4b72";
const secondInternalGameId = "9d2e4508-0d36-4735-b7f8-5700c62cf31c";
const descriptiveGameId = "2026-08-01-fighters-marines-1400";
const compactGameId = "2026-08-01-f-m-15";

function createRegistryDb({ games = [], identifiers = [] } = {}) {
  const state = { games: [...games], identifiers: [...identifiers] };
  return {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              if (sql.includes("FROM game_identifiers")) {
                const [provider, identifierType, identifierValue] = bindings;
                return { results: state.identifiers
                  .filter((row) => row.provider === provider && row.identifier_type === identifierType && row.identifier_value === identifierValue)
                  .map((row) => ({ internal_game_id: row.internal_game_id })) };
              }
              if (sql.includes("FROM games")) {
                const [gameDate, startTime, homeTeam, awayTeam] = bindings;
                return { results: state.games
                  .filter((row) => row.game_date === gameDate && row.start_time === startTime && row.home_team === homeTeam && row.away_team === awayTeam)
                  .map((row) => ({ internal_game_id: row.internal_game_id })) };
              }
              throw new Error(`Unexpected SELECT: ${sql}`);
            },
            async run() {
              if (sql.includes("INSERT INTO games")) {
                const [internalGameId, gameDate, startTime, homeTeam, awayTeam, gameStatus] = bindings;
                state.games.push({ internal_game_id: internalGameId, game_date: gameDate, start_time: startTime, home_team: homeTeam, away_team: awayTeam, game_status: gameStatus });
                return { success: true };
              }
              if (sql.includes("INSERT INTO game_identifiers")) {
                const [internalGameId, provider, identifierType, identifierValue] = bindings;
                state.identifiers.push({ internal_game_id: internalGameId, provider, identifier_type: identifierType, identifier_value: identifierValue });
                return { success: true };
              }
              throw new Error(`Unexpected INSERT: ${sql}`);
            }
          };
        }
      };
    }
  };
}

function scheduleGame(overrides = {}) {
  return {
    gameDate: "2026-08-01",
    startTime: "2026-08-01T05:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "marines",
    ...overrides
  };
}

function scheduleIdentifiers() {
  return createScheduleGameIdentifiers({
    gameId: descriptiveGameId,
    gameCode: "f-m-15",
    sourceGameKey: "schedule:2026-08-01:fighters:marines:1400"
  });
}

test("new schedule creates one UUID and a repeat sync reuses it", async () => {
  const db = createRegistryDb();
  const first = await getOrCreateInternalGame(db, {
    game: scheduleGame(),
    identifiers: scheduleIdentifiers(),
    allowCreate: true,
    createId: () => firstInternalGameId,
    now: new Date("2026-07-31T10:00:00.000Z")
  });
  const second = await getOrCreateInternalGame(db, {
    game: scheduleGame(),
    identifiers: scheduleIdentifiers(),
    allowCreate: true,
    createId: () => { throw new Error("A repeat sync must not generate another UUID"); }
  });
  assert.equal(first.internalGameId, firstInternalGameId);
  assert.equal(second.internalGameId, firstInternalGameId);
  assert.equal(db.state.games.length, 1);
  assert.equal(db.state.identifiers.length, 3);
});

test("descriptive, compact, NPB, and source identifiers resolve to one internal game", async () => {
  const db = createRegistryDb();
  await getOrCreateInternalGame(db, {
    game: scheduleGame(),
    identifiers: scheduleIdentifiers(),
    allowCreate: true,
    createId: () => firstInternalGameId
  });
  const aliases = [
    { provider: "starting9", identifierType: "descriptive_game_id", identifierValue: descriptiveGameId },
    { provider: "starting9", identifierType: "legacy_compact_game_id", identifierValue: compactGameId },
    { provider: "npb", identifierType: "npb_game_code", identifierValue: "f-m-15" },
    { provider: "schedule_worker", identifierType: "source_game_key", identifierValue: "schedule:2026-08-01:fighters:marines:1400" }
  ];
  await getOrCreateInternalGame(db, { game: scheduleGame(), identifiers: [aliases[1]], allowCreate: true, createId: () => secondInternalGameId });
  assert.deepEqual(await Promise.all(aliases.map((identifier) => resolveGameIdentifier(db, identifier))), [firstInternalGameId, firstInternalGameId, firstInternalGameId, firstInternalGameId]);
});

test("ambiguous existing schedule candidates are not automatically merged or assigned a new UUID", async () => {
  const identity = scheduleGame();
  const db = createRegistryDb({
    games: [
      { internal_game_id: firstInternalGameId, game_date: identity.gameDate, start_time: identity.startTime, home_team: identity.homeTeam, away_team: identity.awayTeam },
      { internal_game_id: secondInternalGameId, game_date: identity.gameDate, start_time: identity.startTime, home_team: identity.homeTeam, away_team: identity.awayTeam }
    ]
  });
  const result = await getOrCreateInternalGame(db, { game: identity, identifiers: scheduleIdentifiers(), allowCreate: true, createId: () => "ab490d07-ea41-4f28-8d33-b6ea6b20ed3e" });
  assert.equal(result.status, "ambiguous");
  assert.equal(db.state.games.length, 2);
  assert.equal(db.state.identifiers.length, 0);
});

test("ordinary API resolution never creates an internal game for an unknown identifier", async () => {
  const db = createRegistryDb();
  const result = await getOrCreateInternalGame(db, { game: scheduleGame(), identifiers: scheduleIdentifiers(), allowCreate: false });
  assert.equal(result.status, "not_found");
  assert.equal(db.state.games.length, 0);
});

test("static schedule identifiers are supported without treating an arbitrary string as a game ID", () => {
  const identifiers = createScheduleGameIdentifiers({ staticScheduleGameId: compactGameId });
  assert.deepEqual(identifiers, [{ provider: "static_schedule", identifierType: "static_schedule_game_id", identifierValue: compactGameId }]);
});

test("identity audit retains its existing response and reports registry coverage separately", () => {
  const report = buildGameIdentityAuditReport({
    internalRegistry: {
      available: true,
      gamesCount: 2,
      identifiersCount: 6,
      gamesWithoutIdentifiers: 0,
      identifiersWithoutGames: 0,
      multipleInternalGameCandidates: 0,
      legacyIdsWithoutInternalGameId: 1,
      internalGameIdCoverage: { scheduleGames: 3, linkedScheduleGames: 2, ratio: 2 / 3 }
    }
  });
  assert.equal(report.summary.internalRegistry.gamesCount, 2);
  assert.equal(report.summary.internalRegistry.internalGameIdCoverage.linkedScheduleGames, 2);
  assert.equal(report.recommendation.requiresNewInternalId, false);
});

test("migration adds the registry without making schedule identity a destructive unique constraint", async () => {
  const [migration, worker] = await Promise.all([
    readFile(new URL("../migrations/0023_internal_game_registry.sql", import.meta.url), "utf8"),
    readFile(new URL("../auth-worker.js", import.meta.url), "utf8")
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS games/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_identifiers/);
  assert.match(migration, /UNIQUE\(provider, identifier_type, identifier_value\)/);
  assert.match(migration, /ALTER TABLE detected_game_schedule ADD COLUMN internal_game_id/);
  assert.doesNotMatch(migration, /UNIQUE\(game_date, start_time, home_team, away_team\)/);
  assert.match(worker, /getOrCreateInternalGame\(db,/);
  assert.match(worker, /resolveScheduleInternalGameId/);
  assert.match(worker, /backfillUniqueDetectedScheduleInternalGames/);
  assert.match(worker, /if \(rows\.length !== 1\) continue/);
  assert.match(worker, /internalGameId: game\.internalGameId \|\| ""/);
});
