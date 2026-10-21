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

test("production Pages artifact excludes Test Site controls and preserves production assets", () => {
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

  const forbidden = [/test-scenarios\.html/i, /scenario-controls\.js/i, /\/api\/test\//i, /TEST ENVIRONMENT/i, /Starting9TestTeam/];
  for (const file of files) {
    const content = readArtifact(productionOutput, file);
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${file} contains ${pattern}`);
  }
});

test("Test Site Pages artifact retains scenario UI, controls, banner, and shared app assets", () => {
  fs.mkdirSync(testOutput, { recursive: true });
  fs.writeFileSync(path.join(testOutput, "stale-production-asset.html"), "must not survive an allowlisted build");
  fs.mkdirSync(path.join(testOutput, "functions", "api"), { recursive: true });
  fs.writeFileSync(path.join(testOutput, "functions", "api", "stale-proxy.js"), "must not be uploaded");
  build("tooling/test-site/build-pages.mjs");
  const files = listFiles(testOutput);
  assert.equal(files.includes("stale-production-asset.html"), false);
  assert.equal(files.some((file) => file.startsWith("functions/")), false);
  for (const forbidden of ["contact.html", "fighters-player-master.js", "game-schedule-2026.json", "game-schedule.js", "_headers", "_redirects"]) {
    assert.equal(files.includes(forbidden), false, `Test Site artifact must exclude ${forbidden}`);
  }
  assert.ok(files.includes("test-scenarios.html"));
  assert.ok(files.includes("scenario-controls.js"));
  assert.ok(files.includes("index.html"));
  assert.ok(files.includes("script.js"));
  assert.match(readArtifact(testOutput, "test-scenarios.html"), /Scenario/i);
  assert.match(readArtifact(testOutput, "scenario-controls.js"), /\/api\/test\/scenario/);
  assert.match(readArtifact(testOutput, "index.html"), /TEST ENVIRONMENT/);
  assert.match(readArtifact(testOutput, "frontend/shared/production-team.js"), /Starting9TestTeam/);
});
