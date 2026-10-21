const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const teams = require("../frontend/shared/team-context.js");

const root = path.resolve(__dirname, "..");
const teamBootstrap = fs.readFileSync(path.join(root, "frontend/shared/production-team.js"), "utf8");
const teamSlugs = Object.values(teams.NPB_TEAMS).map((team) => team.slug);

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.styleValues = new Map();
    this.style = { setProperty: (key, value) => this.styleValues.set(key, value) };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
}

function boot(pathname) {
  const header = new Element("header");
  const body = new Element("body");
  const documentElement = new Element("html");
  const meta = new Map();
  for (const selector of [
    'meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]',
    'meta[name="twitter:title"]', 'meta[name="twitter:description"]'
  ]) meta.set(selector, { content: "Fighters default" });
  const document = {
    body,
    documentElement,
    title: "",
    querySelector(selector) {
      if (selector === ".header-inner, .admin-v3-header") return header;
      return meta.get(selector) || null;
    },
    getElementById() { return null; },
    createElement(tagName) { return new Element(tagName); }
  };
  const window = {
    Starting9TeamContext: teams,
    location: { pathname, search: "", href: `https://starting9-app.pages.dev${pathname}`, assign() {} }
  };
  vm.runInNewContext(teamBootstrap, { window, document, URLSearchParams });
  return { window, document, body, documentElement, header, meta };
}

function contrastRatio(hexA, hexB) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [light, dark] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("all twelve team themes resolve with readable primary text and shared selector", () => {
  assert.equal(teamSlugs.length, 12);
  for (const key of Object.keys(teams.NPB_TEAMS)) {
    const context = teams.NPB_TEAMS[key];
    const applied = new Map();
    teams.applyBranding({ style: { setProperty: (name, value) => applied.set(name, value) } }, context);
    for (const field of ["primary", "secondary", "accent", "surface", "textOnPrimary"]) {
      assert.match(context.branding[field], /^#[0-9a-f]{6}$/i, `${key} missing ${field}`);
    }
    assert.ok(contrastRatio(context.branding.primary, context.branding.textOnPrimary) >= 4.5, `${key} primary contrast`);
    assert.equal(applied.get("--team-primary"), context.branding.primary);
    assert.equal(applied.get("--team-on-primary"), context.branding.textOnPrimary);
    assert.equal(applied.get("--team-action"), context.branding.primary);
    assert.ok(contrastRatio("#ffffff", applied.get("--team-highlight")) >= 3, `${key} highlight visibility`);
  }
});

test("root and all team routes use the same shell, correct theme, and selector selection", () => {
  const rootPage = boot("/");
  assert.equal(rootPage.window.Starting9TargetTeam.key, "fighters");
  assert.equal(rootPage.documentElement.styleValues.get("--team-primary"), teams.FIGHTERS.branding.primary);
  for (const slug of teamSlugs) {
    const context = Object.values(teams.NPB_TEAMS).find((team) => team.slug === slug);
    const page = boot(`/teams/${slug}/`);
    assert.equal(page.window.Starting9TargetTeam.key, context.key);
    assert.equal(page.document.title, `Starting9 | ${context.shortName}のスタメン予想`);
    assert.equal(page.documentElement.dataset.team, context.key);
    assert.equal(page.documentElement.styleValues.get("--team-primary"), context.branding.primary);
    if (context.key === "fighters") assert.equal(page.body.styleValues.has("--team-primary"), false);
    else assert.equal(page.body.styleValues.get("--team-primary"), context.branding.primary);
    const nav = page.header.children[0];
    const selector = nav.children[1];
    const options = selector.children;
    assert.equal(options.length, 12);
    assert.equal(options.filter((option) => option.selected).length, 1);
    assert.equal(options.find((option) => option.selected).value, context.key);
    assert.match(page.meta.get('meta[name="description"]').content, new RegExp(context.displayName));
    if (context.key !== "fighters") assert.doesNotMatch(page.document.title, /日本ハム|ファイターズ/);
  }
});

test("unknown team route fails closed instead of rendering Fighters identity", () => {
  const page = boot("/teams/not-a-team/");
  assert.equal(page.window.Starting9TargetTeam, null);
  assert.equal(page.documentElement.dataset.teamRouteError, "true");
  assert.equal(page.body.children.length, 1);
  assert.equal(page.body.children[0].className, "team-route-error");
  assert.equal(page.header.children.length, 0);
});

test("shared CSS consumes team tokens while preserving legacy aliases and Fighters public fallback", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /--fighters-blue:\s*var\(--team-primary\)/);
  assert.match(css, /--fighters-deep-blue:\s*var\(--team-secondary\)/);
  assert.match(css, /--team-primary:\s*#1f3b5b/);
  assert.match(css, /--team-secondary:\s*#14213d/);
  assert.match(css, /--team-header:\s*#164a79/);
  assert.match(css, /--team-strong-primary:\s*#1168a8/);
  assert.match(css, /--team-highlight:\s*#d5a11e/);
  assert.match(css, /color:\s*var\(--team-on-primary\)/);
  assert.match(css, /--team-action:\s*#d1ad4a/);
  assert.doesNotMatch(css, /\.team-(giants|tigers|baystars|carp|swallows|dragons|hawks|marines|eagles|buffaloes|lions)\b/);
});
