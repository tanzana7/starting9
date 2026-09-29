(function registerAdminV3ApiClient(global) {
  "use strict";

  const ADMIN_V3_ENDPOINTS = Object.freeze({
    session: "/api/admin/me",
    pushStatus: "/api/admin/push/status",
    pushTest: "/api/admin/push/test",
    pushSubscribe: "/api/admin/push/subscribe",
    pushUnsubscribe: "/api/admin/push/unsubscribe",
    pushAlerts: "/api/admin/push/alerts",
    rankings: (periodType) => `/api/admin/rankings/${encodeURIComponent(periodType)}`,
    overview: "/api/admin/v3/overview",
    automationLogs: "/api/admin/v3/automation-logs",
    rankingResets: "/api/admin/v3/ranking-resets",
    rankingExclusionGames: "/api/admin/v3/ranking-exclusion/games",
    rankingResetPreview: "/api/admin/v3/ranking-resets/preview",
    rankingResetExecute: "/api/admin/v3/ranking-resets/execute",
    preBetaPurge: "/api/admin/maintenance/pre-beta-purge",
    perfectScorePreview: "/api/admin/v3/perfect-score-test/preview",
      manualGamePreview: "/api/admin/v3/schedule/add-game/preview",
      manualRoster: "/api/admin/v3/manual-roster",
      lineupCorrections: "/api/admin/v3/lineup-corrections",
      rankingTestUsers: (internalGameId) => `/api/admin/v3/games/${encodeURIComponent(internalGameId)}/ranking-test-users`,
      rankingTestToggle: (internalGameId) => `/api/admin/v3/games/${encodeURIComponent(internalGameId)}/ranking-test-users/toggle`,
      rankingTestGlobal: "/api/admin/v3/ranking-test-users/global",
      rankingTestName: "/api/admin/v3/ranking-test-users/name"
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
        error.validation = body.validation && typeof body.validation === "object" ? body.validation : null;
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
      getPushStatus: () => request(ADMIN_V3_ENDPOINTS.pushStatus),
      sendPushTest: () => post(ADMIN_V3_ENDPOINTS.pushTest, {}),
      subscribePush: (body) => post(ADMIN_V3_ENDPOINTS.pushSubscribe, body),
      unsubscribePush: (body = {}) => post(ADMIN_V3_ENDPOINTS.pushUnsubscribe, body),
      getPushAlerts: () => request(ADMIN_V3_ENDPOINTS.pushAlerts),
      getRanking(periodType, { periodKey = "", limit = 100, qualifiedOnly = false } = {}) {
        const query = new URLSearchParams({ limit: String(limit), qualifiedOnly: qualifiedOnly ? "true" : "false" });
        if (periodType === "weekly") query.set("weekStart", String(periodKey || ""));
        if (periodType === "monthly") {
          const [year, month] = String(periodKey || "").split("-");
          if (year) query.set("year", year);
          if (month) query.set("month", month);
        }
        if (periodType === "yearly" && periodKey) query.set("year", String(periodKey));
        return request(`${ADMIN_V3_ENDPOINTS.rankings(periodType)}?${query.toString()}`);
      },
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
      runJobById(internalGameId, jobId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/${encodeURIComponent(jobId)}/run`, {
          method: "POST",
          body: JSON.stringify(body)
        });
      },
      retryJob(internalGameId, jobId, body) {
        return request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/${encodeURIComponent(jobId)}/retry`, {
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
      getPreBetaPurgePlan: () => request(ADMIN_V3_ENDPOINTS.preBetaPurge),
      listLineupCorrections: () => request(ADMIN_V3_ENDPOINTS.lineupCorrections),
      getLineupCorrection: (internalGameId) => request(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-correction`),
      submitLineupCorrection: (internalGameId, body) => post(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/lineup-correction`, body),
      getRankingTestUsers: (internalGameId) => request(ADMIN_V3_ENDPOINTS.rankingTestUsers(internalGameId)),
      updateRankingTestToggle: (internalGameId, body) => request(ADMIN_V3_ENDPOINTS.rankingTestToggle(internalGameId), { method: "PUT", body: JSON.stringify(body) }),
      updateRankingTestGlobal: (body) => request(ADMIN_V3_ENDPOINTS.rankingTestGlobal, { method: "PUT", body: JSON.stringify(body) }),
      updateRankingTestName: (body) => request(ADMIN_V3_ENDPOINTS.rankingTestName, { method: "PUT", body: JSON.stringify(body) })
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.ADMIN_V3_ENDPOINTS = ADMIN_V3_ENDPOINTS;
  global.Starting9AdminV3.createAdminV3ApiClient = createAdminV3ApiClient;
})(window);
