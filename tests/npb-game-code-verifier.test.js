import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildVerifiedScorePageUrl,
  createSimulatorGameCodeFetcher,
  discoverGameCodeCandidates,
  MAX_GAME_CODE_CANDIDATES,
  resolveVerifiedGameCode,
  validateGameCodeCandidate
} from "../backend/npb-game-code-verifier.js";
import { parseSimulatorResponse } from "../backend/npb-source-adapter.js";

function response(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function scoreHtml({ code = "t-c-19", date = "2026-09-09", home = "tigers", away = "carp", status = "scheduled", series = 19 } = {}) {
  return `<div class="card" data-game-id="fixture-${code}" data-game-code="${code}" data-game-date="${date}" data-home-team="${home}" data-away-team="${away}" data-game-status="${status}"><dl><dd data-series-number="${series}">${series}回戦</dd></dl></div>`;
}

const target = {
  internalGameId: "internal-unchanged",
  gameDate: "2026-09-09",
  homeTeam: "tigers",
  awayTeam: "carp",
  seriesNumberHint: 19
};

function mockFetcher(pages) {
  return async (candidate) => {
    const page = pages[candidate.gameCode];
    if (!page) return { httpStatus: 404, url: `https://example.test/${candidate.gameCode}/` };
    if (page.status) return { httpStatus: page.status, url: `https://example.test/${candidate.gameCode}/` };
    return { httpStatus: 200, url: `https://example.test/${candidate.gameCode}/`, parsed: page.parsed || { ok: true, payload: page.payload } };
  };
}

test("既存game codeは実ページメタデータ一致ならverifiedになり、internalGameIdを変更しない", async () => {
  const result = await resolveVerifiedGameCode(
    { ...target, existingGameCode: "t-c-19" },
    { fetchCandidate: mockFetcher({ "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 19, status: "cancelled" } } }) }
  );
  assert.equal(result.status, "verified");
  assert.equal(result.gameCode, "t-c-19");
  assert.equal(result.target.internalGameId, "internal-unchanged");
  assert.equal(result.attempts.length, 1);
});

test("既存codeの404後はbounded candidate searchへ進み、同じcodeの翌日を採用できる", async () => {
  const result = await resolveVerifiedGameCode({ ...target, existingGameCode: "t-c-18" }, { fetchCandidate: mockFetcher({
    "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 19, status: "scheduled" } }
  }) });
  assert.equal(result.status, "verified");
  assert.equal(result.gameCode, "t-c-19");
  assert.equal(result.attempts[0].rejectionReasons[0], "NOT_FOUND");
});

test("日付・home・awayの不一致はHTTP 200でも採用しない", async () => {
  const result = await resolveVerifiedGameCode(target, { fetchCandidate: mockFetcher({
    "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-10", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 19, status: "scheduled" } },
    "t-c-18": { payload: { gameCode: "t-c-18", date: "2026-09-09", homeTeam: "carp", awayTeam: "tigers", seriesNumber: 18, status: "scheduled" } }
  }) });
  assert.equal(result.status, "invalid_data");
  assert.equal(result.code, "GAME_CODE_INVALID_DATA");
  assert.ok(result.attempts.some((attempt) => attempt.rejectionReasons.includes("DATE_MISMATCH")));
  assert.ok(result.attempts.some((attempt) => attempt.rejectionReasons.includes("HOME_TEAM_MISMATCH")));
});

test("404はnot_found、500はtemporary_failureとして分離する", async () => {
  const notFound = await resolveVerifiedGameCode(target, { fetchCandidate: async () => ({ httpStatus: 404 }) });
  assert.equal(notFound.status, "not_found");
  const temporary = await resolveVerifiedGameCode(target, { fetchCandidate: async () => ({ httpStatus: 500 }) });
  assert.equal(temporary.status, "temporary_failure");
  assert.equal(temporary.code, "GAME_CODE_TEMPORARY_FAILURE");
});

test("empty・malformed・未知statusはinvalid_dataで停止する", async () => {
  const empty = await resolveVerifiedGameCode(target, { fetchCandidate: async () => ({ httpStatus: 200, parsed: { ok: false, code: "NPB_RESPONSE_INVALID" } }) });
  assert.equal(empty.status, "invalid_data");
  const malformed = await resolveVerifiedGameCode(target, { fetchCandidate: async () => ({ httpStatus: 200, parsed: { ok: true, payload: { gameCode: "t-c-19" } } }) });
  assert.equal(malformed.status, "invalid_data");
  const unknown = await resolveVerifiedGameCode(target, { fetchCandidate: mockFetcher({
    "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", status: "future_unknown" } }
  }) });
  assert.equal(unknown.status, "invalid_data");
});

