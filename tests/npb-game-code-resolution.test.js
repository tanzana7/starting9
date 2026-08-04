import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const workerSource = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
const npbWorkerSource = await readFile(new URL("../cloudflare-worker.js", import.meta.url), "utf8");

const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
const base = {
  internalGameId,
  gameRow: {
    internal_game_id: internalGameId,
    game_date: "2026-08-04",
    start_time: "2026-08-04T09:00:00.000Z",
    home_team: "福岡ソフトバンクホークス",
    away_team: "北海道日本ハムファイターズ",
    game_status: "completed"
  },
  scheduleRows: [{
    game_id: "2026-08-04-h-f-15",
    source_game_key: "2026-08-04:hawks:fighters:18:00",
    game_date: "2026-08-04",
    start_at: "2026-08-04T09:00:00.000Z",
    home_team: "hawks",
    away_team: "fighters",
    game_code: "h-f-15",
    game_status: "completed"
  }],
  identifiers: [{
    internal_game_id: internalGameId,
    provider: "schedule_worker",
    identifier_type: "source_game_key",
    identifier_value: "2026-08-04:hawks:fighters:18:00"
  }]
};

test("8/4 fixtureはdetected scheduleのh-f-15を解決し、正規化後もhome/awayを維持する", async () => {
  const { validateWorkflowJobTarget } = await import(new URL("../auth-worker.js", import.meta.url));
  const result = validateWorkflowJobTarget(base);

  assert.equal(result.valid, true);
  assert.equal(result.target.gameCode, "h-f-15");
  assert.equal(result.target.homeTeam, "hawks");
  assert.equal(result.target.awayTeam, "fighters");
  assert.equal(result.target.targetResolution.detectedScheduleGameCode, "h-f-15");
  assert.deepEqual(result.target.targetResolution.teamNormalizationInput, {
    home: "福岡ソフトバンクホークス",
    away: "北海道日本ハムファイターズ"
  });
  assert.deepEqual(result.target.targetResolution.teamNormalizationOutput, {
    home: "hawks",
    away: "fighters"
  });
});

test("NPBコード候補はgames、identifier、schedule、metadata、staticの順で監査できる", async () => {
  const { getNpbGameCodeCandidate } = await import(new URL("../auth-worker.js", import.meta.url));
  const result = getNpbGameCodeCandidate({
    gameRow: { npb_game_code: "h-f-15" },
    identifiers: base.identifiers,
    scheduleRows: base.scheduleRows,
    sourceMetadata: { gameCode: "h-f-15" },
    staticGameCode: "h-f-15"
  });

  assert.equal(result.gameCode, "h-f-15");
  assert.equal(result.resolvedBy, "games.npb_game_code");
  assert.equal(result.detectedScheduleGameCode, "h-f-15");
  assert.equal(result.npbIdentifierRows.length, 0);
  assert.ok(result.candidates.some((candidate) => candidate.resolvedBy === "detected_game_schedule"));
});

test("異なる永続NPBコードはconflictとして停止し、コードなしだけ空結果になる", async () => {
  const { getNpbGameCodeCandidate } = await import(new URL("../auth-worker.js", import.meta.url));
  const conflict = getNpbGameCodeCandidate({
    gameRow: { npb_game_code: "h-f-15" },
    identifiers: [{ provider: "npb", identifier_type: "npb_game_code", identifier_value: "h-f-16" }],
    scheduleRows: []
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.conflictReason, "multiple_npb_game_code_candidates");
  assert.equal(conflict.gameCode, "");

  const unavailable = getNpbGameCodeCandidate({
    gameRow: {},
    identifiers: [],
    scheduleRows: [],
    staticGameCode: ""
  });
  assert.equal(unavailable.conflict, false);
  assert.equal(unavailable.gameCode, "");
});

test("schedule同期は取得したgameCodeをregistry identifierへ渡し、registry再構築後もfallback.gameCodeを保持する", () => {
  assert.match(workerSource, /createScheduleGameIdentifiers\(\{[\s\S]*?gameCode: game\.gameCode/);
  assert.match(workerSource, /gameCode: metadata\.gameCode \|\| fallback\.gameCode/);
  assert.match(workerSource, /WHERE game_id IN \(\$\{gamePlaceholders\}\) OR source_game_key IN \(\$\{sourcePlaceholders\}\)/);
  assert.match(workerSource, /const resolved = await resolveWorkflowJobTarget\(db, target\.internalGameId\)/);
});

test("final lineupは解決済みNPBコードをURL生成経路へ渡す", () => {
  assert.match(workerSource, /fetchNpbWorkerJson\(env, \{ mode: "lineup", date: identity\.game\.date, gameCode: identity\.gameCode \}\)/);
  assert.match(npbWorkerSource, /url: `https:\/\/npb\.jp\/scores\/\$\{year\}\/\$\{month\}\$\{day\}\/\$\{normalizedGameCode\}\/`/);
});
