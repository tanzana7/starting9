import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateLineupShadowAccuracy,
  buildLineupShadowAccuracyRecord,
  buildLineupShadowAccuracyReport,
  selectShadowRevisionForComparison
} from "../backend/automation-v3/lineup-shadow-observability.js";
import { compareShadowLineupToManual } from "../backend/automation-v3/lineup-shadow-service.js";

const START = "2026-09-29T09:00:00.000Z";
const MANUAL_AT = "2026-09-29T08:31:00.000Z";
const BASE_LINEUP = Array.from({ length: 9 }, (_, index) => ({
  battingOrder: index + 1,
  playerId: `F-${index + 1}`,
  playerName: `選手${index + 1}`,
  position: index === 8 ? "DH" : "遊"
}));

function shadowRow(lineup = BASE_LINEUP, {
  version = 1,
  capturedAt = "2026-09-29T08:15:00.000Z",
  status = "verified",
  source = "official"
} = {}) {
  return {
    revision_id: `game-1:${version}`,
    version,
    actual_lineup_json: JSON.stringify(lineup),
    lineup_fingerprint: `fingerprint-${version}`,
    source: "npb-auto",
    captured_at: capturedAt,
    created_at: capturedAt,
    is_final: 0,
    validation_json: JSON.stringify({
      shadowMode: true,
      lifecycleStatus: status,
      source,
      fetchedAt: capturedAt,
      validation: { ok: status === "verified", status, playerCount: lineup.length }
    })
  };
}

function manualRow(lineup = BASE_LINEUP, finalizedAt = MANUAL_AT) {
  return {
    revision_id: "game-1:9",
    version: 9,
    actual_lineup_json: JSON.stringify(lineup),
    source: "manual-revision",
    created_at: finalizedAt,
    finalized_at: finalizedAt,
    is_final: 1
  };
}

function record(revisions, { gameStatus = "scheduled", logs = [] } = {}) {
  return buildLineupShadowAccuracyRecord({
    game: {
      internalGameId: "game-1",
      gameDate: "2026-09-29",
      startAt: START,
      homeTeam: "F",
      awayTeam: "B",
      npbGameCode: "m-f-25",
      gameStatus
    },
    revisions,
    logs
  });
}

function createDashboardRenderer() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const context = vm.createContext({ window: {}, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8"), context);
  return context.window.Starting9AdminV3.createAdminV3GameProgressRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    renderSummaryCard: (label, value) => `<div>${label}:${value}</div>`,
    renderTodayOps: () => "",
    gameDateForFilter: (game) => game.gameDate,
    filterGames: () => [],
    listItems: (value) => Array.isArray(value) ? value : [],
    gameHasAttention: () => false,
    nextActionText: () => "-",
    jstDate: () => "2026-09-30",
    identityStatusLabel: () => "解決済み"
  });
}

test("exact lineup compares by player, batting order, and canonical position", () => {
  const comparison = compareShadowLineupToManual(BASE_LINEUP, BASE_LINEUP.map((row) => ({ ...row, position: row.position === "DH" ? "指名打者" : row.position })));
  assert.equal(comparison.exactMatch, true);
  assert.equal(comparison.playerMatch, true);
  assert.equal(comparison.battingOrderMatch, true);
  assert.equal(comparison.positionMatch, true);
  assert.equal(comparison.differenceCount, 0);
});

test("same players in another order separates player and batting-order matches", () => {
  const swapped = BASE_LINEUP.map((row) => ({ ...row }));
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  swapped[1].battingOrder = 2;
  swapped[2].battingOrder = 3;
  const comparison = compareShadowLineupToManual(swapped, BASE_LINEUP);
  assert.equal(comparison.exactMatch, false);
  assert.equal(comparison.playerMatch, true);
  assert.equal(comparison.battingOrderMatch, false);
});

test("position aliases do not create a false mismatch, while a real position change does", () => {
  const equivalent = BASE_LINEUP.map((row) => ({ ...row, position: row.position === "遊" ? "SS" : row.position }));
  assert.equal(compareShadowLineupToManual(equivalent, BASE_LINEUP).positionMatch, true);
  const changed = BASE_LINEUP.map((row) => ({ ...row }));
  changed[0].position = "一";
  const comparison = compareShadowLineupToManual(changed, BASE_LINEUP);
  assert.equal(comparison.playerMatch, true);
  assert.equal(comparison.battingOrderMatch, true);
  assert.equal(comparison.positionMatch, false);
});

test("player identity mismatch is independent of display names", () => {
  const changed = BASE_LINEUP.map((row) => ({ ...row }));
  changed[0].playerId = "F-99";
  changed[0].playerName = BASE_LINEUP[0].playerName;
  const comparison = compareShadowLineupToManual(changed, BASE_LINEUP);
  assert.equal(comparison.playerMatch, false);
  assert.equal(comparison.exactMatch, false);
});

test("missing manual remains pending and is not comparable", () => {
  const result = record([shadowRow()]);
  assert.equal(result.status, "pending");
  assert.equal(result.verified, true);
  assert.equal(result.comparison, null);
});

