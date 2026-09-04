import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyNpbScheduleFetchError, fetchNpbWorkerJson, mergeNpbScheduleCandidates, resolveNpbScheduleIdentity } from "../auth-worker.js";
import { normalizeScheduleTeamCode } from "../game-schedule-detection.js";
import { getV3NpbIdentityState } from "../game-automation-v3.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const npbWorker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
const staticSchedule = JSON.parse(fs.readFileSync(path.join(root, "game-schedule-2026.json"), "utf8"));

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
  assert.equal(result.code, "NPB_STATIC_SCHEDULE_NO_IDENTITY");
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
  assert.equal(reversed.code, "NPB_IDENTITY_NO_MATCH");
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

test("NPB候補取得エラーはHTTP状態と安全なendpoint診断を保持する", async () => {
  await assert.rejects(
    fetchNpbWorkerJson({
      NPB_FETCH_WORKER: {
        fetch: async () => new Response(JSON.stringify({ ok: false, code: "SCHEDULE_FETCH_FAILED" }), { status: 502, headers: { "Content-Type": "application/json" } })
      }
    }, { mode: "schedule", date: "2026-08-05" }),
    (error) => {
      assert.equal(error.code, "SCHEDULE_FETCH_FAILED");
      assert.equal(error.httpStatus, 502);
      assert.match(error.fetchEndpoint, /mode=schedule/);
      assert.doesNotMatch(error.fetchEndpoint, /token|cookie|secret/i);
      return true;
    }
  );
});