test("複数の実ページが一致した場合は最初を採用せずambiguousにする", async () => {
  const result = await resolveVerifiedGameCode(target, { fetchCandidate: async (candidate) => ({
    httpStatus: 200,
    parsed: { ok: true, payload: { gameCode: candidate.gameCode, date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", status: "scheduled" } }
  }) });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.code, "GAME_CODE_AMBIGUOUS");
  assert.ok(result.matches.length > 1);
});

test("未知teamはfetch前にrejectし、候補数は常にbounded", () => {
  const unknown = discoverGameCodeCandidates({ ...target, homeTeam: "unknown" });
  assert.equal(unknown.status, "invalid_data");
  assert.equal(discoverGameCodeCandidates({ ...target, gameDate: "2026-02-30" }).status, "invalid_data");
  const candidates = discoverGameCodeCandidates({ ...target, existingGameCode: "../../secret", seriesNumberHint: 19 }, { candidateWindow: 99, maxCandidates: 100 });
  assert.equal(candidates.candidates.length, MAX_GAME_CODE_CANDIDATES);
  assert.ok(candidates.candidates.every((candidate) => /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(candidate.gameCode)));
  assert.equal(buildVerifiedScorePageUrl("2026-09-09", "t-c-19"), "https://npb.jp/scores/2026/0909/t-c-19/");
  assert.equal(buildVerifiedScorePageUrl("2026-09-09", "t-c-19", "https://example.test"), "");
  assert.equal(buildVerifiedScorePageUrl("2026-09-09", "../../secret"), "");
});

test("cancelled/no-game pageは有効なexternal identityとして検証できる", async () => {
  for (const status of ["cancelled", "no_game"]) {
    const result = await resolveVerifiedGameCode(target, {
      fetchCandidate: mockFetcher({ "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 19, status } } })
    });
    assert.equal(result.status, "verified", status);
    assert.equal(result.metadata.status, status);
  }
});

test("S9simu score adapterはlineup未発表でもidentity metadataを返す", async () => {
  const parsed = await parseSimulatorResponse(response(scoreHtml()), { mode: "score" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, {
    ok: true,
    gameCode: "t-c-19",
    date: "2026-09-09",
    homeTeam: "tigers",
    awayTeam: "carp",
    seriesNumber: 19,
    status: "scheduled",
    sourceUrl: "simulator",
    fetchedAt: parsed.payload.fetchedAt
  });
});

test("schedule candidate serviceへ渡せるcanonical codeを返し、production自動探索はauth workerに接続しない", async () => {
  const result = await resolveVerifiedGameCode(target, { fetchCandidate: mockFetcher({
    "t-c-19": { payload: { gameCode: "t-c-19", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 19, status: "scheduled" } }
  }) });
  assert.equal(result.status, "verified");
  assert.equal(result.gameCode, "t-c-19");
  const authWorker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(authWorker, /npb-game-code-verifier/);
});

test("simulator fetcherはcandidateから安全なscore URLだけを構成する", async () => {
  let requested = "";
  const fetcher = createSimulatorGameCodeFetcher({ S9SIMU_BASE_URL: "https://s9simu.example" }, {
    fetchImpl: async (url) => { requested = url; return response(scoreHtml()); }
  });
  const result = await fetcher({ gameCode: "t-c-19" }, target);
  assert.equal(result.httpStatus, 200);
  assert.equal(new URL(requested).pathname, "/simu-npb/scores/2026/0909/t-c-19/");
  assert.equal(result.parsed.payload.gameCode, "t-c-19");
});

test("candidate page validationはcandidate codeとseriesの不一致をrejectする", () => {
  const result = validateGameCodeCandidate(target, { gameCode: "t-c-19" }, { payload: { gameCode: "t-c-18", date: "2026-09-09", homeTeam: "tigers", awayTeam: "carp", seriesNumber: 18, status: "scheduled" } });
  assert.equal(result.ok, false);
  assert.ok(result.rejectionReasons.includes("GAME_CODE_MISMATCH"));
  assert.ok(result.rejectionReasons.includes("SERIES_MISMATCH"));
});
