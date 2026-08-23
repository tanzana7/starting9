import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const worker = read("auth-worker.js");
const renderer = read("frontend/admin-v3/render-ranking-reset.js");
const client = read("frontend/admin-v3/api-client.js");
const coordinator = read("frontend/admin-v3/app-coordinator.js");
const state = read("frontend/admin-v3/state.js");
const page = read("admin-v3.html");

test("ランキング対象外の過去試合一覧はadmin認証付きread-only APIで提供する", () => {
  assert.match(worker, /path === "\/api\/admin\/v3\/ranking-exclusion\/games" && request\.method === "GET"/);
  assert.match(worker, /async function handleAdminV3RankingExclusionGamesGet[\s\S]*?requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /games\.game_date <= \?2/);
  assert.match(worker, /ranking_eligibility_status/);
  assert.match(worker, /rankingRevocationConfirmationRequired/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleAdminV3RankingExclusionGamesGet"), worker.indexOf("async function handleAdminV3RankingResetsGet")), /INSERT INTO|UPDATE |DELETE FROM/);
});

test("ランキング対象外画面に中止・公開済み・採点済みを含むゲーム選択UIがある", () => {
  assert.match(client, /rankingExclusionGames: "\/api\/admin\/v3\/ranking-exclusion\/games"/);
  assert.match(client, /listRankingExclusionGames/);
  assert.match(renderer, /data-v3-ranking-exclusion-filter/);
  assert.match(renderer, /data-v3-ranking-exclusion-search/);
  assert.match(renderer, /data-v3-ranking-exclusion-refresh/);
  assert.match(renderer, /data-v3-ranking-exclude/);
  assert.match(renderer, /中止・対象外/);
  assert.match(renderer, /公開済み・読み取り専用/);
  assert.match(renderer, /rankingRevocationConfirmationRequired/);
  assert.match(coordinator, /refreshRankingExclusionGames/);
  assert.match(state, /gamesLoading: false/);
  assert.match(state, /gameSearch: ""/);
});

test("8/22中止試合を履歴表示でき、public側へ管理操作を露出しない", () => {
  assert.match(renderer, /ランキング対象外済み/);
  assert.match(renderer, /gameStatus/);
  assert.match(page, /admin-v3-ranking-exclusion-game-picker-1/);
  assert.doesNotMatch(read("script.js"), /ranking-exclusion\/games/);
});
