const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC_MODULES = [
  "state.js",
  "request-guard.js",
  "storage.js",
  "api-client.js",
  "app-coordinator.js",
  "render-results.js",
  "daily-best-nine.js",
  "roster.js",
  "probable-starter.js",
  "results.js",
  "prediction-validation.js",
  "prediction-persistence.js",
  "prediction-form.js"
];

function loadPublicFrontendModules(context, root, transform = (file, source) => source, targetTeam = null) {
  const teamFile = path.join(root, "frontend", "shared", "team-context.js");
  vm.runInContext(fs.readFileSync(teamFile, "utf8"), context, { filename: teamFile });
  context.window.Starting9TargetTeam = targetTeam
    ? context.window.Starting9TeamContext.defineTeamContext(targetTeam)
    : context.window.Starting9TargetTeam || context.window.Starting9TeamContext.FIGHTERS;
  for (const file of PUBLIC_MODULES) {
    const filename = path.join(root, "frontend", "public", file);
    vm.runInContext(transform(file, fs.readFileSync(filename, "utf8")), context, { filename });
  }
}

module.exports = { loadPublicFrontendModules };
