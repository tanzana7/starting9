import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const worker = fs.readFileSync(workerPath, "utf8");

test("予告先発は両側未発表と部分取得を区別し、空値で既存投手を消さない", () => {
  assert.match(worker, /const hasAnyPitcher = Boolean\(homePitcherName \|\| awayPitcherName\)/);
  assert.match(worker, /const fullyAnnounced = Boolean\(homePitcherName && awayPitcherName\)/);
  assert.match(worker, /status: announced \? "success" : "notPublished"/);
  assert.match(worker, /home_pitcher_name = COALESCE\(excluded\.home_pitcher_name, probable_starters\.home_pitcher_name\)/);
  assert.match(worker, /away_pitcher_name = COALESCE\(excluded\.away_pitcher_name, probable_starters\.away_pitcher_name\)/);
  assert.match(worker, /isProbableStarterTerminal\(row\)/);
});

test("V3概要と公開APIは同じ正規row serializerを使い、部分取得を返せる", async () => {
  const { serializeProbableStarterRow, isProbableStarterComplete, isProbableStarterTerminal } = await import(pathToFileURL(workerPath));
  const row = {
    game_id: "2026-08-07-fighters-eagles-1800",
    internal_game_id: "11111111-1111-4111-8111-111111111111",
    status: "announced",
    home_pitcher_name: "投手A",
    away_pitcher_name: "",
    fetched_at: "2026-08-06T09:00:00.000Z",
    source_url: "https://npb.jp/announcement/starter/"
  };
  const serialized = serializeProbableStarterRow(row);
  assert.equal(serialized.internalGameId, row.internal_game_id);
  assert.deepEqual(serialized.homeProbableStarter, { name: "投手A", playerId: null });
  assert.deepEqual(serialized.awayProbableStarter, { name: "", playerId: null });
  assert.equal(serialized.partial, true);
  assert.equal(serialized.dataStatus, "partial");
  assert.equal(isProbableStarterComplete(row), false);
  assert.equal(isProbableStarterTerminal(row), true);
});

test("公開APIはadmin-v3と同じinternalGameId優先rowを返し、HTTP 200空結果を成功扱いしない", () => {
  assert.match(worker, /readProbableStarterRow\(env\.AUTH_DB, \{/);
  assert.match(worker, /WHERE internal_game_id = \?1\s+OR \(internal_game_id IS NULL AND game_id = \?2\)/);
  assert.match(worker, /homeProbableStarter: probableStarter\?\.homeProbableStarter \|\| null/);
  assert.match(worker, /awayProbableStarter: probableStarter\?\.awayProbableStarter \|\| null/);
  assert.match(worker, /status: announced \? "success" : "notPublished"/);
  assert.match(worker, /PROBABLE_STARTER_UNANNOUNCED/);
  assert.match(script, /status === "announced" && !hasAnyPitcher/);
});

test("予告先発候補は公式ページのhome/away向きを対象試合へ正規化する", async () => {
  const { findProbableStarterGame } = await import(pathToFileURL(workerPath));
  const matched = findProbableStarterGame({
    date: "2026-08-14",
    homeTeam: "fighters",
    awayTeam: "buffaloes"
  }, [{
    date: "2026-08-14",
    homeTeam: "buffaloes",
    awayTeam: "fighters",
    homeTeamName: "オリックス・バファローズ",
    awayTeamName: "北海道日本ハムファイターズ",
    homeStarter: { name: "髙島 泰都" },
    awayStarter: { name: "達 孝太" }
  }]);
  assert.equal(matched.matchOrientation, "reversed");
  assert.equal(matched.homeTeam, "fighters");
  assert.equal(matched.awayTeam, "buffaloes");
  assert.equal(matched.homeStarter.name, "達 孝太");
  assert.equal(matched.awayStarter.name, "髙島 泰都");
});
