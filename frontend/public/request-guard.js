(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicRequestGuard(requests) {
    function begin(name, { abort = false } = {}) {
      const request = requests[name];
      if (!request) {
        throw new Error(`Unknown public request: ${name}`);
      }
      if (abort && request.controller) {
        request.controller.abort();
      }
      request.sequence += 1;
      request.controller = abort && typeof AbortController === "function" ? new AbortController() : null;
      return { id: request.sequence, signal: request.controller?.signal };
    }

    function isCurrent(name, id) {
      return requests[name]?.sequence === id;
    }

    return { begin, isCurrent };
  }

  publicFrontend.createPublicRequestGuard = createPublicRequestGuard;
})();
