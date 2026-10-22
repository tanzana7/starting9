// Keep the runner aligned with the Test Worker’s security outcomes. A retained
// user, a deleted user, an absent user, and a replay-blocking tombstone are
// distinct structured results; unknown or contradictory payloads are failures.
export function classifyE2ECleanupResult(payload, now = Date.now()) {
  if (!payload || payload.ok !== true) return null;
  const outcomes = [
    payload.removed === true,
    payload.retainedAsUser === true,
    typeof payload.replayMarkerRetainedUntil === "string",
    payload.alreadyAbsent === true
  ].filter(Boolean).length;
  if (outcomes !== 1) return null;
  if (payload.removed === true) return payload.retainedAsUser !== true ? "deleted" : null;
  if (payload.retainedAsUser === true) return payload.removed === false ? "retained-user" : null;
  if (typeof payload.replayMarkerRetainedUntil === "string") {
    const expiresAt = Date.parse(payload.replayMarkerRetainedUntil);
    return payload.removed === false && Number.isFinite(expiresAt) && expiresAt > now
      ? "replay-blocked" : null;
  }
  return payload.alreadyAbsent === true && payload.removed === false ? "already-absent" : null;
}
