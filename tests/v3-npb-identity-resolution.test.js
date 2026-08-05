import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpbScheduleIdentity } from "../auth-worker.js";

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
