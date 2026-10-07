(() => {
  "use strict";

  const BEACON_SOURCE = "https://static.cloudflareinsights.com/beacon.min.js";
  const SITE_TOKEN = "c5dd7fb63b4b4f88a00de4bfa90ba267";
  const PUBLIC_HOSTS = new Set(["starting9.pages.dev", "starting9-app.pages.dev"]);
  const PUBLIC_PATHS = new Set([
    "/",
    "/index.html",
    "/how-to-play.html",
    "/terms.html",
    "/privacy.html",
    "/contact.html"
  ]);

  function normalizePath(pathname) {
    const value = String(pathname || "/");
    if (value === "/") return "/";
    return `/${value.replace(/^\/+|\/+$/g, "")}`;
  }

  function isAllowedPublicLocation(locationLike) {
    const hostname = String(locationLike?.hostname || "").toLowerCase();
    const pathname = normalizePath(locationLike?.pathname);
    const protocol = String(locationLike?.protocol || "").toLowerCase();
    const search = String(locationLike?.search || "");
    const hash = String(locationLike?.hash || "");
    return PUBLIC_HOSTS.has(hostname)
      && (!protocol || protocol === "https:")
      && PUBLIC_PATHS.has(pathname)
      && !search
      && !hash;
  }

  function hasBeaconScript() {
    if (typeof document === "undefined") return false;
    return Boolean(
      document.querySelector("script[data-starting9-cf-analytics]")
      || document.querySelector(`script[src^="${BEACON_SOURCE}"]`)
      || document.querySelector("script[data-cf-beacon]")
    );
  }

  function loadCloudflareBeacon() {
    if (typeof document === "undefined" || !document.head || !isAllowedPublicLocation(window.location) || hasBeaconScript()) return false;

    const script = document.createElement("script");
    script.type = "module";
    script.src = BEACON_SOURCE;
    script.setAttribute("data-cf-beacon", JSON.stringify({ token: SITE_TOKEN }));
    script.setAttribute("data-starting9-cf-analytics", "true");
    document.head.appendChild(script);
    return true;
  }

  function initialize() {
    loadCloudflareBeacon();
  }

  const api = { isAllowedPublicLocation, loadCloudflareBeacon };
  if (typeof window !== "undefined") {
    window.Starting9Analytics = api;
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
      else initialize();
    }
  }
})();
