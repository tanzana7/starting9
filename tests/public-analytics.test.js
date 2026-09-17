const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const analyticsSource = fs.readFileSync(path.join(root, "frontend", "public", "analytics.js"), "utf8");

function loadAnalytics() {
  const context = { URL, window: {}, document: undefined };
  vm.createContext(context);
  vm.runInContext(analyticsSource, context);
  return context.window.Starting9Analytics;
}

test("GA4は指定された公開測定IDを使い、公開HTMLだけがanalytics.jsを読み込む", () => {
  assert.match(analyticsSource, /G-169GEEXKQJ/);
  assert.match(analyticsSource, /googletagmanager\.com\/gtag\/js/);
  assert.match(analyticsSource, /starting9\.analytics-consent/);
  assert.match(analyticsSource, /send_page_view:\s*false/);
  assert.match(analyticsSource, /page_location:\s*pageLocation/);

  for (const file of ["index.html", "how-to-play.html", "terms.html", "privacy.html", "contact.html"]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /frontend\/public\/analytics\.js\?v=ga4-public-consent-1/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, "admin-v3.html"), "utf8"), /frontend\/public\/analytics\.js/);
});

test("GA4の許可対象は本番公開ホストだけで、preview・localhost・admin・auth系を除外する", () => {
  const analytics = loadAnalytics();
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", pathname: "/", origin: "https://starting9.pages.dev" }), true);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", pathname: "/how-to-play.html", origin: "https://starting9.pages.dev" }), true);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "abc123.starting9.pages.dev", pathname: "/", origin: "https://abc123.starting9.pages.dev" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "localhost", pathname: "/", origin: "http://localhost:8788" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", pathname: "/admin-v3", origin: "https://starting9.pages.dev" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", pathname: "/auth", origin: "https://starting9.pages.dev" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", pathname: "/tests/fixture", origin: "https://starting9.pages.dev" }), false);
});

test("ページ計測URLはquery/hashを除き、個人情報や予想内容を持ち込まない", () => {
  const analytics = loadAnalytics();
  assert.equal(
    analytics.sanitizePageLocation({
      hostname: "starting9.pages.dev",
      pathname: "/index.html",
      search: "?username=secret&prediction=hidden",
      hash: "#email=hidden",
      origin: "https://starting9.pages.dev"
    }),
  "https://starting9.pages.dev/index.html");
  assert.equal(analytics.sanitizePageLocation({ hostname: "localhost", pathname: "/?token=secret", origin: "http://localhost:8788" }), "");
  assert.equal(analytics.sanitizeReferrer("https://example.test/landing?email=hidden#prediction"), "https://example.test/landing");
});

test("同意前は外部タグを読み込まず、同意後のページビュー設定は一度だけにする", () => {
  assert.match(analyticsSource, /getConsent\(\) !== "granted"/);
  assert.match(analyticsSource, /if \(pageViewSent \|\| typeof window\.gtag !== "function"\) return/);
  assert.match(analyticsSource, /page_referrer:\s*sanitizeReferrer\(document\.referrer\)/);
  assert.match(analyticsSource, /data-analytics-consent="denied"/);
  assert.match(analyticsSource, /data-analytics-settings/);
  assert.match(fs.readFileSync(path.join(root, "privacy.html"), "utf8"), /Google Analytics 4/);
  assert.match(fs.readFileSync(path.join(root, "privacy.html"), "utf8"), /Googleのプライバシーポリシー/);
});
