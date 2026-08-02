const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("正常なreadinessはready=trueで、過去service_unavailableはwarningに留める", async () => {
  const { deriveReleaseReadiness } = await import("../auth-worker.js");
  const result = deriveReleaseReadiness({ counts: { serviceUnavailableCount: 2 } });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, ["SERVICE_UNAVAILABLE_GAMES"]);
});

test("stale lease、ID未割当、欠落job、legacy-only writeはblockerになる", async () => {
  const { deriveReleaseReadiness } = await import("../auth-worker.js");
  const result = deriveReleaseReadiness({ counts: {
    staleLeaseCount: 1,
    gamesWithoutInternalGameId: 1,
    missingDownstreamJobCount: 1,
    newLegacyOnlyWritesLast24h: 1
  } });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, [
    "NEW_GAME_WITHOUT_INTERNAL_ID",
    "MISSING_DOWNSTREAM_JOB",
    "STALE_LEASE",
    "RECENT_LEGACY_ONLY_WRITE"
  ]);
});

test("readiness APIは管理者専用の読み取りAPIで、個人情報を返さない", () => {
  const worker = read("auth-worker.js");
  const html = read("index.html");
  const script = read("script.js");
  assert.match(worker, /path === "\/api\/admin\/audit\/release-readiness" && request\.method === "GET"/);
  assert.match(worker, /async function handleAdminReleaseReadiness\(request, env, cors\)/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\)/);
  const readinessHandler = worker.slice(worker.indexOf("async function handleAdminReleaseReadiness"), worker.indexOf("export function selectNextPredictionTarget"));
  assert.doesNotMatch(readinessHandler, /user_id|username|prediction_json/);
  assert.match(html, /id="adminReleaseReadiness"/);
  assert.match(html, /id="refreshAdminReleaseReadinessButton"/);
  assert.match(script, /api\/admin\/audit\/release-readiness/);
  assert.match(script, /credentials: "include"/);
});

test("readinessは監査範囲を現在日前後へ限定し、過去orphanだけをblockerにしない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const yesterday = new Date\(now\.getTime\(\) - 24 \* 60 \* 60 \* 1000\)/);
  assert.match(worker, /const tomorrow = new Date\(now\.getTime\(\) \+ 48 \* 60 \* 60 \* 1000\)/);
  assert.match(worker, /SERVICE_UNAVAILABLE_GAMES/);
  assert.doesNotMatch(worker.slice(worker.indexOf("export function deriveReleaseReadiness"), worker.indexOf("async function collectReleaseReadiness")), /OBSOLETE_ORPHAN/);
});
