import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPerfectScorePreview,
  SCORING_MAX_SCORE,
  SCORING_RULES,
  scorePredictionLineup
} from "../backend/domain/scoring.js";
import {
  calculateRankingGamesNeeded,
  selectRankingRowsForDisplay,
  toPublicRankingRow
} from "../backend/domain/ranking.js";
import {
  createPublicGameDisplayLabel,
  createPublicResultDisplayLabel,
  formatPublicResultTeamName
} from "../backend/domain/public-results.js";
import { buildAdminReadOnlyPreviewMetadata } from "../backend/admin/preview.js";

test("scoring domain uses the 99-point per-player model and is pure", () => {
  assert.equal(SCORING_MAX_SCORE, 99);
  assert.deepEqual(SCORING_RULES, {
    player: { perHit: 5, max: 45 },
    order: { perHit: 3, max: 27 },
    position: { perHit: 2, max: 18 },
    perfect: { perHit: 1, max: 9 }
  });
  const lineup = [
    { battingOrder: 1, position: "2B", playerId: "p1", name: "A" },
    { battingOrder: 2, position: "C", playerId: "p2", name: "B" }
  ];
  const actual = lineup.map((player) => ({ ...player }));
  const prediction = lineup.map((player) => ({ ...player }));
  const result = scorePredictionLineup(prediction, actual);
  assert.equal(result.total, 22);
  assert.deepEqual(result.counts, { player: 2, order: 2, position: 2, perfect: 2 });
  assert.deepEqual(prediction, lineup);
  assert.deepEqual(actual, lineup);
  assert.equal(buildPerfectScorePreview(actual).score.total, 22);
});

test("perfect bonus is awarded per slot and whole-category bonuses are not applied", () => {
  const actual = Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: index === 0 ? "C" : "2B",
    playerId: `p${index + 1}`,
    name: `選手${index + 1}`
  }));
  const prediction = actual.map((player, index) => ({
    ...player,
    position: index === 0 ? "1B" : player.position
  }));
  const result = scorePredictionLineup(prediction, actual);

  assert.deepEqual(result.counts, { player: 9, order: 9, position: 8, perfect: 8 });
  assert.equal(result.total, 96);
});

test("ranking domain keeps unqualified rows visible by default and supports a future filter", () => {
  assert.equal(calculateRankingGamesNeeded(4, 8), 4);
  const rows = [{ isQualified: true }, { isQualified: false }];
  assert.equal(selectRankingRowsForDisplay(rows).length, 2);
  assert.deepEqual(selectRankingRowsForDisplay(rows, { hideIneligibleRankings: true }), [{ isQualified: true }]);
  assert.equal(toPublicRankingRow({ games_played: 1, eligible_games: 3, is_qualified: 0 }).gamesNeeded, 3);
});

test("public results domain owns user-facing team and matchup labels", () => {
  assert.equal(formatPublicResultTeamName("fighters"), "日本ハム");
  assert.equal(createPublicGameDisplayLabel({ homeTeam: "fighters", awayTeam: "lions" }), "日本ハム vs 西武");
  assert.equal(createPublicResultDisplayLabel({ gameDate: "2026-08-11", homeTeam: "fighters", awayTeam: "lions" }), "2026-08-11 日本ハム vs 西武");
});

test("admin preview contract is explicitly read-only", () => {
  assert.deepEqual(buildAdminReadOnlyPreviewMetadata(), {
    previewOnly: true,
    productionWrite: false,
    writes: { database: false, predictions: false, ranking: false, publication: false }
  });
});
