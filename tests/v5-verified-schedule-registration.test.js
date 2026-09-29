import assert from "node:assert/strict";
import test from "node:test";
import { isV3GameEligible } from "../backend/automation-v3/domain.js";
import {
  registerVerifiedDevelopmentScheduleCandidate,
  registerVerifiedDevelopmentScheduleCandidates
} from "../backend/automation-v3/verified-schedule-candidate-service.js";

function candidate(overrides = {}) {
  return {
    gameId: "external-game-c",
    gameDate: "2026-09-09",
    startAt: "2026-09-09T18:00:00+09:00",
    homeTeam: "fighters",
    awayTeam: "marines",
    npbGameCode: "f-m-20",
    seriesNumber: 20,
    status: "scheduled",
    ...overrides
  };
}

function page(game = {}) {
  return {
    ok: true,
    payload: {
      gameCode: game.gameCode || "f-m-19",
      date: game.date || "2026-09-09",
      homeTeam: game.homeTeam || "fighters",
      awayTeam: game.awayTeam || "marines",
      seriesNumber: game.seriesNumber ?? 20,
      status: game.status || "scheduled"
    }
  };
}

function fetcher(pages, calls = []) {
  return async (candidateArg) => {
    calls.push(candidateArg.gameCode);
    const result = pages[candidateArg.gameCode];
    if (result === undefined) return { httpStatus: 404 };
    if (result instanceof Error) throw result;
    return result;
  };
}

function createDb() {
  const state = { games: [], identifiers: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              if (sql.includes("FROM game_identifiers")) {
                return {
                  results: state.identifiers
                    .filter((row) => row.provider === bindings[0]
                      && row.identifier_type === bindings[1]
                      && row.identifier_value === bindings[2])
                    .map((row) => ({ internal_game_id: row.internal_game_id }))
                };
              }
              if (sql.includes("FROM games") && sql.includes("start_time = ?2")) {
                return {
                  results: state.games
                    .filter((row) => row.game_date === bindings[0]
                      && row.start_time === bindings[1]
                      && row.home_team === bindings[2]
                      && row.away_team === bindings[3])
                    .map((row) => ({ internal_game_id: row.internal_game_id }))
                };
              }
              if (sql.includes("FROM games")) {
                return {
                  results: state.games
                    .filter((row) => row.game_date === bindings[0]
                      && row.home_team === bindings[1]
                      && row.away_team === bindings[2])
                    .map((row) => ({ ...row }))
                };
              }
              if (sql.includes("PRAGMA table_info(games)")) {
                return {
                  results: [
                    "internal_game_id", "game_date", "start_time", "home_team", "away_team", "game_status",
                    "npb_game_code", "npb_game_url", "source_schedule_key", "npb_identity_status",
                    "npb_identity_resolved_at", "npb_identity_source", "season", "stadium", "updated_by", "updated_at"
                  ].map((name) => ({ name }))
                };
              }
              throw new Error(`Unexpected SELECT: ${sql}`);
            },
            async first() {
              if (sql.includes("SELECT npb_game_code")) {
                return state.games.find((row) => row.internal_game_id === bindings[0]) || null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO games")) {
                const [internalGameId, gameDate, startTime, homeTeam, awayTeam, gameStatus] = bindings;
                state.games.push({
                  internal_game_id: internalGameId,
                  game_date: gameDate,
                  start_time: startTime,
                  home_team: homeTeam,
                  away_team: awayTeam,
                  game_status: gameStatus,
                  npb_game_code: null
                });
                return { success: true };
              }
              if (sql.includes("INSERT INTO game_identifiers")) {
                const [internalGameId, provider, identifierType, identifierValue] = bindings;
                state.identifiers.push({
                  internal_game_id: internalGameId,
                  provider,
                  identifier_type: identifierType,
                  identifier_value: identifierValue
                });
                return { success: true };
              }
              if (sql.includes("UPDATE games SET")) {
                const internalGameId = bindings[bindings.length - 1];
                const row = state.games.find((game) => game.internal_game_id === internalGameId);
                const gameCodeMatch = /npb_game_code = \?(\d+)/.exec(sql);
                if (row && gameCodeMatch) row.npb_game_code = bindings[Number(gameCodeMatch[1]) - 1];
                return { success: true };
              }
              throw new Error(`Unexpected write: ${sql}`);
            }
          };
        }
      };
    }
  };
  return db;
}

