import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyNpbScheduleFetchError, fetchNpbWorkerJson, mergeNpbScheduleCandidates, resolveNpbScheduleIdentity } from "../auth-worker.js";
import { normalizeScheduleTeamCode } from "../game-schedule-detection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const npbWorker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");

test("NPB日程照合は既存の球団正規化と日付・開始時刻・home/awayを使う", () => {
  const result = resolveNpbScheduleIdentity({
    date: "2026-08-04",
    startAt: "2026-08-04T09:00:00.000Z",
    homeTeam: "福岡ソフトバンクホークス",
    awayTeam: "日本ハム",
    games: [{ homeTeam: "ソフトバンク", awayTeam: "fighters", startTime: "18:00", gameCode: "h-f-15" }]
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.gameCode, "h-f-15");
  assert.equal(result.gameUrl, "https://npb.jp/scores/2026/0804/h-f-15/");
});

test("複数候補はNPB識別子を推測せずconflictで停止する", () => {
  const result = resolveNpbScheduleIdentity({
    date: "2026-08-04",
    startAt: "2026-08-04T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: [
      { homeTeam: "hawks", awayTeam: "fighters", startTime: "18:00", gameCode: "h-f-15" },
      { homeTeam: "hawks", awayTeam: "fighters", startTime: "18:00", gameCode: "h-f-16" }
    ]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.code, "NPB_IDENTITY_CONFLICT");
});

test("NPB日程にコードがない場合だけ未解決になる", () => {
  const result = resolveNpbScheduleIdentity({
    date: "2026-08-04",
    startAt: "2026-08-04T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: [{ homeTeam: "hawks", awayTeam: "fighters", startTime: "18:00" }]
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "NPB_IDENTITY_UNRESOLVED");
});

test("NPB候補の実レスポンス形を複数日・JST基準で解決する", () => {
  const fixtures = [
    ["2026-08-05", "H", "F", "h-f-16"],
    ["2026-08-06", "hawks", "fighters", "h-f-17"],
    ["2026-08-07", "E", "F", "e-f-18"],
    ["2026-08-08", "楽天", "北海道日本ハムファイターズ", "e-f-19"]
  ];
  for (const [date, homeTeam, awayTeam, gameCode] of fixtures) {
    const result = resolveNpbScheduleIdentity({
      date,
      startAt: `${date}T09:00:00.000Z`,
      homeTeam,
      awayTeam,
      games: [{ home_team: homeTeam, away_team: awayTeam, start_time: "18:00:00", game_code: gameCode }]
    });
    assert.equal(result.status, "resolved", date);
    assert.equal(result.gameCode, gameCode, date);
    assert.equal(result.diagnostics.targetGameDateJst, date, date);
    assert.equal(result.diagnostics.targetStartTimeJst, "18:00", date);
  }
});

test("既存の球団正規化はH/Eを含むNPB略号とhome/away順を維持する", () => {
  assert.equal(normalizeScheduleTeamCode("H"), "hawks");
  assert.equal(normalizeScheduleTeamCode("E"), "eagles");
  assert.equal(normalizeScheduleTeamCode("F"), "fighters");
  const reversed = resolveNpbScheduleIdentity({
    date: "2026-08-05",
    startAt: "2026-08-05T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: [{ homeTeam: "F", awayTeam: "H", startTime: "18:00", gameCode: "f-h-16" }]
  });
  assert.equal(reversed.code, "NPB_IDENTITY_UNRESOLVED");
  assert.equal(reversed.diagnostics.rejectionReasonCounts.reverse_home_away, 1);
});

test("候補時刻はHH:mm、秒付き、UTC ISO、JST ISOを同じ試合日として扱う", () => {
  const values = ["18:00", "18:00:00", "2026-08-05T09:00:00.000Z", "2026-08-05T18:00:00"];
  for (const startTime of values) {
    const result = resolveNpbScheduleIdentity({
      date: "2026-08-05",
      startAt: "2026-08-05T09:00:00.000Z",
      homeTeam: "hawks",
      awayTeam: "fighters",
      games: [{ homeTeam: "hawks", awayTeam: "fighters", startAt: startTime, gameCode: "h-f-16" }]
    });
    assert.equal(result.status, "resolved", startTime);
  }
});

test("NPB Service Bindingはscheduleモードの日付をGETで渡し、レスポンス形を保持する", async () => {
  let requestedUrl = "";
  const payload = {
    ok: true,
    date: "2026-08-05",
    games: [{ homeTeam: "hawks", awayTeam: "fighters", startTime: "18:00", gameCode: "h-f-16" }]
  };
  const result = await fetchNpbWorkerJson({
    NPB_FETCH_WORKER: {
      fetch: async (request) => {
        requestedUrl = request.url;
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
  }, { mode: "schedule", date: "2026-08-05" });
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("mode"), "schedule");
  assert.equal(url.searchParams.get("date"), "2026-08-05");
  assert.deepEqual(result.games, payload.games);
});

test("候補取得失敗とレスポンス不正・空候補を別コードへ分類する", () => {
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_HTTP_ERROR" }), "NPB_SCHEDULE_FETCH_FAILED");
  assert.equal(classifyNpbScheduleFetchError({ code: "SCHEDULE_PARSE_FAILED" }), "NPB_SCHEDULE_RESPONSE_INVALID");
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_RESPONSE_INVALID" }), "NPB_SCHEDULE_RESPONSE_INVALID");
  assert.equal(classifyNpbScheduleFetchError({ code: "SCHEDULE_EMPTY" }), "NPB_SCHEDULE_EMPTY");
  const noMatch = resolveNpbScheduleIdentity({
    date: "2026-08-05",
    startAt: "2026-08-05T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: [{ homeTeam: "eagles", awayTeam: "fighters", startTime: "18:00", gameCode: "e-f-18" }]
  });
  assert.equal(noMatch.code, "NPB_IDENTITY_UNRESOLVED");
  assert.equal(noMatch.diagnostics.rejectionReasonCounts.team_mismatch, 1);
});

test("日別ページにコードがない未来試合は既存静的日程の保存済み公式URLで補完する", () => {
  const merged = mergeNpbScheduleCandidates(
    [{ homeTeam: "ソフトバンク", awayTeam: "日本ハム", startTime: "18:00" }],
    [{ date: "2026-08-05", startTime: "18:00", homeTeam: "hawks", awayTeam: "fighters", npbScoreUrl: "https://npb.jp/scores/2026/0805/h-f-16/" }],
    "2026-08-05"
  );
  const result = resolveNpbScheduleIdentity({
    date: "2026-08-05",
    startAt: "2026-08-05T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: merged
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.gameCode, "h-f-16");
  assert.equal(result.diagnostics.resolvedBy, "npb_schedule+static_schedule");
  assert.equal(result.gameUrl, "https://npb.jp/scores/2026/0805/h-f-16/");
});

test("日程同期はgamesへNPB識別情報を渡し、公式WorkerはURLを返す", () => {
  assert.match(worker, /npbGameUrl: String\(game\.npbGameUrl/);
  assert.match(worker, /sourceScheduleKey: sourceGameKey/);
  assert.match(worker, /npbIdentityStatus: npbGameCode \? "resolved" : "unresolved"/);
  assert.match(npbWorker, /npbGameUrl: buildNpbGameUrl\(date, game\.gameCode\)/);
});

test("V3 lineup fetchは保存URLを優先し、未解決時はlegacy fallbackを使わない", () => {
  assert.match(worker, /createV3LineupIdentity/);
  assert.match(worker, /fetchNpbWorkerJson\(env, \{ mode: "lineup", url: identityOverride\.sourceUrl \}\)/);
  assert.match(worker, /NPB_IDENTITY_UNRESOLVED/);
  const v3Section = worker.slice(worker.indexOf("function createV3LineupIdentity"), worker.indexOf("async function executeGameAutomationV3Job"));
  assert.doesNotMatch(v3Section, /resolvePregameIdentity/);
});
