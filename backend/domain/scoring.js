/**
 * Scoring domain.
 *
 * This module intentionally has no Worker, D1, or request dependencies. The
 * production scorer and the admin-only perfect-score preview both consume the
 * same pure scoring function.
 */

export const SCORING_LINEUP_SIZE = 9;
export const SCORING_MAX_SCORE = 99;
export const SCORING_RULES = Object.freeze({
  player: Object.freeze({ perHit: 5, max: 45 }),
  order: Object.freeze({ perHit: 3, max: 27 }),
  position: Object.freeze({ perHit: 2, max: 18 }),
  perfect: Object.freeze({ perHit: 1, max: 9 })
});

const PREDICTION_SCHEMA_VERSION = 1;

export function scorePredictionLineup(predictionLineup, actualLineup) {
  const actualByPlayerId = new Map(actualLineup.map((item) => [item.playerId, item]));
  let playerHits = 0;
  let orderHits = 0;
  let positionHits = 0;
  let perfectHits = 0;

  for (const prediction of predictionLineup) {
    const actual = actualByPlayerId.get(prediction.playerId);
    if (!actual) continue;

    playerHits += 1;
    const isOrderHit = actual.battingOrder === prediction.battingOrder;
    const isPositionHit = actual.position === prediction.position;
    if (isOrderHit) orderHits += 1;
    if (isPositionHit) positionHits += 1;
    if (isOrderHit && isPositionHit) perfectHits += 1;
  }

  const playerScore = playerHits * SCORING_RULES.player.perHit;
  const orderScore = orderHits * SCORING_RULES.order.perHit;
  const positionScore = positionHits * SCORING_RULES.position.perHit;
  const perfectScore = perfectHits * SCORING_RULES.perfect.perHit;

  return {
    total: playerScore + orderScore + positionScore + perfectScore,
    counts: { player: playerHits, order: orderHits, position: positionHits, perfect: perfectHits }
  };
}

export function buildPerfectScorePreview(actualLineup) {
  const predictionLineup = actualLineup.map((player) => ({ ...player }));
  const score = scorePredictionLineup(predictionLineup, actualLineup);
  const breakdown = {
    player: {
      hits: score.counts.player,
      points: score.counts.player * SCORING_RULES.player.perHit,
      total: score.counts.player * SCORING_RULES.player.perHit,
      max: SCORING_RULES.player.max
    },
    order: {
      hits: score.counts.order,
      points: score.counts.order * SCORING_RULES.order.perHit,
      total: score.counts.order * SCORING_RULES.order.perHit,
      max: SCORING_RULES.order.max
    },
    position: {
      hits: score.counts.position,
      points: score.counts.position * SCORING_RULES.position.perHit,
      total: score.counts.position * SCORING_RULES.position.perHit,
      max: SCORING_RULES.position.max
    },
    perfect: {
      hits: score.counts.perfect,
      points: score.counts.perfect * SCORING_RULES.perfect.perHit,
      total: score.counts.perfect * SCORING_RULES.perfect.perHit,
      max: SCORING_RULES.perfect.max
    },
    total: score.total
  };

  return {
    prediction: { schemaVersion: PREDICTION_SCHEMA_VERSION, lineup: predictionLineup },
    score,
    breakdown
  };
}

// This fixture is intentionally available only to the admin preview caller.
// It is not a source for normal predictions, jobs, scoring, or publication.
export const RELEASE_DEBUG_PERFECT_SCORE_FIXTURE_KEY = "release_full_score_debug_1";
export const RELEASE_DEBUG_PERFECT_SCORE_FIXTURE = Object.freeze([
  Object.freeze({ battingOrder: 1, position: "2B", name: "西川", fixtureId: "debug_fixture_nishikawa" }),
  Object.freeze({ battingOrder: 2, position: "C", name: "中島", fixtureId: "debug_fixture_nakajima" }),
  Object.freeze({ battingOrder: 3, position: "SS", name: "エドポロ", fixtureId: "debug_fixture_edopolo" }),
  Object.freeze({ battingOrder: 4, position: "RF", name: "リン", fixtureId: "debug_fixture_lin" }),
  Object.freeze({ battingOrder: 5, position: "1B", name: "山縣", fixtureId: "debug_fixture_yamagata" }),
  Object.freeze({ battingOrder: 6, position: "3B", name: "レイエス", fixtureId: "debug_fixture_reyes" }),
  Object.freeze({ battingOrder: 7, position: "LF", name: "藤森", fixtureId: "debug_fixture_fujimori" }),
  Object.freeze({ battingOrder: 8, position: "DH", name: "宮崎", fixtureId: "debug_fixture_miyazaki" }),
  Object.freeze({ battingOrder: 9, position: "CF", name: "マルティネス", fixtureId: "debug_fixture_martinez" })
]);

export function buildReleaseDebugPerfectScoreFixtureLineup() {
  return RELEASE_DEBUG_PERFECT_SCORE_FIXTURE.map((player) => ({
    battingOrder: player.battingOrder,
    position: player.position,
    name: player.name,
    playerId: player.fixtureId,
    playerName: player.name,
    displayName: player.name,
    teamCode: "fighters",
    teamId: "F"
  }));
}

export function buildReleaseDebugPerfectScoreFixturePreview() {
  const officialLineup = buildReleaseDebugPerfectScoreFixtureLineup();
  return {
    fixtureKey: RELEASE_DEBUG_PERFECT_SCORE_FIXTURE_KEY,
    fixtureMode: true,
    productionWrite: false,
    officialLineup,
    ...buildPerfectScorePreview(officialLineup)
  };
}
