import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPerfectScorePreview,
  buildReleaseDebugPerfectScoreFixturePreview,
  RELEASE_DEBUG_PERFECT_SCORE_FIXTURE_KEY,
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

test("release debug fixture stays preview-only and scores itself perfectly", () => {
  const preview = buildReleaseDebugPerfectScoreFixturePreview();
  assert.equal(preview.fixtureKey, RELEASE_DEBUG_PERFECT_SCORE_FIXTURE_KEY);
  assert.equal(preview.fixtureMode, true);
  assert.equal(preview.productionWrite, false);
  assert.equal(preview.score.total, 99);
  assert.deepEqual(preview.score.counts, { player: 9, order: 9, position: 9, perfect: 9 });
  assert.equal(preview.officialLineup.length, 9);
  assert.deepEqual(preview.officialLineup.map(({ battingOrder, position, name }) => ({ battingOrder, position, name })), [
    { battingOrder: 1, position: "2B", name: "西川" },
    { battingOrder: 2, position: "C", name: "中島" },
    { battingOrder: 3, position: "SS", name: "エドポロ" },
    { battingOrder: 4, position: "RF", name: "リン" },
    { battingOrder: 5, position: "1B", name: "山縣" },
    { battingOrder: 6, position: "3B", name: "レイエス" },
    { battingOrder: 7, position: "LF", name: "藤森" },
    { battingOrder: 8, position: "DH", name: "宮崎" },
    { battingOrder: 9, position: "CF", name: "マルティネス" }
  ]);
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
  assert.deepEqual(buildAdminReadOnlyPreviewMetadata({ fixtureMode: true, fixtureKey: "fixture" }), {
    previewOnly: true,
    fixtureMode: true,
    fixtureKey: "fixture",
    productionWrite: false,
    writes: { database: false, predictions: false, ranking: false, publication: false }
  });
});