test("候補取得失敗とレスポンス不正・空候補を別コードへ分類する", () => {
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_HTTP_ERROR" }), "NPB_SCHEDULE_FETCH_FAILED");
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_HTTP_ERROR", httpStatus: 502 }), "NPB_SCHEDULE_HTTP_ERROR");
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_WORKER_TIMEOUT" }), "NPB_SCHEDULE_FETCH_FAILED");
  assert.equal(classifyNpbScheduleFetchError({ code: "SCHEDULE_PARSE_FAILED" }), "NPB_SCHEDULE_RESPONSE_INVALID");
  assert.equal(classifyNpbScheduleFetchError({ code: "NPB_RESPONSE_INVALID" }), "NPB_SCHEDULE_RESPONSE_INVALID");
  assert.equal(classifyNpbScheduleFetchError({ code: "SCHEDULE_EMPTY" }), "NPB_SCHEDULE_FETCH_FAILED");
  const noMatch = resolveNpbScheduleIdentity({
    date: "2026-08-05",
    startAt: "2026-08-05T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: [{ homeTeam: "eagles", awayTeam: "fighters", startTime: "18:00", gameCode: "e-f-18" }]
  });
  assert.equal(noMatch.code, "NPB_IDENTITY_NO_MATCH");
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

test("静的候補が逆向きでもDB向きを保持してidentityだけ安全に補完する", () => {
  const staticRow = staticSchedule.find((game) => game.date === "2026-08-06");
  assert.deepEqual({ homeTeam: staticRow.homeTeam, awayTeam: staticRow.awayTeam }, { homeTeam: "hawks", awayTeam: "fighters" });
  const target = { game_date: "2026-08-06", start_time: "2026-08-06T09:00:00.000Z", home_team: "fighters", away_team: "hawks" };
  const merged = mergeNpbScheduleCandidates(
    [{ homeTeam: "fighters", awayTeam: "hawks", startTime: "18:00" }],
    [staticRow],
    target.game_date,
    target
  );
  assert.equal(merged.length, 1);
  assert.deepEqual({ homeTeam: merged[0].homeTeam, awayTeam: merged[0].awayTeam }, { homeTeam: "fighters", awayTeam: "hawks" });
  assert.equal(merged[0].gameCode, "h-f-17");
  assert.equal(merged[0].resolutionSource, "static_schedule_enrichment");
  const result = resolveNpbScheduleIdentity({ date: target.game_date, startAt: target.start_time, homeTeam: target.home_team, awayTeam: target.away_team, games: merged });
  assert.equal(result.status, "resolved");
  assert.equal(result.diagnostics.resolvedBy, "static_schedule_enrichment");
  assert.equal(result.gameCode, "h-f-17");
});

test("静的候補は同一日・時刻・チーム集合でないidentityを補完しない", () => {
  const target = { game_date: "2026-08-06", start_time: "2026-08-06T09:00:00.000Z", home_team: "fighters", away_team: "hawks" };
  const other = { date: "2026-08-06", startTime: "18:00", homeTeam: "eagles", awayTeam: "fighters", npbScoreUrl: "https://npb.jp/scores/2026/0806/e-f-17/" };
  const merged = mergeNpbScheduleCandidates([], [other], target.game_date, target);
  assert.equal(merged.length, 0);
});

test("静的identity補完は4方向のhome/awayでもDB向きを維持する", () => {
  const cases = [
    ["fighters", "hawks", "hawks", "fighters", "f-h-1"],
    ["hawks", "fighters", "fighters", "hawks", "h-f-2"],
    ["fighters", "eagles", "eagles", "fighters", "f-e-3"],
    ["eagles", "fighters", "fighters", "eagles", "e-f-4"]
  ];
  for (const [targetHome, targetAway, staticHome, staticAway, gameCode] of cases) {
    const target = { game_date: "2026-08-06", start_time: "2026-08-06T09:00:00.000Z", home_team: targetHome, away_team: targetAway };
    const merged = mergeNpbScheduleCandidates(
      [{ homeTeam: targetHome, awayTeam: targetAway, startTime: "18:00" }],
      [{ date: target.game_date, startTime: "18:00", homeTeam: staticHome, awayTeam: staticAway, gameCode }],
      target.game_date,
      target
    );
    assert.equal(merged.length, 1, `${targetHome}/${targetAway}`);
    assert.deepEqual({ homeTeam: merged[0].homeTeam, awayTeam: merged[0].awayTeam }, { homeTeam: targetHome, awayTeam: targetAway });
    assert.equal(merged[0].gameCode, gameCode);
    assert.equal(resolveNpbScheduleIdentity({ date: target.game_date, startAt: target.start_time, homeTeam: targetHome, awayTeam: targetAway, games: merged }).status, "resolved");
  }
});

test("8月5日から8月8日の静的日程は既存公式URLからだけコードを補完する", () => {
  const expected = [
    ["2026-08-05", "hawks", "fighters", "h-f-16", "09:00"],
    ["2026-08-06", "hawks", "fighters", "h-f-17", "09:00"],
    ["2026-08-07", "fighters", "eagles", "f-e-17", "09:00"],
    ["2026-08-08", "fighters", "eagles", "f-e-18", "06:00"]
  ];
  for (const [date, homeTeam, awayTeam, code, utcTime] of expected) {
    const row = staticSchedule.find((game) => game.date === date && game.homeTeam === homeTeam && game.awayTeam === awayTeam);
    assert.ok(row, date);
    const merged = mergeNpbScheduleCandidates([], [row], date);
    const result = resolveNpbScheduleIdentity({ date, startAt: `${date}T${utcTime}:00.000Z`, homeTeam, awayTeam, games: merged });
    assert.equal(result.status, "resolved", date);
    assert.equal(result.gameCode, code, date);
    assert.match(result.gameUrl, new RegExp(`/${code}/$`), date);
  }
});

test("診断候補は最大10件で、取得形状と拒否理由を安全に表現する", () => {
  const result = resolveNpbScheduleIdentity({
    date: "2026-08-05",
    startAt: "2026-08-05T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    games: Array.from({ length: 12 }, (_, index) => ({
      date: "2026-08-05",
      homeTeam: index === 0 ? "hawks" : "eagles",
      awayTeam: "fighters",
      startTime: "18:00",
      gameCode: `h-f-${index + 1}`
    }))
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.diagnostics.rawCandidateCount, 12);
  assert.equal(result.diagnostics.candidates.length, 10);
  assert.equal(result.diagnostics.candidates[1].rejectionReasons.includes("HOME_TEAM_MISMATCH"), true);
  assert.equal(result.diagnostics.candidates[0].gameCodePresent, true);
});

