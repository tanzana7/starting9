(function registerAdminV3ApiClient(global) {
  "use strict";

  const ADMIN_V3_ENDPOINTS = Object.freeze({
    session: "/api/admin/me",
    overview: "/api/admin/v3/overview",
    automationLogs: "/api/admin/v3/automation-logs",
    rankingResets: "/api/admin/v3/ranking-resets",
    rankingExclusionGames: "/api/admin/v3/ranking-exclusion/games",
    rankingResetPreview: "/api/admin/v3/ranking-resets/preview",
    rankingResetExecute: "/api/admin/v3/ranking-resets/execute",
    perfectScorePreview: "/api/admin/v3/perfect-score-test/preview",
    manualGamePreview: "/api/admin/v3/schedule/add-game/preview",
    manualRoster: "/api/admin/v3/manual-roster",
    lineupCorrections: "/api/admin/v3/lineup-corrections"
  });

  function createAdminV3ApiClient({ fetchImpl, location, productionBase }) {
    function apiBase() {
      if (["localhost", "127.0.0.1"].includes(location.hostname)) {
        return "http://127.0.0.1:8787";
      }
      if (productionBase) {
        return productionBase.replace(/\/+$/, "");
      }
      return location.origin || `${location.protocol || "https:"}//${location.host || location.hostname}`;
    }

    async function request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
      let response;
      try {
        response = await fetchImpl(`${apiBase()}${path}`, {
          ...options,
          method: options.method || "GET",
          credentials: "include",
          headers
        });
      } catch (cause) {
        const error = new Error("管理APIへ接続できません。通信状況を確認して再試行してください。");
        error.code = "NETWORK_ERROR";
        error.status = 0;
        error.cause = cause;
        throw error;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || `HTTP ${response.status}`);
        error.code = body.code || "V3_ADMIN_REQUEST_FAILED";
        error.status = response.status;
        error.details = body.resolutionDiagnostics || body.diagnostics || null;
        error.identityState = body.identityState || null;
        throw error;
      }
      return body;
    }

    function post(path, body) {
      return request(path, { method: "POST", body: JSON.stringify(body) });
    }

    return Object.freeze({
      request,
      getSession: () => request(ADMIN_V3_ENDPOINTS.session),
      getOverview: () => request(ADMIN_V3_ENDPOINTS.overview),
      getAutomationLogs(filters = {}) {
        const query = new URLSearchParams({ ...filters, limit: String(filters.limit || 100) });
        return request(`${ADMIN_V3_ENDPOINTS.automationLogs}?${query.toString()}`);
      },
      getJobDetail(internalGameId, jobId) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/${encodeURIComponent(jobId)}`);
      },
      getGameOperationDetail(internalGameId, suffix) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}${suffix}`);
      },
      saveManualLineup(internalGameId, body) {
        return post(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-revisions`, body);
      },
      finalizeManualLineup(internalGameId, body) {
        return post(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-finalize`, body);
      },
      cancelManualLineupRevision(internalGameId, revisionId, body = {}) {
        return post(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-revisions/${encodeURIComponent(revisionId)}/cancel`, body);
      },
      getManualRoster(teamCode = "fighters") {
        return request(`${ADMIN_V3_ENDPOINTS.manualRoster}?teamCode=${encodeURIComponent(teamCode)}`);
      },
      saveManualRoster(body) {
        return request(ADMIN_V3_ENDPOINTS.manualRoster, { method: "PUT", body: JSON.stringify(body) });
      },
      diagnoseJob(internalGameId, jobType) {
        const query = new URLSearchParams({ jobType: String(jobType || "") });
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/diagnose?${query.toString()}`);
      },
      runJob(internalGameId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/run`, {
          method: "POST",
          body: JSON.stringify(body)
        });
      },
      reconcileState(internalGameId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/reconcile-state`, {
          method: "POST",
          body: JSON.stringify(body)
        });
      },
      updateSchedule(internalGameId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/schedule`, {
          method: "PUT",
          body: JSON.stringify(body)
        });
      },
      updateRankingEligibility(internalGameId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/ranking-eligibility`, {
          method: "PUT",
          body: JSON.stringify(body)
        });
      },
      listRankingResets: () => request(ADMIN_V3_ENDPOINTS.rankingResets),
      listRankingExclusionGames(filters = {}) {
        const query = new URLSearchParams({
          scope: filters.scope || "past",
          search: filters.search || "",
          limit: String(filters.limit || 30)
        });
        return request(`${ADMIN_V3_ENDPOINTS.rankingExclusionGames}?${query.toString()}`);
      },
      previewRankingReset: (body) => post(ADMIN_V3_ENDPOINTS.rankingResetPreview, body),
      executeRankingReset: (body) => post(ADMIN_V3_ENDPOINTS.rankingResetExecute, body),
      previewPerfectScore: (body) => post(ADMIN_V3_ENDPOINTS.perfectScorePreview, body),
      previewManualGame: (body) => post(ADMIN_V3_ENDPOINTS.manualGamePreview, body),
      listLineupCorrections: () => request(ADMIN_V3_ENDPOINTS.lineupCorrections),
      getLineupCorrection: (internalGameId) => request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-correction`),
      submitLineupCorrection: (internalGameId, body) => post(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-correction`, body)
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.ADMIN_V3_ENDPOINTS = ADMIN_V3_ENDPOINTS;
  global.Starting9AdminV3.createAdminV3ApiClient = createAdminV3ApiClient;
})(window);
