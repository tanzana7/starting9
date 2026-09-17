const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const analyticsSource = fs.readFileSync(path.join(root, "frontend", "public", "analytics.js"), "utf8");

function loadAnalytics({ location, document } = {}) {
  const context = { URL, window: { location: location || {} }, document };
  vm.createContext(context);
  vm.runInContext(analyticsSource, context);
  return context.window.Starting9Analytics;
}

test("Cloudflare Web Analyticsの公式手動スニペットを公開5ページだけが読み込む", () => {
  assert.match(analyticsSource, /static\.cloudflareinsights\.com\/beacon\.min\.js/);
  assert.match(analyticsSource, /data-cf-beacon/);
  assert.match(analyticsSource, /c5dd7fb63b4b4f88a00de4bfa90ba267/);
  assert.doesNotMatch(analyticsSource, /googletagmanager|gtag|G-169GEEXKQJ|analytics-consent|localStorage/);
  for (const file of ["index.html", "how-to-play.html", "terms.html", "privacy.html", "contact.html"]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /frontend\/public\/analytics\.js\?v=cf-web-analytics-1/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, "admin-v3.html"), "utf8"), /frontend\/public\/analytics\.js/);
});

test("計測対象はHTTPSの本番公開ホストと公開パスだけで、preview・localhost・admin・query/hashを除外する", () => {
  const analytics = loadAnalytics();
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/" }), true);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/how-to-play.html" }), true);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "abc123.starting9.pages.dev", protocol: "https:", pathname: "/" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "localhost", protocol: "http:", pathname: "/" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/admin-v3" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/auth" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/tests/fixture" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/index.html", search: "?email=hidden" }), false);
  assert.equal(analytics.isAllowedPublicLocation({ hostname: "starting9.pages.dev", protocol: "https:", pathname: "/index.html", hash: "#prediction=hidden" }), false);
});

test("同一ドキュメントではCloudflare beaconを二重読み込みせず、明示的なイベントや識別子を送らない", () => {
  const appended = [];
  const document = {
    readyState: "complete",
    querySelector(selector) {
      return selector === "script[data-starting9-cf-analytics]" ? appended[0] : null;
    },
    createElement() {
      return { setAttribute(name, value) { this[name] = value; } };
    },
    head: { appendChild(script) { appended.push(script); } }
  };
  const analytics = loadAnalytics({
    location: { hostname: "starting9.pages.dev", protocol: "https:", pathname: "/" },
    document
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, "https://static.cloudflareinsights.com/beacon.min.js");
  assert.equal(appended[0].type, "module");
  assert.match(appended[0]["data-cf-beacon"], /c5dd7fb63b4b4f88a00de4bfa90ba267/);
  assert.equal(analytics.loadCloudflareBeacon(), false);
  assert.equal(appended.length, 1);
  assert.doesNotMatch(analyticsSource, /page_view|user_id|prediction|email|localStorage|cookie/i);
});

test("preview・admin・query/hash付きURLではBeaconを追加せず、既存Beaconとも重複しない", () => {
  function createDocument(existingSelector) {
    const appended = [];
    return {
      appended,
      readyState: "complete",
      querySelector(selector) {
        return selector === existingSelector ? {} : null;
      },
      createElement() {
        return { setAttribute(name, value) { this[name] = value; } };
      },
      head: { appendChild(script) { appended.push(script); } }
    };
  }

  for (const location of [
    { hostname: "preview.starting9.pages.dev", protocol: "https:", pathname: "/" },
    { hostname: "starting9.pages.dev", protocol: "https:", pathname: "/admin-v3" },
    { hostname: "starting9.pages.dev", protocol: "https:", pathname: "/index.html", search: "?token=hidden" },
    { hostname: "starting9.pages.dev", protocol: "https:", pathname: "/index.html", hash: "#prediction=hidden" }
  ]) {
    const document = createDocument(null);
    loadAnalytics({ location, document });
    assert.equal(document.appended.length, 0);
  }

  const existingDocument = createDocument("script[data-cf-beacon]");
  const analytics = loadAnalytics({
    location: { hostname: "starting9.pages.dev", protocol: "https:", pathname: "/" },
    document: existingDocument
  });
  assert.equal(existingDocument.appended.length, 0);
  assert.equal(analytics.loadCloudflareBeacon(), false);
});

test("GA4と同意UIを公開サイトから撤去し、プライバシーポリシーをCloudflareへ更新する", () => {
  for (const file of ["index.html", "how-to-play.html", "terms.html", "privacy.html", "contact.html"]) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(html, /G-169GEEXKQJ|googletagmanager|gtag|analytics-consent|アクセス解析設定/);
  }
  const privacy = fs.readFileSync(path.join(root, "privacy.html"), "utf8");
  assert.match(privacy, /Cloudflare Web Analytics/);
  assert.match(privacy, /Cookieを使用しない/);
  assert.match(privacy, /cloudflare\.com\/privacypolicy/);
  assert.doesNotMatch(privacy, /Google Analytics|Googleのプライバシーポリシー|G-169GEEXKQJ/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "style.css"), "utf8"), /analytics-consent|analytics-settings/);
});
