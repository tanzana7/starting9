const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("公示監視は10時開始後、試合2時間前から10分間隔へ切り替わる", async () => {
  const { getNoticePollingPlan } = await import(pathToFileURL(path.join(root, "pregame-automation.js")).href);
  const startAt = new Date("2026-07-22T04:00:00.000Z");
  const timeline = {
    gameId: "2026-07-22-b-f-16",
    game: { date: "2026-07-22" },
    startAt,
    predictionDeadlineAt: new Date(startAt.getTime() - 60 * 60 * 1000)
  };

  assert.deepEqual(getNoticePollingPlan([timeline], new Date("2026-07-22T00:00:00.000Z")), {
    date: "2026-07-22", due: false, intervalMinutes: null, slotKey: "", activeGameIds: [timeline.gameId]
  });
  assert.equal(getNoticePollingPlan([timeline], new Date("2026-07-22T01:29:59.000Z")).slotKey, "2026-07-22:30:0");
  assert.equal(getNoticePollingPlan([timeline], new Date("2026-07-22T01:30:00.000Z")).slotKey, "2026-07-22:30:1");
  assert.equal(getNoticePollingPlan([timeline], new Date("2026-07-22T02:00:00.000Z")).intervalMinutes, 10);
  assert.deepEqual(getNoticePollingPlan([timeline], new Date("2026-07-22T03:01:00.000Z")).activeGameIds, []);
});

test("NPB公示ページから日付、登録抹消、対象球団ロースターを分離して解析する", async () => {
  const { parseNoticePage } = await import(pathToFileURL(path.join(root, "cloudflare-worker.js")).href);
  const html = `
    <h4>2026年7月22日の出場選手登録</h4>
    <h5>出場選手登録</h5><table><tr><td>北海道日本ハムファイターズ</td><td>投手</td><td>39</td><td>有薗 直輝</td></tr></table>
    <h5>出場選手登録抹消</h5><table><tr><td>北海道日本ハムファイターズ</td><td>外野手</td><td>66</td><td>万波　中正</td></tr></table>
    <h5>北海道日本ハムファイターズ</h5><table><tr><td>投手</td><td>39</td><td>有薗 直輝</td></tr></table>
    <h5>オリックス・バファローズ</h5><table><tr><td>投手</td><td>18</td><td>宮城 大弥</td></tr></table>`;
  const parsed = parseNoticePage(html);
  assert.equal(parsed.date, "2026-07-22");
  assert.deepEqual(parsed.registrations[0], { teamCode: "fighters", position: "投手", number: "39", name: "有薗直輝" });
  assert.deepEqual(parsed.removals[0], { teamCode: "fighters", position: "外野手", number: "66", name: "万波中正" });
  assert.deepEqual(parsed.rosters.fighters[0], { position: "投手", number: "39", name: "有薗直輝" });
  assert.deepEqual(parsed.rosters.buffaloes[0], { position: "投手", number: "18", name: "宮城大弥" });
});

test("試合前自動処理は公示・非公開採点・開始後公開の責務を持つ", () => {
  const auth = read("auth-worker.js");
  const migration = read("migrations/0010_game_day_schedule_flow.sql");
  const html = read("index.html");
  const script = read("script.js");
  assert.match(auth, /mode: "notice"/);
  assert.match(auth, /\/api\/game-day-roster/);
  assert.match(auth, /snapshotTeams = Array\.isArray\(rosters\.fighters\)/);
  assert.match(auth, /resolveGameDayResultStatus\(\{/);
  assert.match(auth, /runScheduledGameAutomationV3/);
  assert.match(auth, /V3_JOB_TYPE\.ROSTER_FETCH/);
  assert.doesNotMatch(auth, /runDueGameDayScheduleJobs/);
  assert.match(auth, /publication_status = 'scored_private'/);
  assert.match(auth, /async function publishGameResults/);
  assert.match(auth, /isGameResultsPublished/);
  assert.match(auth, /status: published \? row\.status : row\.status === "scored" \? "submitted"/);
  assert.doesNotMatch(auth, /await markGameRankingEligible\(/);
  assert.match(migration, /rosters_json TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(migration, /publication_status/);
  assert.match(html, /id="gameDayNoticeStatus"/);
  assert.doesNotMatch(html, /id="runPregameNoticeButton"|id="publishPregameResultsButton"/);
  assert.match(script, /api\/game-day-status/);
  assert.doesNotMatch(script, /結果の公開判定を実行しました/);
});
