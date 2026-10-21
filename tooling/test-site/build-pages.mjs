import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_PAGE_DIRECTORIES, TEST_SITE_PAGE_FILES } from "../pages-assets.mjs";
import { TEST_TEAMS, TEST_TEAM_GROUPS } from "./teams.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "dist", "test-site");
const pagesProject = path.join(root, "dist", "test-site-project");
const testOnlyDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");
const simulatorSourceDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "simu-npb");
const simulatorFunctionsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages-project", "functions", "simu-npb");
const testOnlyFiles = ["test-scenarios.html", "scenario-controls.js"];

function resetGeneratedDirectory(directory, expectedName) {
  const distRoot = path.resolve(root, "dist");
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== distRoot || path.basename(resolved) !== expectedName) {
    throw new Error(`refusing to reset unexpected generated directory: ${resolved}`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`refusing to reset symlinked generated directory: ${resolved}`);
  }
  // Pages uploads every file in the output directory. Recreate these two
  // fixed build outputs so files left by an older build cannot escape the
  // Test Site asset allowlist or become Functions/static assets by accident.
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

resetGeneratedDirectory(output, "test-site");
resetGeneratedDirectory(pagesProject, "test-site-project");
for (const file of TEST_SITE_PAGE_FILES) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) throw new Error(`required Pages asset missing: ${file}`);
  fs.copyFileSync(source, path.join(output, file));
}
const routeManifestPath = path.join(output, "_routes.json");
const routeManifest = JSON.parse(fs.readFileSync(routeManifestPath, "utf8"));
routeManifest.include = [...new Set([...(routeManifest.include || []), "/simu-npb/*"])];
fs.writeFileSync(routeManifestPath, `${JSON.stringify(routeManifest, null, 2)}\n`);
for (const file of testOnlyFiles) {
  const source = path.join(testOnlyDirectory, file);
  if (!fs.existsSync(source)) throw new Error(`required Test Site asset missing: ${file}`);
  fs.copyFileSync(source, path.join(output, file));
}
for (const directory of SHARED_PAGE_DIRECTORIES.filter((name) => name !== "functions")) {
  const source = path.join(root, directory);
  if (!fs.existsSync(source)) throw new Error(`required Pages directory missing: ${directory}`);
  fs.cpSync(source, path.join(output, directory), { recursive: true, force: true });
}
const testTeamPayload = JSON.stringify(Object.fromEntries(Object.entries(TEST_TEAMS)
  .map(([key, team]) => [key, {
    key: team.key, slug: team.slug, displayName: team.displayName, shortName: team.shortName,
    playerTeamId: team.playerTeamId, providerTeamCode: team.providerTeamCode,
    officialRosterCode: team.officialRosterCode, league: team.league,
    aliases: team.aliases, shareHashtags: team.shareHashtags, branding: team.branding,
    logo: team.logo, icon: team.icon
  }])));
const testTeamBootstrap = `const teams = ${testTeamPayload};
const routeSlug = window.location.pathname.match(/^\\/teams\\/([a-z-]+)\\/?$/)?.[1] || "";
const routeKey = Object.keys(teams).find((candidate) => teams[candidate].slug === routeSlug) || "";
const requested = new URLSearchParams(window.location.search).get("testTeam");
const key = routeSlug ? routeKey : requested === null ? "fighters" : Object.hasOwn(teams, requested) ? requested : "";
if (!key) throw new Error("Unknown Test Site team route");
document.cookie = \`s9_test_team=\${key}; Path=/; SameSite=Lax; Secure\`;
document.cookie = "s9_test_source=simu-npb; Path=/; SameSite=Lax; Secure";
window.Starting9TestTeam = key;
window.Starting9TargetTeam = window.Starting9TeamContext.defineTeamContext(teams[key]);
window.Starting9TeamContext.applyBranding(document.documentElement, window.Starting9TargetTeam);
`;
fs.writeFileSync(path.join(output, "frontend", "shared", "production-team.js"), testTeamBootstrap);
// A previous build version placed Functions under the static output. Remove
// only that generated artifact so it cannot become a downloadable asset.
fs.rmSync(path.join(output, "functions"), { recursive: true, force: true });

