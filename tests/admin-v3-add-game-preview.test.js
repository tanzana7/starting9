import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildManualGamePreview, normalizeManualGamePreviewInput } from "../backend/admin/manual-game-preview.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const adminPage = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const adminScript = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-game-preview.js"), "utf8");
const publicPage = fs.readFileSync(path.join(root, "index.html"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

const validInput = Object.freeze({
  gameDate: "2026-09-01",
  startAt: "2026-09-01T18:00",
  homeTeam: "fighters",
  awayTeam: "hawks",
  venue: "エスコンフィールド",
  npbGameCode: null,
  rankingEligible: true,
  reason: "雨天中止分の振替試合登録プレビュー",
  confirmPreview: true
});

function createReadOnlyDb({ games = [], identifiers = [], detectedSchedules = [], tables = null } = {}) {
  const writes = [];
  const tableList = tables || [
    "games", "game_identifiers", "detected_game_schedule", "game_automation_v3_state",
    "game_jobs_v3", "game_automation_v3_audit"
  ];
  const columns = {
    games: ["internal_game_id", "game_date", "start_time", "home_team", "away_team", "game_status", "npb_game_code"],
    detected_game_schedule: ["game_id", "internal_game_id", "game_date", "start_at", "home_team", "away_team"]
  };
  return {
    writes,
    prepare(sql) {
      const query = String(sql);
      const allForQuery = (bound = []) => {
        if (query.includes("sqlite_master")) return { results: tableList.map((name) => ({ name })) };
        if (query.startsWith("PRAGMA table_info")) {
          const table = query.match(/table_info\(([^)]+)\)/)?.[1];
          return { results: (columns[table] || []).map((name) => ({ name })) };
        }
        if (query.includes("FROM games")) return { results: games.filter((row) => row.game_date === bound[0]) };
        if (query.includes("FROM game_identifiers")) return { results: identifiers };
        if (query.includes("FROM detected_game_schedule")) return { results: detectedSchedules.filter((row) => row.game_date === bound[0]) };
        return { results: [] };
      };
      const operation = {
        bind(...values) {
          const bound = values;
          return {
            async all() { return allForQuery(bound); },
            async first() { return null; },
            async run() { writes.push(query); return { success: true }; }
          };
        },
        async all() { return allForQuery(); },
        async first() { return null; },
        async run() { writes.push(query); return { success: true }; }
      };
      return operation;
    }
  };
}

test("preview APIの未認証リクエストは401で、read-only routeとして保護される", async () => {
  const response = await worker.fetch(new Request("https://starting9.test/api/admin/v3/schedule/add-game/preview", { method: "POST" }), { AUTH_DB: {} }, {});
  assert.equal(response.status, 401);
  assert.match(workerSource, /async function handleAdminV3ManualGamePreview[\s\S]*?requireAdminUser\(request, env, cors\)/);
});

test("preview入力は必須項目・team・日時・確認を検証する", () => {
  const cases = [
    ["reasonなし", { ...validInput, reason: "" }],
    ["confirmなし", { ...validInput, confirmPreview: false }],
    ["必須日付なし", { ...validInput, gameDate: "" }],
    ["同一team", { ...validInput, awayTeam: "fighters" }],
    ["不正team", { ...validInput, homeTeam: "unknown" }],
    ["不正日時", { ...validInput, startAt: "not-a-date" }],
    ["日付不一致", { ...validInput, startAt: "2026-09-02T18:00" }],
    ["rankingEligible不正", { ...validInput, rankingEligible: "true" }]
  ];
  for (const [label, input] of cases) assert.throws(() => normalizeManualGamePreviewInput(input), label);
});

test("npbGameCode nullでもdeterministicなread-only previewを返す", async () => {
  const db = createReadOnlyDb();
  const first = await buildManualGamePreview(db, validInput);
  const second = await buildManualGamePreview(db, validInput);
  assert.equal(first.ok, true);
  assert.equal(first.mode, "preview_only");
  assert.equal(first.willWrite, false);
  assert.equal(first.normalizedInput.npbGameCode, null);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.idempotencyKey, /2026-09-01T09:00:00\.000Z/);
  assert.equal(first.registrationReadiness.canRegisterWithCurrentSchema, false);
  assert.ok(Array.isArray(first.expectedPlan.expectedInitialJobs));
  assert.equal(db.writes.length, 0);
});

test("gamesのexact/same-card/reverse候補とNPB code重複を区別する", async () => {
  const db = createReadOnlyDb({
    games: [
      { internal_game_id: "exact", game_date: "2026-09-01", start_time: "2026-09-01T09:00:00.000Z", home_team: "fighters", away_team: "hawks", game_status: "scheduled", npb_game_code: "f-h-18" },
      { internal_game_id: "same-card", game_date: "2026-09-01", start_time: "2026-09-01T12:00:00.000Z", home_team: "fighters", away_team: "hawks", game_status: "scheduled", npb_game_code: null },
      { internal_game_id: "reverse", game_date: "2026-09-01", start_time: "2026-09-01T10:00:00.000Z", home_team: "hawks", away_team: "fighters", game_status: "scheduled", npb_game_code: null }
    ],
    identifiers: [{ internal_game_id: "code-match", provider: "npb", identifier_type: "game_code", identifier_value: "f-h-18" }]
  });
  const result = await buildManualGamePreview(db, { ...validInput, npbGameCode: "F-H-18" });
  const types = result.duplicateCheck.matches.map((match) => match.matchType);
  assert.equal(result.duplicateCheck.hasBlockingDuplicate, true);
  assert.ok(types.includes("exact_duplicate"));
  assert.ok(types.includes("same_card_same_day"));
  assert.ok(types.includes("reverse_home_away_same_day"));
  assert.ok(types.includes("same_npb_game_code"));
  assert.ok(result.duplicateCheck.warnings.some((warning) => warning.code === "SAME_CARD_SAME_DAY"));
  assert.ok(result.duplicateCheck.warnings.some((warning) => warning.code === "REVERSE_HOME_AWAY_SAME_DAY"));
  assert.equal(db.writes.length, 0);
});

test("detected_game_scheduleが利用できない場合も状態を明示してpreviewを継続する", async () => {
  const db = createReadOnlyDb({ tables: ["games"], games: [] });
  const result = await buildManualGamePreview(db, validInput);
  assert.equal(result.duplicateCheck.detectedScheduleCheck.status, "not_available");
  assert.equal(result.willWrite, false);
});

test("admin-v3にpreview panelはあるが、本登録commit導線はない", () => {
  assert.match(adminPage, /data-v3-view="add-game-preview"/);
  assert.match(adminPage, /render-manual-game-preview\.js\?v=v4-canonical-status-1/);
  assert.match(adminScript, /previewManualGame/);
  assert.match(renderer, /この操作は書き込みを行いません/);
  assert.match(renderer, /本登録は未実装です/);
  assert.doesNotMatch(renderer, /commitManualGame|data-v3-manual-game-commit/);
  assert.doesNotMatch(publicPage, /add-game-preview|manualGamePreview/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "backend", "admin", "manual-game-preview.js"), "utf8"), /\.run\(/);
});
