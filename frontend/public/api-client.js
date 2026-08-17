(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicApiClient(fetchImpl = globalThis.fetch?.bind(globalThis)) {
    const sessionCachePrefix = "starting9:public-api:v1:";

    function readSessionCache(cacheKey, ttlMs) {
      if (!cacheKey || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
      try {
        const storage = globalThis.sessionStorage;
        const entry = JSON.parse(storage.getItem(`${sessionCachePrefix}${cacheKey}`) || "null");
        if (!entry || entry.expiresAt <= Date.now()) {
          storage.removeItem(`${sessionCachePrefix}${cacheKey}`);
          return null;
        }
        return entry;
      } catch {
        return null;
      }
    }

    function writeSessionCache(cacheKey, payload, response, ttlMs) {
      if (!cacheKey || !Number.isFinite(ttlMs) || ttlMs <= 0 || !response?.ok) return;
      try {
        globalThis.sessionStorage.setItem(`${sessionCachePrefix}${cacheKey}`, JSON.stringify({
          expiresAt: Date.now() + ttlMs,
          status: response.status,
          payload
        }));
      } catch {
        // Private browsing and quota restrictions must not affect API requests.
      }
    }

    async function request(url, options = {}) {
      const response = await fetchImpl(url, options);
      const payload = await response.json().catch(() => null);
      return { response, payload };
    }

    function get(url, options = {}) {
      return request(url, { cache: "no-store", ...options });
    }

    async function getCached(url, { cacheKey = url, ttlMs = 0, ...options } = {}) {
      const cached = readSessionCache(cacheKey, ttlMs);
      if (cached) {
        return {
          response: { ok: true, status: cached.status || 200 },
          payload: cached.payload,
          fromCache: true
        };
      }

      const result = await get(url, options);
      writeSessionCache(cacheKey, result.payload, result.response, ttlMs);
      return { ...result, fromCache: false };
    }

    function sendJson(url, method, body, options = {}) {
      return request(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        body: JSON.stringify(body),
        ...options
      });
    }

    return { request, get, getCached, sendJson };
  }

  publicFrontend.createPublicApiClient = createPublicApiClient;
})();