const teamOptions = Object.entries(TEST_TEAMS).map(([key, team]) =>
  `<option value="${key}">${team.displayName}</option>`).join("");
const banner = `<div role="status" aria-label="テスト環境" style="padding:.55rem 1rem;background:#9d1c1c;color:#fff;text-align:center;font-weight:800">TEST ENVIRONMENT · synthetic data only</div><nav aria-label="Test Site team"><label for="testTeamSelector">球団</label> <select id="testTeamSelector">${teamOptions}</select></nav>`;
for (const file of fs.readdirSync(output).filter((name) => name.endsWith(".html"))) {
  const target = path.join(output, file);
  let html = fs.readFileSync(target, "utf8");
  html = html.replaceAll("https://starting9-app.pages.dev", "https://s9simu.pages.dev");
  if (file !== "test-scenarios.html") {
    if (!html.includes("frontend/shared/team-context.js")) {
      html = html.replace("</head>", '<script defer src="frontend/shared/team-context.js?v=test-site-12-teams"></script><script defer src="frontend/shared/production-team.js?v=test-site-12-teams"></script></head>');
    }
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  }
  fs.writeFileSync(target, html);
}
const selectorScript = `const selector = document.querySelector("#testTeamSelector");
if (selector) {
  selector.value = window.Starting9TestTeam || "fighters";
  selector.addEventListener("change", () => {
    const key = selector.value;
    const teams = ${testTeamPayload};
    if (!Object.hasOwn(teams, key)) return;
    window.location.assign(key === "fighters" ? "/" : \`/teams/\${teams[key].slug}/\`);
  });
}`;
for (const file of fs.readdirSync(output).filter((name) => name.endsWith(".html") && name !== "test-scenarios.html")) {
  const target = path.join(output, file);
  const html = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, html.replace("</body>", `<script>${selectorScript}</script></body>`));
}
for (const team of Object.values(TEST_TEAMS)) {
  const directory = path.join(output, "teams", team.slug);
  fs.mkdirSync(directory, { recursive: true });
  const routeHtml = fs.readFileSync(path.join(output, "index.html"), "utf8")
    .replace("<head>", '<head><base href="/">');
  fs.writeFileSync(path.join(directory, "index.html"), routeHtml);
}

// Pages Functions are sourced from the project root, independently of the
// static asset directory. Keep that root under ignored dist/ so it cannot be
// confused with either the production source or Pages output.
fs.mkdirSync(pagesProject, { recursive: true });
fs.cpSync(path.join(root, "functions"), path.join(pagesProject, "functions"), { recursive: true, force: true });
const simulatorFunctionOutput = path.join(pagesProject, "functions", "simu-npb");
fs.mkdirSync(simulatorFunctionOutput, { recursive: true });
fs.copyFileSync(path.join(simulatorSourceDirectory, "source.js"), path.join(simulatorFunctionOutput, "source.js"));
fs.copyFileSync(path.join(simulatorFunctionsDirectory, "[[path]].js"), path.join(simulatorFunctionOutput, "[[path]].js"));
const simulatorTeamModule = `export const TEST_TEAMS = ${JSON.stringify(TEST_TEAMS)};\nexport const TEST_TEAM_GROUPS = ${JSON.stringify(TEST_TEAM_GROUPS)};\n`;
fs.writeFileSync(path.join(simulatorFunctionOutput, "teams.js"), simulatorTeamModule);
const pagesConfigPath = path.join(root, "tooling", "test-site", "pages-project", "wrangler.jsonc");
const pagesConfig = JSON.parse(fs.readFileSync(pagesConfigPath, "utf8"));
pagesConfig.pages_build_output_dir = "../test-site";
fs.writeFileSync(path.join(pagesProject, "wrangler.jsonc"), `${JSON.stringify(pagesConfig, null, 2)}\n`);
console.log(`Built isolated Pages assets at ${path.relative(root, output)}`);
