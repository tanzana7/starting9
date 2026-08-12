(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicApiClient(fetchImpl = globalThis.fetch?.bind(globalThis)) {
    async function request(url, options = {}) {
      const response = await fetchImpl(url, options);
      const payload = await response.json().catch(() => null);
      return { response, payload };
    }

    function get(url, options = {}) {
      return request(url, { cache: "no-store", ...options });
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

    return { request, get, sendJson };
  }

  publicFrontend.createPublicApiClient = createPublicApiClient;
})();
