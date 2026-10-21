export const FORMAL_JOB_LEASE_RETRY_DELAY_MS = 5 * 60 * 1000 + 1_000;

const FORMAL_STATE_ORDER = ["scheduled", "prediction_closed", "lineup_ready", "scored", "ranked", "published"];

export function hasReachedFormalState(game, expectedState) {
  const actualIndex = FORMAL_STATE_ORDER.indexOf(String(game?.state || ""));
  const expectedIndex = FORMAL_STATE_ORDER.indexOf(String(expectedState || ""));
  if (actualIndex < 0 || expectedIndex < 0 || actualIndex < expectedIndex) return false;
  return expectedState !== "published" || game?.publication_status === "published";
}

export async function fetchReadWith503Retry(fetchRequest, {
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxRetries = 2
} = {}) {
  for (let retry = 0; ; retry += 1) {
    const response = await fetchRequest();
    if (response.status !== 503 || retry >= maxRetries) return response;
    await wait(1_000);
  }
}

export async function invokeFormalStageWithLeaseRetry({
  invoke,
  readGame,
  expectedState,
  isComplete = (game) => hasReachedFormalState(game, expectedState),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxRetries = 2
}) {
  for (let retry = 0; ; retry += 1) {
    try {
      return await invoke();
    } catch (error) {
      if (error?.status !== 503 || retry >= maxRetries) throw error;

      // A Cloudflare CPU-limit termination can interrupt a request after the
      // formal executor has claimed its job. Re-read canonical state first; if
      // still incomplete, wait past the repository's five-minute claim lease
      // so the next invocation can reclaim that same job instead of hot-looping.
      const observedGame = await readGame().catch(() => null);
      if (isComplete(observedGame)) {
        return { payload: { game: observedGame }, recoveredAfterWorkerLimit: true };
      }
      await wait(FORMAL_JOB_LEASE_RETRY_DELAY_MS);
    }
  }
}