test("NPB識別情報はDB状態を変えずに未来・取得待ち・確認必要を実行時分類する", () => {
  const start = new Date("2026-08-05T09:00:00.000Z");
  assert.equal(getV3NpbIdentityState({ npbIdentityStatus: "unresolved", startAt: start }, new Date("2026-08-05T07:00:00.000Z")), "pending");
  assert.equal(getV3NpbIdentityState({ npbIdentityStatus: "unresolved", startAt: start }, new Date("2026-08-05T08:20:00.000Z")), "retry_wait");
  assert.equal(getV3NpbIdentityState({ npbIdentityStatus: "unresolved", startAt: start }, new Date("2026-08-05T09:03:00.000Z")), "manual_action_required");
  assert.equal(getV3NpbIdentityState({ npbIdentityStatus: "resolved", startAt: start }, new Date("2026-08-05T09:03:00.000Z")), "resolved");
});

test("日程同期はgamesへNPB識別情報を渡し、公式WorkerはURLを返す", () => {
  assert.match(worker, /npbGameUrl: String\(game\.npbGameUrl/);
  assert.match(worker, /sourceScheduleKey: sourceGameKey/);
  assert.match(worker, /npbIdentityStatus: npbGameCode \? "resolved" : "unresolved"/);
  assert.match(npbWorker, /npbGameUrl: buildNpbGameUrl\(date, game\.gameCode\)/);
  assert.match(npbWorker, /return jsonResponse\(\{ ok: true, date, sourceUrl, fetchedAt: new Date\(\)\.toISOString\(\), games: normalizedGames \}\)/);
  assert.match(worker, /NPB_SCHEDULE_CANDIDATES_EMPTY/);
  assert.match(worker, /NPB_STATIC_SCHEDULE_EMPTY/);
  assert.match(worker, /NPB_SCHEDULE_RESPONSE_INVALID/);
  assert.match(worker, /NPB_IDENTITY_NO_MATCH/);
});

test("V3 lineup fetchは保存URLを優先し、未解決時はlegacy fallbackを使わない", () => {
  assert.match(worker, /createV3LineupIdentity/);
  assert.match(worker, /const lineupFetchParams = \{/);
  assert.match(worker, /fetchNpbWorkerJson\(env, lineupFetchParams\)/);
  assert.match(worker, /homeTeam: identity\.game\.homeTeam/);
  assert.match(worker, /awayTeam: identity\.game\.awayTeam/);
  assert.match(worker, /NPB_IDENTITY_UNRESOLVED/);
  const v3Section = worker.slice(worker.indexOf("function createV3LineupIdentity"), worker.indexOf("async function executeGameAutomationV3Job"));
  assert.doesNotMatch(v3Section, /resolvePregameIdentity/);
});

test("NPB識別未解決jobは完了扱いにせず正式runnerの再試行・要対応へ送る", () => {
  assert.match(worker, /NPB_IDENTITY_PENDING/);
  assert.match(worker, /NPB_IDENTITY_MANUAL_ACTION_REQUIRED/);
  assert.match(worker, /retryAt: getNextV3IdentityRetryAt\(now\)/);
  assert.doesNotMatch(
    worker.slice(worker.indexOf("async function executeV3IdentityResolutionJob"), worker.indexOf("async function executeV3IdentityExecutor")),
    /status: identityState/
  );
});

test("admin overviewは締切・識別・lineup state gateの診断を返す", () => {
  const gameProgress = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
  assert.match(worker, /workflowDiagnostics/);
  assert.match(worker, /getV3WorkflowDiagnostics\(\{/);
  assert.match(gameProgress, /data-v3-workflow-diagnostics/);
});

test("V3管理画面はNPB識別情報とjob監査を読み取り表示する", () => {
  const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const diagnostics = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
  const jobDetails = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-job-details.js"), "utf8");
  const gameProgress = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
  const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  assert.match(diagnostics, /renderAutomationLogs/);
  assert.match(jobDetails, /renderInline/);
  assert.match(jobDetails, /planner decision/);
  assert.ok(diagnostics.includes("${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}"));
  assert.match(page, /admin-v3\.css\?v=manual-lineup-confirmation-1/);
  assert.match(page, /admin-v3\.js\?v=manual-lineup-finalize-safety-1/);
  assert.match(diagnostics, /NPB自動解決job/);
  assert.match(diagnostics, /解決元/);
});
