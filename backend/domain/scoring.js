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
