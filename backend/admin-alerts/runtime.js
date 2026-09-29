import { evaluateAdminAlertCandidates } from "./evaluator.js";
import {
  disablePushSubscription,
  listActiveIncidentsForGame,
  listActivePushSubscriptions,
  markIncidentNotified,
  resolveAlertIncident,
  upsertAlertIncident
} from "./storage.js";
import { sendWebPushSubscription } from "./push.js";

const MAX_GAMES = 8;

async function deliverIncident(db, incident, env, now, log) {
  const subscriptions = await listActivePushSubscriptions(db, { limit: 50 });
  if (!subscriptions.length) return { attempted: false, delivered: 0 };
  let attempted = 0;
  let delivered = 0;
  let firstError = null;
  for (const subscription of subscriptions) {
    try {
      const result = await sendWebPushSubscription(subscription, incident, env, { now });
      if (!result.skipped) attempted += 1;
      if (result.ok) delivered += 1;
      if (result.stale) await disablePushSubscription(db, subscription.id, result.code || "PUSH_SUBSCRIPTION_GONE", now);
      if (!result.ok && !result.skipped && !firstError) firstError = result.code || "PUSH_DELIVERY_FAILED";
    } catch (error) {
      if (!firstError) firstError = error?.code || "PUSH_DELIVERY_FAILED";
      log?.(`[ADMIN_ALERT] delivery_failed code=${error?.code || "PUSH_DELIVERY_FAILED"}`);
    }
  }
  if (attempted > 0) await markIncidentNotified(db, incident.id, { delivered, errorCode: firstError, now });
  return { attempted: attempted > 0, delivered, errorCode: firstError };
}

// Notification delivery is intentionally best-effort and isolated from formal
// automation.  A failed push can update only alert bookkeeping; it cannot
// change score, ranking, publication, or workflow state.
export async function evaluateAndNotifyAdminAlerts({ db, env, games = [], now = new Date(), getSignals, createId, log = console.warn } = {}) {
  if (!db || typeof getSignals !== "function") return { ok: false, skipped: "ALERT_INPUT_UNAVAILABLE" };
  const boundedGames = (Array.isArray(games) ? games : []).filter(Boolean).slice(0, MAX_GAMES);
  const summary = { ok: true, games: boundedGames.length, active: 0, resolved: 0, notified: 0, deliveryFailures: 0 };
  for (const game of boundedGames) {
    const gameId = String(game?.internalGameId || game?.internal_game_id || "").trim();
    if (!gameId) continue;
    try {
      const signals = await getSignals(game);
      const candidates = evaluateAdminAlertCandidates({ game, signals });
      const candidateKeys = new Set(candidates.map((alert) => alert.dedupeKey));
      const existing = await listActiveIncidentsForGame(db, gameId);
      for (const incident of existing) {
        if (!candidateKeys.has(String(incident.dedupe_key || ""))) {
          await resolveAlertIncident(db, incident.dedupe_key, now);
          summary.resolved += 1;
        }
      }
      for (const alert of candidates) {
        const stored = await upsertAlertIncident(db, alert, { now, createId });
        summary.active += 1;
        if (stored.notify) {
          const delivery = await deliverIncident(db, stored.incident, env, now, log);
          if (delivery.attempted) summary.notified += 1;
          if (delivery.errorCode) summary.deliveryFailures += 1;
        }
      }
    } catch (error) {
      log(`[ADMIN_ALERT] evaluation_failed game=${gameId} code=${error?.code || "ADMIN_ALERT_EVALUATION_FAILED"}`);
    }
  }
  return summary;
}