const idFactory = (() => {
  let next = 1;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
})();

test("verified candidateはcorrected codeで登録し、planner inputを返す", async () => {
  const db = createDb();
  const calls = [];
  const result = await registerVerifiedDevelopmentScheduleCandidate(db, candidate(), [], {
    environment: "test",
    fetchCandidate: fetcher({ "f-m-20": { httpStatus: 200, parsed: page({ gameCode: "f-m-19" }) }, "f-m-19": { httpStatus: 200, parsed: page() } }, calls),
    createId: idFactory
  });
  assert.equal(result.status, "registered");
  assert.equal(result.originalNpbGameCode, "f-m-20");
  assert.equal(result.verifiedNpbGameCode, "f-m-19");
  assert.equal(result.candidate.npbGameCode, "f-m-20");
  assert.equal(result.candidate.replacementOfExternalGameId, "");
  assert.equal(db.state.games[0].npb_game_code, "f-m-19");
  assert.equal(isV3GameEligible(result.plannerInput), true);
  assert.equal(result.internalGameId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(calls, ["f-m-20", "f-m-19", "f-m-21", "f-m-18", "f-m-22"]);
});

test("not_found・ambiguous・temporary_failure・invalid_dataは登録しない", async () => {
  const cases = [
    ["not_found", {}, "not_found"],
    ["temporary_failure", { "f-m-20": { httpStatus: 503 } }, "temporary_failure"],
    ["invalid_data", { "f-m-20": { httpStatus: 200, parsed: { ok: false, code: "NPB_RESPONSE_INVALID" } } }, "invalid_data"]
  ];
  for (const [name, pages, reason] of cases) {
    const result = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate(), [], {
      environment: "test",
      fetchCandidate: fetcher(pages),
      createId: idFactory
    });
    assert.equal(result.status, "verification_failed", name);
    assert.equal(result.reason, reason, name);
  }
  const ambiguous = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate(), [], {
    environment: "test",
    fetchCandidate: fetcher({
      "f-m-20": { httpStatus: 200, parsed: page({ gameCode: "f-m-19" }) },
      "f-m-19": { httpStatus: 200, parsed: page({ gameCode: "f-m-19" }) },
      "f-m-21": { httpStatus: 200, parsed: page({ gameCode: "f-m-21" }) }
    }),
    createId: idFactory
  });
  assert.equal(ambiguous.status, "verification_failed");
  assert.equal(ambiguous.reason, "ambiguous");
});

test("verified pageがcancelledならidentity検証後もregistrationを拒否する", async () => {
  const result = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate(), [], {
    environment: "test",
    fetchCandidate: fetcher({ "f-m-20": { httpStatus: 200, parsed: page({ gameCode: "f-m-20", status: "cancelled" }) } }),
    createId: idFactory
  });
  assert.equal(result.status, "not_registerable");
  assert.deepEqual(result.errors, ["verified_page_terminal"]);
});

