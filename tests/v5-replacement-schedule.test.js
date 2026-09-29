import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulatorResponse } from "../backend/npb-source-adapter.js";
import { isV3GameEligible } from "../backend/automation-v3/domain.js";
import {
  discoverAdditionalScheduleCandidates,
  normalizeScheduleCandidate,
  registerDevelopmentScheduleCandidate,
  validateScheduleCandidate
} from "../backend/automation-v3/schedule-candidate-service.js";

const SIMULATOR_FIXTURE = {
  games: [
    { gameId: "game-b", gameDate: "2026-09-08", startAt: "2026-09-08T18:00:00+09:00", homeTeam: "tigers", awayTeam: "carp", npbGameCode: "t-c-19", seriesNumber: 19, status: "cancelled", replacementGame: { gameId: "game-c" } },
    { gameId: "game-c", gameDate: "2026-09-09", startAt: "2026-09-09T18:00:00+09:00", homeTeam: "tigers", awayTeam: "carp", npbGameCode: "t-c-19", seriesNumber: 19, status: "scheduled" }
  ]
};

function response(body, status = 200, contentType = "application/json") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function fightersCandidate(overrides = {}) {
  return {
    gameId: "game-future-fighters",
    gameDate: "2026-09-30",
    startAt: "2026-09-30T18:00:00+09:00",
    homeTeam: "fighters",
    awayTeam: "marines",
    npbGameCode: "f-m-26",
    seriesNumber: 26,
    status: "scheduled",
    ...overrides
  };
}

