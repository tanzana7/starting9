(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicPredictionPersistence({ apiClient }) {
    async function load(url, signal) {
      const { response, payload } = await apiClient.get(url, { credentials: "include", signal });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    }

    async function save(url, gameId, prediction) {
      const { response, payload } = await apiClient.request(url, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // The canonical internalGameId and serialized lineup are the server contract.
        body: JSON.stringify({ internalGameId: gameId, prediction })
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
      const { response, payload } = await apiClient.request(url, { method: "DELETE", credentials: "include" });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    }

    return { load, save, remove };
  }

  publicFrontend.createPublicPredictionPersistence = createPublicPredictionPersistence;
})();
