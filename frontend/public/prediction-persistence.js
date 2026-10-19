(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicPredictionPersistence({ apiClient, targetTeam }) {
    function scopedUrl(url, gameId = "") {
      if (!targetTeam?.key || typeof window.Starting9TeamContext?.contestIdForGame !== "function") return url;
      const parsed = new URL(url, window.location?.origin || "https://starting9.internal");
      const id = String(gameId || parsed.searchParams.get("internalGameId") || "").trim();
      if (id) parsed.searchParams.set("contestId", window.Starting9TeamContext.contestIdForGame(id, targetTeam));
      return parsed.toString();
    }

    async function load(url, signal) {
      const { response, payload } = await apiClient.get(scopedUrl(url), { credentials: "include", signal });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    }

    async function save(url, gameId, prediction) {
      const { response, payload } = await apiClient.request(scopedUrl(url, gameId), {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // The canonical internalGameId and serialized lineup are the server contract.
        body: JSON.stringify({ internalGameId: gameId, ...(targetTeam?.key && window.Starting9TeamContext?.contestIdForGame
          ? { contestId: window.Starting9TeamContext.contestIdForGame(gameId, targetTeam) } : {}), prediction })
      });
      if (!response.ok || !payload?.ok) {
        const error = new Error(payload?.error || `HTTP ${response.status}`);
        error.code = payload?.code || "PREDICTION_SAVE_FAILED";
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    async function remove(url) {
      const { response, payload } = await apiClient.request(scopedUrl(url), { method: "DELETE", credentials: "include" });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    }

    return { load, save, remove };
  }

  publicFrontend.createPublicPredictionPersistence = createPublicPredictionPersistence;
})();