test("corrected verified identityが既存scheduleと重複する場合は最終dedupeで登録しない", async () => {
  const db = createDb();
  const existing = await registerVerifiedDevelopmentScheduleCandidate(db, candidate({ gameId: "existing", npbGameCode: "f-m-19" }), [], {
    environment: "test",
    fetchCandidate: fetcher({ "f-m-19": { httpStatus: 200, parsed: page() } }),
    createId: idFactory
  });
  assert.equal(existing.status, "registered");
  const duplicate = await registerVerifiedDevelopmentScheduleCandidate(db, candidate({ gameId: "new", npbGameCode: "f-m-20" }), [], {
    environment: "test",
    fetchCandidate: fetcher({ "f-m-20": { httpStatus: 200, parsed: page({ gameCode: "f-m-20" }) }, "f-m-19": { httpStatus: 200, parsed: page() } }),
    createId: idFactory
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(db.state.games.length, 1);
});

test("same codeでも別日なら別internalGameIdになり、同一candidateの再登録はduplicateになる", async () => {
  const db = createDb();
  const fetchPages = {
    "f-m-19": { httpStatus: 200, parsed: page({ date: "2026-09-09", gameCode: "f-m-19", seriesNumber: 19 }) }
  };
  const first = await registerVerifiedDevelopmentScheduleCandidate(db, candidate({ gameId: "game-0909", npbGameCode: "f-m-19", seriesNumber: 19 }), [], {
    environment: "test", fetchCandidate: fetcher(fetchPages), createId: idFactory
  });
  const second = await registerVerifiedDevelopmentScheduleCandidate(db, candidate({
    gameId: "game-0910", gameDate: "2026-09-10", startAt: "2026-09-10T18:00:00+09:00", npbGameCode: "f-m-19", seriesNumber: 19
  }), [], {
    environment: "test", fetchCandidate: fetcher({ "f-m-19": { httpStatus: 200, parsed: page({ date: "2026-09-10", gameCode: "f-m-19", seriesNumber: 19 }) } }), createId: idFactory
  });
  assert.equal(first.status, "registered");
  assert.equal(second.status, "registered");
  assert.notEqual(first.internalGameId, second.internalGameId);
  assert.equal(db.state.games.length, 2);
  const retry = await registerVerifiedSchedule(db, candidate({ gameId: "game-0909", npbGameCode: "f-m-19", seriesNumber: 19 }), fetchPages);
  assert.equal(retry.status, "duplicate");

  async function registerVerifiedSchedule(database, raw, pages) {
    return registerVerifiedDevelopmentScheduleCandidate(database, raw, [], {
      environment: "test", fetchCandidate: fetcher(pages), createId: idFactory
    });
  }
});

test("replacement relationを保持し、original cancelled/no_gameを変更しない", async () => {
  const db = createDb();
  const result = await registerVerifiedDevelopmentScheduleCandidates(db, [
    { ...candidate({ gameId: "game-b", gameDate: "2026-09-08", startAt: "2026-09-08T18:00:00+09:00", npbGameCode: "f-m-19", seriesNumber: 19, status: "cancelled" }), replacementGame: { gameId: "game-c" } },
    candidate({ gameId: "game-c", replacementOfExternalGameId: "game-b" })
  ], [], {
    environment: "test",
    fetchCandidate: fetcher({ "f-m-19": { httpStatus: 200, parsed: page({ gameCode: "f-m-19" }) } }),
    createId: idFactory
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "registered");
  assert.equal(result.results[0].candidate.replacementOfExternalGameId, "game-b");
  assert.equal(result.discovery.cancelledOriginals[0].externalGameId, "game-b");
  assert.equal(db.state.games.length, 1);
});

test("production・unknown team・malicious codeは外部取得や登録を行わない", async () => {
  let fetchCount = 0;
  const fetchCandidate = async () => { fetchCount += 1; return { httpStatus: 200, parsed: page() }; };
  const production = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate(), [], {
    environment: "production", fetchCandidate
  });
  assert.equal(production.status, "production_disabled");
  assert.equal(fetchCount, 0);
  const unknown = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate({ homeTeam: "unknown" }), [], {
    environment: "test", fetchCandidate
  });
  assert.equal(unknown.status, "verification_failed");
  const malicious = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate({ npbGameCode: "../../secret" }), [], {
    environment: "test", fetchCandidate
  });
  assert.equal(malicious.status, "verification_failed");
  assert.equal(fetchCount, 0);
});

test("bounded candidate数とexisting hint firstを維持する", async () => {
  const calls = [];
  const result = await registerVerifiedDevelopmentScheduleCandidate(createDb(), candidate(), [], {
    environment: "test", candidateWindow: 99, maxCandidates: 100,
    fetchCandidate: fetcher({ "f-m-20": { httpStatus: 200, parsed: page({ gameCode: "f-m-20" }) } }, calls), createId: idFactory
  });
  assert.equal(result.status, "registered");
  assert.deepEqual(calls, ["f-m-20"]);
  assert.ok(calls.length <= 7);
});