test("a game with no shadow attempt and no manual final remains unobserved", () => {
  const result = record([]);
  assert.equal(result.status, "unobserved");
  assert.equal(aggregateLineupShadowAccuracy([result]).eligibleGames, 0);
  assert.equal(aggregateLineupShadowAccuracy([result]).unobserved, 1);
});

test("manual final without a shadow candidate is missing", () => {
  const result = record([manualRow()]);
  assert.equal(result.status, "missing");
  assert.equal(result.fetched, false);
});

test("latest verified shadow before manual final is selected", () => {
  const older = shadowRow(BASE_LINEUP, { version: 1, capturedAt: "2026-09-29T08:00:00.000Z" });
  const newer = shadowRow(BASE_LINEUP, { version: 2, capturedAt: "2026-09-29T08:20:00.000Z" });
  const selected = selectShadowRevisionForComparison([older, newer], manualRow());
  assert.equal(selected.row.version, 2);
});

test("shadow captured after manual final is excluded from comparison", () => {
  const result = record([manualRow(), shadowRow(BASE_LINEUP, { capturedAt: "2026-09-29T08:45:00.000Z" })]);
  assert.equal(result.status, "excluded");
  assert.equal(result.exclusionReason, "shadow_after_manual_final");
  assert.equal(result.comparison, null);
});

test("waiting followed by verified uses the verified candidate", () => {
  const result = record([
    shadowRow([], { version: 1, capturedAt: "2026-09-29T08:05:00.000Z", status: "not_published" }),
    shadowRow(BASE_LINEUP, { version: 2, capturedAt: "2026-09-29T08:20:00.000Z" }),
    manualRow()
  ], { logs: [{ status: "info", occurred_at: "2026-09-29T08:05:00.000Z", metadata: JSON.stringify({ status: "waiting" }) }] });
  assert.equal(result.status, "matched");
  assert.equal(result.shadowRevisionVersion, 2);
  assert.equal(result.timing.timeToVerifiedMs, 15 * 60 * 1000);
});

test("cancelled and no_game are excluded from the denominator", () => {
  assert.equal(record([manualRow()], { gameStatus: "cancelled" }).status, "excluded");
  assert.equal(record([manualRow()], { gameStatus: "no_game" }).exclusionReason, "no_game");
});

test("aggregate exposes bounded metrics and null rates for zero denominators", () => {
  const exact = record([shadowRow(), manualRow()]);
  const mismatchLineup = BASE_LINEUP.map((row) => ({ ...row }));
  mismatchLineup[0].playerId = "F-99";
  const mismatch = record([shadowRow(mismatchLineup), manualRow()]);
  const missing = record([manualRow()], { gameStatus: "scheduled" });
  const excluded = record([manualRow()], { gameStatus: "cancelled" });
  const metrics = aggregateLineupShadowAccuracy([exact, mismatch, missing, excluded]);
  assert.equal(metrics.totalGames, 4);
  assert.equal(metrics.eligibleGames, 3);
  assert.equal(metrics.attempted, 2);
  assert.equal(metrics.verified, 2);
  assert.equal(metrics.comparable, 2);
  assert.equal(metrics.exactMatches, 1);
  assert.equal(metrics.mismatched, 1);
  assert.equal(metrics.missing, 1);
  assert.equal(metrics.excluded, 1);
  assert.equal(metrics.rates.exactMatch, 0.5);
  assert.equal(aggregateLineupShadowAccuracy([]).rates.exactMatch, null);
});

test("report remains bounded even if a caller supplies a larger history", () => {
  const records = Array.from({ length: 30 }, () => record([manualRow()]));
  const report = buildLineupShadowAccuracyReport(records, { limit: 100 });
  assert.equal(report.historyLimit, 20);
  assert.equal(report.metrics.totalGames, 20);
});

test("admin dashboard renders no-data and each observation status without exposing it publicly", () => {
  const renderer = createDashboardRenderer();
  const noData = renderer.renderDashboard({ games: [], lineupShadowAccuracy: buildLineupShadowAccuracyReport([]) }, []);
  assert.match(noData, /Shadow実績/);
  assert.match(noData, /まだ観測データなし/);
  const report = buildLineupShadowAccuracyReport([
    { gameDate: "2026-09-29", homeTeam: "F", awayTeam: "B", status: "matched", differenceCount: 0 },
    { gameDate: "2026-09-28", homeTeam: "F", awayTeam: "B", status: "mismatched", differenceCount: 1 },
    { gameDate: "2026-09-27", homeTeam: "F", awayTeam: "B", status: "pending", differenceCount: 0 },
    { gameDate: "2026-09-26", homeTeam: "F", awayTeam: "B", status: "excluded", exclusionReason: "cancelled", differenceCount: 0 }
  ]);
  const html = renderer.renderDashboard({ games: [], lineupShadowAccuracy: report }, []);
  assert.match(html, /✓ 完全一致/);
  assert.match(html, /⚠ 差分 1件/);
  assert.match(html, /保留/);
  assert.match(html, /除外（cancelled）/);
});
