// Production Starting9 owns the public app shell. Simulated NPB has a separate
// allowlist in its builder and must not inherit these frontend assets.
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

export const TEST_ONLY_PAGE_FILES = Object.freeze([
  "test-scenarios.html",
  "scenario-controls.js"
]);
