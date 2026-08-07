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

test("予告先発候補はhome/away完全一致だけを採用し、逆向き候補を使わない", () => {
  const findBlock = worker.slice(worker.indexOf("function findProbableStarterGame"), worker.indexOf("export function serializeProbableStarterRow"));
  assert.match(findBlock, /return exact \|\| null/);
  assert.doesNotMatch(findBlock, /const teams = new Set/);
});
