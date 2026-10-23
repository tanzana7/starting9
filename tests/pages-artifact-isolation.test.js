import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionOutput = path.join(root, "dist", "production-site");
const testOutput = path.join(root, "dist", "test-site");

function build(script) {
  execFileSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: "pipe" });
}

function listFiles(directory, relativeTo = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, relativeTo);
    return entry.isFile() ? [path.relative(relativeTo, absolute).replaceAll(path.sep, "/")] : [];
  });
}

function readArtifact(directory, file) {
  return fs.readFileSync(path.join(directory, file), "utf8");
}

test("production Pages artifact contains only the production Starting9 frontend", () => {
  build("tooling/production-pages/build.mjs");
  const files = listFiles(productionOutput);
  assert.equal(files.includes("test-scenarios.html"), false);
  assert.equal(files.includes("scenario-controls.js"), false);
  for (const required of [
    "404.html", "index.html", "script.js", "style.css", "admin-v3.html", "admin-v3.js",
    "functions/api/[[path]].js", "frontend/shared/team-context.js", "assets/icons/icon-512.png",
    ...["giants", "tigers", "baystars", "carp", "swallows", "dragons", "hawks", "fighters", "marines", "eagles", "buffaloes", "lions"]
      .map((slug) => `teams/${slug}/index.html`)
  ]) assert.ok(files.includes(required), `missing production asset ${required}`);
  const sharedTeamShell = readArtifact(productionOutput, "teams/fighters/index.html");
  for (const slug of ["giants", "tigers", "baystars", "carp", "swallows", "dragons", "hawks", "marines", "eagles", "buffaloes", "lions"]) {
    assert.equal(readArtifact(productionOutput, `teams/${slug}/index.html`), sharedTeamShell, `${slug} must use the shared UI shell`);
  }
  assert.match(readArtifact(productionOutput, "404.html"), /404/);
  const productionTeamBootstrap = readArtifact(productionOutput, "frontend/shared/production-team.js");
  assert.match(productionTeamBootstrap, /window\.Starting9TargetTeam = requestedTeam/);
  assert.match(productionTeamBootstrap, /\/teams\//);
  assert.doesNotMatch(productionTeamBootstrap, /testTeam|Starting9TestTeam/);
  assert.equal(files.some((file) => /real-team-pilot|test-site/i.test(file)), false);

  const forbidden = [/test-scenarios\.html/i, /scenario-controls\.js/i, /\/api\/test\//i, /TEST ENVIRONMENT/i, /Starting9TestTeam/, /\/simu-npb\//i, /s9simu\.pages\.dev/i];
  for (const file of files) {
    const content = readArtifact(productionOutput, file);
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${file} contains ${pattern}`);
  }
});

test("Simulated NPB Pages artifact excludes the duplicate Starting9 frontend and keeps its isolated functions", () => {
  fs.mkdirSync(testOutput, { recursive: true });
  fs.writeFileSync(path.join(testOutput, "stale-production-asset.html"), "must not survive an allowlisted build");
  fs.mkdirSync(path.join(testOutput, "starting9"), { recursive: true });
  fs.writeFileSync(path.join(testOutput, "starting9", "index.html"), "old Starting9 Test UI");
  fs.mkdirSync(path.join(testOutput, "functions", "api"), { recursive: true });
  fs.writeFileSync(path.join(testOutput, "functions", "api", "stale-proxy.js"), "must not be uploaded");
  build("tooling/test-site/build-pages.mjs");
  const files = listFiles(testOutput);
  assert.equal(files.includes("stale-production-asset.html"), false);
  assert.equal(files.some((file) => file.startsWith("functions/")), false);
  for (const forbidden of [
    "contact.html", "fighters-player-master.js", "game-schedule-2026.json", "game-schedule.js",
    "_headers", "index.html", "starting9/index.html", "test-scenarios.html",
    "scenario-controls.js", "script.js", "style.css", "auth.js", "players.js",
    "test-environment.css", "frontend/shared/team-context.js", "frontend/shared/site-context.js"
  ]) {
    assert.equal(files.includes(forbidden), false, `Simulated NPB artifact must exclude ${forbidden}`);
  }
  assert.ok(files.includes("assets/simu-npb.css"));
  assert.ok(files.includes("assets/simu-npb-lineup-editor.js"));
  assert.ok(files.includes("_routes.json"));
  assert.ok(files.includes("_redirects"));
  assert.match(readArtifact(testOutput, "_redirects"), /^\/starting9\/ https:\/\/starting9-app\.pages\.dev\/ 302$/m);
  assert.match(readArtifact(testOutput, "_redirects"), /^\/teams\/\* https:\/\/starting9-app\.pages\.dev\/teams\/:splat 302$/m);
  assert.match(readArtifact(testOutput, "assets/simu-npb.css"), /\.test-notice/);
  assert.match(readArtifact(testOutput, "assets/simu-npb-lineup-editor.js"), /lineup/i);
  assert.equal(JSON.parse(readArtifact(testOutput, "_routes.json")).include.includes("/"), true);
  assert.deepEqual(files.sort(), ["_redirects", "_routes.json", "assets/simu-npb-lineup-editor.js", "assets/simu-npb.css"]);
  const generatedPagesProject = path.join(root, "dist", "test-site-project");
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "api", "[[path]].js")));
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "simu-npb", "[[path]].js")));
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "simu-admin-auth.js")));
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "index.js")));
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "simu-npb", "source.js")));
  assert.ok(fs.existsSync(path.join(generatedPagesProject, "functions", "simu-npb", "rosters.js")));
  assert.equal(JSON.parse(readArtifact(generatedPagesProject, "wrangler.jsonc")).pages_build_output_dir, "../test-site");
});
