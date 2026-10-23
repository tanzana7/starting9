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
const simulatorEditorAsset = "simu-npb-lineup-editor.js";

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
routeManifest.include = [...new Set([...(routeManifest.include || []), "/", "/simu-npb/*"])];
fs.writeFileSync(routeManifestPath, `${JSON.stringify(routeManifest, null, 2)}\n`);
for (const file of testOnlyFiles) {
  const source = path.join(testOnlyDirectory, file);
  if (!fs.existsSync(source)) throw new Error(`required Test Site asset missing: ${file}`);
  fs.copyFileSync(source, path.join(output, file));
}
const assetsOutput = path.join(output, "assets");
fs.mkdirSync(assetsOutput, { recursive: true });
fs.copyFileSync(path.join(testOnlyDirectory, simulatorEditorAsset), path.join(assetsOutput, simulatorEditorAsset));
for (const directory of SHARED_PAGE_DIRECTORIES.filter((name) => name !== "functions")) {
  const source = path.join(root, directory);
  if (!fs.existsSync(source)) throw new Error(`required Pages directory missing: ${directory}`);
  fs.cpSync(source, path.join(output, directory), { recursive: true, force: true });
}
const testContextSource = path.join(testOnlyDirectory, "team-context.js");
if (!fs.existsSync(testContextSource)) throw new Error("required Test Site team context bootstrap missing");
fs.copyFileSync(testContextSource, path.join(output, "frontend", "shared", "site-context.js"));
const simulatorStyles = path.join(testOnlyDirectory, "simu-npb.css");
if (!fs.existsSync(simulatorStyles)) throw new Error("required Simulated NPB stylesheet missing");
fs.copyFileSync(simulatorStyles, path.join(output, "assets", "simu-npb.css"));
// A previous build version placed Functions under the static output. Remove
// only that generated artifact so it cannot become a downloadable asset.
fs.rmSync(path.join(output, "functions"), { recursive: true, force: true });

const banner = '<div class="test-environment-banner" role="status" aria-label="テスト環境">TEST ENVIRONMENT · synthetic data only</div>';
for (const file of fs.readdirSync(output).filter((name) => name.endsWith(".html"))) {
  const target = path.join(output, file);
  let html = fs.readFileSync(target, "utf8");
  html = html.replaceAll("https://starting9-app.pages.dev", "https://s9simu.pages.dev");
  if (file !== "test-scenarios.html") {
    html = html.replace("</head>", '<link rel="stylesheet" href="/test-environment.css?v=standard-ui-1"></head>');
    // Keep the production Team Context and selector intact. The Test Site only
    // adds the cookies its isolated API proxy needs before production scripts run.
    const contextScript = /(<script\s+defer\s+src="(?:\.\/)?frontend\/shared\/team-context\.js[^"]*"><\/script>)/i;
    if (contextScript.test(html)) {
      html = html.replace(contextScript, '$1<script defer src="/frontend/shared/site-context.js?v=standard-ui-1"></script>');
    }
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  }
  fs.writeFileSync(target, html);
}
fs.writeFileSync(path.join(output, "test-environment.css"), `
.test-environment-banner {
  box-sizing: border-box;
  width: 100vw;
  max-width: 100vw;
  padding: .55rem clamp(1rem, 4vw, 2rem);
  color: #fff;
  background: #9d1c1c;
  text-align: center;
  font-weight: 800;
  font-size: clamp(.8rem, 3.5vw, 1rem);
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
`);
const starting9AppDirectory = path.join(output, "starting9");
fs.mkdirSync(starting9AppDirectory, { recursive: true });
const starting9App = fs.readFileSync(path.join(output, "index.html"), "utf8")
  .replace("<head>", '<head><base href="/">');
fs.writeFileSync(path.join(starting9AppDirectory, "index.html"), starting9App);
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
fs.copyFileSync(path.join(simulatorSourceDirectory, "rosters.js"), path.join(simulatorFunctionOutput, "rosters.js"));
fs.copyFileSync(path.join(simulatorFunctionsDirectory, "[[path]].js"), path.join(simulatorFunctionOutput, "[[path]].js"));
fs.copyFileSync(path.join(simulatorFunctionsDirectory, "..", "index.js"), path.join(pagesProject, "functions", "index.js"));
fs.copyFileSync(path.join(simulatorFunctionsDirectory, "..", "simu-admin-auth.js"), path.join(pagesProject, "functions", "simu-admin-auth.js"));
const simulatorTeamModule = `export const TEST_TEAMS = ${JSON.stringify(TEST_TEAMS)};\nexport const TEST_TEAM_GROUPS = ${JSON.stringify(TEST_TEAM_GROUPS)};\n`;
fs.writeFileSync(path.join(simulatorFunctionOutput, "teams.js"), simulatorTeamModule);
const pagesConfigPath = path.join(root, "tooling", "test-site", "pages-project", "wrangler.jsonc");
const pagesConfig = JSON.parse(fs.readFileSync(pagesConfigPath, "utf8"));
pagesConfig.pages_build_output_dir = "../test-site";
fs.writeFileSync(path.join(pagesProject, "wrangler.jsonc"), `${JSON.stringify(pagesConfig, null, 2)}\n`);
console.log(`Built isolated Pages assets at ${path.relative(root, output)}`);
