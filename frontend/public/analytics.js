(() => {
  "use strict";

  const MEASUREMENT_ID = "G-169GEEXKQJ";
  const CONSENT_STORAGE_KEY = "starting9.analytics-consent";
  const PUBLIC_HOST = "starting9.pages.dev";
  const BLOCKED_PATH_PATTERN = /^\/(?:admin-v3(?:\.html)?(?:\/|$)|auth(?:\.html)?(?:\/|$)|login(?:\.html)?(?:\/|$)|register(?:\.html)?(?:\/|$)|tests?(?:\.html)?(?:\/|$))/i;

  let pageViewSent = false;
  let analyticsLoaded = false;

  function normalizePath(pathname) {
    const value = String(pathname || "/");
    if (!value || value === "/") return "/";
    return `/${value.replace(/^\/+|\/+$/g, "")}`;
  }

  function isAllowedPublicLocation(locationLike) {
    const hostname = String(locationLike?.hostname || "").toLowerCase();
    const pathname = normalizePath(locationLike?.pathname);
    return hostname === PUBLIC_HOST && !BLOCKED_PATH_PATTERN.test(pathname);
  }

  function sanitizePageLocation(locationLike) {
    if (!isAllowedPublicLocation(locationLike)) return "";
    const origin = String(locationLike?.origin || `https://${PUBLIC_HOST}`).replace(/\/+$/, "");
    return `${origin}${normalizePath(locationLike?.pathname)}`;
  }

  function sanitizeReferrer(referrer) {
    try {
      const value = new URL(String(referrer || ""));
      return `${value.origin}${normalizePath(value.pathname)}`;
    } catch {
      return "";
    }
  }

  function getConsent() {
    try {
      return window.localStorage?.getItem(CONSENT_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function setConsent(value) {
    try {
      window.localStorage?.setItem(CONSENT_STORAGE_KEY, value);
    } catch {
      // Private browsing or blocked storage must not prevent page use.
    }
  }

  function updateGoogleConsent(value) {
    if (typeof window.gtag !== "function") return;
    window.gtag("consent", "update", {
      analytics_storage: value === "granted" ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }

  function sendPageView() {
    if (pageViewSent || typeof window.gtag !== "function") return;
    const pageLocation = sanitizePageLocation(window.location);
    if (!pageLocation) return;
    window.gtag("event", "page_view", {
      page_location: pageLocation,
      page_path: normalizePath(window.location.pathname),
      page_referrer: sanitizeReferrer(document.referrer),
      page_title: document.title
    });
    pageViewSent = true;
  }

  function loadGoogleTag() {
    if (analyticsLoaded || getConsent() !== "granted" || !isAllowedPublicLocation(window.location)) return;
    analyticsLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    updateGoogleConsent("granted");
    window.gtag("config", MEASUREMENT_ID, {
      send_page_view: false,
      page_location: sanitizePageLocation(window.location),
      page_path: normalizePath(window.location.pathname),
      page_referrer: sanitizeReferrer(document.referrer)
    });

    const existingScript = document.querySelector(`script[src^="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"]`);
    if (existingScript) {
      sendPageView();
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
    script.onload = sendPageView;
    document.head.appendChild(script);
  }

  function renderConsentBanner(forceOpen = false) {
    let banner = document.getElementById("analyticsConsentBanner");
    if (!banner) {
      banner = document.createElement("aside");
      banner.id = "analyticsConsentBanner";
      banner.className = "analytics-consent-banner";
      banner.setAttribute("aria-label", "アクセス解析の設定");
      banner.innerHTML = `
        <p>アクセス解析のためGoogle Analyticsを利用します。</p>
        <a href="./privacy.html">プライバシーポリシー</a>
        <div class="analytics-consent-actions">
          <button type="button" class="secondary-button" data-analytics-consent="denied">拒否</button>
          <button type="button" class="primary-button" data-analytics-consent="granted">同意する</button>
        </div>`;
      document.body.appendChild(banner);
      banner.addEventListener("click", (event) => {
        const button = event.target.closest("[data-analytics-consent]");
        if (!button) return;
        const value = button.getAttribute("data-analytics-consent");
        if (value !== "granted" && value !== "denied") return;
        setConsent(value);
        updateGoogleConsent(value);
        banner.hidden = true;
        if (value === "granted") loadGoogleTag();
      });
    }
    banner.hidden = !forceOpen;
    return banner;
  }

  function addSettingsControl() {
    const nav = document.querySelector(".site-footer nav");
    if (!nav || nav.querySelector("[data-analytics-settings]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "analytics-settings-button";
    button.dataset.analyticsSettings = "true";
    button.textContent = "アクセス解析設定";
    button.addEventListener("click", () => renderConsentBanner(true));
    nav.appendChild(button);
  }

  function initialize() {
    if (!isAllowedPublicLocation(window.location)) return;
    addSettingsControl();
    const consent = getConsent();
    renderConsentBanner(false).hidden = consent !== "";
    if (consent === "granted") loadGoogleTag();
  }

  const api = { isAllowedPublicLocation, sanitizePageLocation, sanitizeReferrer };
  if (typeof window !== "undefined") {
    window.Starting9Analytics = api;
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
      else initialize();
    }
  }
})();
