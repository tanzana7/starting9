(function registerStarting9Edition(global) {
  "use strict";

  const TOKYO_TIME_ZONE = "Asia/Tokyo";
  const NPB = "NPB";
  const ASIA_CS = "ASIA_CS";

  function normalizeEdition(value) {
    const normalized = String(value || "").trim().toUpperCase().replace(/[-\s]/g, "_");
    return normalized === ASIA_CS || normalized === "ASIA" ? ASIA_CS : normalized === NPB ? NPB : "";
  }

  function parseDate(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function resolveDefaultEdition(now = new Date(), windowConfig = {}) {
    const activeFrom = parseDate(windowConfig.activeFrom);
    const activeUntil = parseDate(windowConfig.activeUntil);
    const instant = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(instant.getTime()) || !activeFrom || !activeUntil || activeUntil <= activeFrom) return NPB;
    return instant >= activeFrom && instant < activeUntil ? ASIA_CS : NPB;
  }

  function readWindow() {
    const configured = global.STARTING9_EDITION_WINDOW;
    if (!configured || typeof configured !== "object") {
      return { activeFrom: "", activeUntil: "", timeZone: TOKYO_TIME_ZONE, endExclusive: true };
    }
    return {
      activeFrom: String(configured.activeFrom || "").trim(),
      activeUntil: String(configured.activeUntil || "").trim(),
      timeZone: TOKYO_TIME_ZONE,
      endExclusive: true
    };
  }

  function explicitEdition(location = global.location) {
    const value = new URL(location?.href || "https://starting9.invalid/").searchParams.get("edition");
    return normalizeEdition(value);
  }

  function resolveSelectedEdition(location = global.location, now = new Date()) {
    return explicitEdition(location) || resolveDefaultEdition(now, readWindow());
  }

  global.Starting9Edition = Object.freeze({
    NPB,
    ASIA_CS,
    TOKYO_TIME_ZONE,
    normalizeEdition,
    resolveDefaultEdition,
    readWindow,
    explicitEdition,
    resolveSelectedEdition
  });
})(window);
