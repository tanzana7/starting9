// Keep the production and synthetic Pages builds on the same intentional static
// asset boundary. Test-only controls are added only by the Test Site builder.
export const SHARED_PAGE_FILES = Object.freeze([
  "_headers",
  "_redirects",
  "_routes.json",
  "admin-push-sw.js",
  "admin-v3.css",
  "admin-v3.html",
  "admin-v3.js",
  "auth.js",
  "contact.html",
  "fighters-player-master.js",
  "game-schedule-2026.json",
  "game-schedule.js",
  "how-to-play.html",
  "index.html",
  "players.js",
  "privacy.html",
  "script.js",
  "style.css",
  "terms.html"
]);

export const SHARED_PAGE_DIRECTORIES = Object.freeze([
  "assets",
  "frontend",
  "functions"
]);

export const TEST_SITE_PAGE_FILES = Object.freeze([
  "_routes.json",
  "admin-push-sw.js",
  "admin-v3.css",
  "admin-v3.html",
  "admin-v3.js",
  "auth.js",
  "how-to-play.html",
  "index.html",
  "players.js",
  "privacy.html",
  "script.js",
  "style.css",
  "terms.html"
]);

export const TEST_ONLY_PAGE_FILES = Object.freeze([
  "test-scenarios.html",
  "scenario-controls.js"
]);