function assertCandidateError(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test("実S9simu相当のcancelled originalを保持し、replacementを別candidateとして検出する", async () => {
  const parsed = await parseSimulatorResponse(response(JSON.stringify(SIMULATOR_FIXTURE)), { mode: "schedule" });
  const result = discoverAdditionalScheduleCandidates(parsed.payload.games, [], { requiredTeam: null, source: "s9simu" });
  assert.equal(result.cancelledOriginals[0].externalGameId, "game-b");
  assert.equal(result.candidates[0].externalGameId, "game-c");
  assert.equal(result.candidates[0].replacementOfExternalGameId, "game-b");
  assert.equal(result.candidates[0].npbGameCode, "t-c-19");
  assert.equal(parsed.payload.games[0].replacementGameId, "game-c");
  assert.equal(Object.hasOwn(parsed.payload.games[0], "replacementGame"), false);
  assert.notEqual(result.candidates[0].externalGameId, result.cancelledOriginals[0].externalGameId);
});

test("replacement candidateはnormalizeされ、Fighters以外は登録validationで拒否する", () => {
  const candidate = normalizeScheduleCandidate(fightersCandidate(), { source: "s9simu" });
  assert.equal(candidate.homeTeam, "fighters");
  assert.equal(candidate.startAt, "2026-09-30T09:00:00.000Z");
  assert.equal(validateScheduleCandidate(candidate).ok, true);
  const nonFighters = normalizeScheduleCandidate({ ...fightersCandidate(), homeTeam: "tigers", awayTeam: "carp", npbGameCode: "t-c-27" });
  assert.deepEqual(validateScheduleCandidate(nonFighters).errors, ["target_team_missing"]);
});

test("same series/codeでも日付が違えばduplicateにせず、同日同カードcodeはdedupeする", () => {
  const existing = normalizeScheduleCandidate(fightersCandidate({ gameId: "old", gameDate: "2026-09-29", startAt: "2026-09-29T18:00:00+09:00", npbGameCode: "f-m-26" }));
  const differentDate = discoverAdditionalScheduleCandidates([fightersCandidate()], [existing]);
  assert.equal(differentDate.candidates.length, 1);
  const sameDate = discoverAdditionalScheduleCandidates([fightersCandidate({ gameId: "duplicate" })], [normalizeScheduleCandidate(fightersCandidate())]);
  assert.equal(sameDate.candidates.length, 0);
  const staticSchedule = discoverAdditionalScheduleCandidates([fightersCandidate({ gameId: "external-static" })], [{
    gameId: "2026-09-30-f-m-26",
    date: "2026-09-30",
    startTime: "18:00",
    homeTeam: "fighters",
    awayTeam: "marines"
  }]);
  assert.equal(staticSchedule.candidates.length, 0);
});

test("malformed/unknown team/date/code/statusをrejectし、no-game original後のreplacementは登録可能候補になる", () => {
  assertCandidateError(() => normalizeScheduleCandidate(fightersCandidate({ gameDate: "2026-02-30" })), "SCHEDULE_CANDIDATE_INVALID");
  assertCandidateError(() => normalizeScheduleCandidate(fightersCandidate({ homeTeam: "unknown" })), "SCHEDULE_CANDIDATE_INVALID");
  assertCandidateError(() => normalizeScheduleCandidate(fightersCandidate({ npbGameCode: "bad-code" })), "SCHEDULE_CANDIDATE_GAME_CODE_INVALID");
  const noGame = fightersCandidate({ gameId: "old-no-game", status: "no-game", npbGameCode: "f-m-25" });
  const replacement = fightersCandidate({ gameId: "new-game", gameDate: "2026-10-01", startAt: "2026-10-01T18:00:00+09:00", npbGameCode: "f-m-25" });
  const result = discoverAdditionalScheduleCandidates([noGame, replacement], [], { requiredTeam: "fighters" });
  assert.equal(result.cancelledOriginals[0].status, "no_game");
  assert.equal(result.candidates[0].externalGameId, "new-game");
});

test("development/testだけ既存identity registryへ新internalGameIdを登録し、planner入力を返す", async () => {
  const state = { games: [], identifiers: [] };
  const db = {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              if (sql.includes("FROM game_identifiers")) {
                return { results: state.identifiers.filter((row) => row.provider === bindings[0] && row.identifier_type === bindings[1] && row.identifier_value === bindings[2]).map((row) => ({ internal_game_id: row.internal_game_id })) };
              }
              if (sql.includes("FROM games") && sql.includes("start_time = ?2")) {
                return { results: state.games.filter((row) => row.game_date === bindings[0] && row.start_time === bindings[1] && row.home_team === bindings[2] && row.away_team === bindings[3]).map((row) => ({ internal_game_id: row.internal_game_id })) };
              }
              if (sql.includes("FROM games")) {
                return { results: state.games.filter((row) => row.game_date === bindings[0] && row.home_team === bindings[1] && row.away_team === bindings[2]).map((row) => ({ ...row })) };
              }
              if (sql.includes("PRAGMA table_info(games)")) return { results: ["npb_game_code", "npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source", "game_date", "start_time", "home_team", "away_team", "game_status", "season", "stadium", "updated_by", "updated_at"].map((name) => ({ name })) };
              if (sql.includes("SELECT npb_game_code")) return { results: [state.games.find((row) => row.internal_game_id === bindings[0]) || {}] };
              throw new Error(`Unexpected SELECT: ${sql}`);
            },
            async first() {
              if (sql.includes("SELECT npb_game_code")) return state.games.find((row) => row.internal_game_id === bindings[0]) || null;
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO games")) {
                const [internalGameId, gameDate, startTime, homeTeam, awayTeam, gameStatus] = bindings;
                state.games.push({ internal_game_id: internalGameId, internalGameId, game_date: gameDate, start_time: startTime, home_team: homeTeam, away_team: awayTeam, game_status: gameStatus });
                return { success: true };
              }
              if (sql.includes("INSERT INTO game_identifiers")) {
                const [internalGameId, provider, identifierType, identifierValue] = bindings;
                state.identifiers.push({ internal_game_id: internalGameId, provider, identifier_type: identifierType, identifier_value: identifierValue });
                return { success: true };
              }
              if (sql.includes("UPDATE games SET")) return { success: true };
              throw new Error(`Unexpected write: ${sql}`);
            }
          };
        }
      };
    }
  };
  const candidate = normalizeScheduleCandidate(fightersCandidate(), { source: "s9simu" });
  const result = await registerDevelopmentScheduleCandidate(db, candidate, { environment: "test", createId: () => "7fe6db3e-8a09-4d67-8f0e-18b6507d4b72" });
  assert.equal(result.status, "registered");
  assert.equal(result.internalGameId, "7fe6db3e-8a09-4d67-8f0e-18b6507d4b72");
  assert.equal(isV3GameEligible(result.plannerInput), true);
  assert.equal(state.games.length, 1);
  const rescheduled = normalizeScheduleCandidate(fightersCandidate({
    gameId: "game-rescheduled",
    gameDate: "2026-10-01",
    startAt: "2026-10-01T18:00:00+09:00",
    npbGameCode: "f-m-26"
  }), { source: "s9simu" });
  const second = await registerDevelopmentScheduleCandidate(db, rescheduled, { environment: "test", createId: () => "9d2e4508-0d36-4735-b7f8-5700c62cf31c" });
  assert.equal(second.status, "registered");
  assert.equal(second.internalGameId, "9d2e4508-0d36-4735-b7f8-5700c62cf31c");
  assert.equal(state.games.length, 2);
  await assert.rejects(() => registerDevelopmentScheduleCandidate(db, candidate, { environment: "production" }), (error) => error?.code === "SCHEDULE_CANDIDATE_REGISTRATION_DISABLED");
});
