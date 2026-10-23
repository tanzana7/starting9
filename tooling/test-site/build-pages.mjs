import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_TEAMS, TEST_TEAM_GROUPS } from "./teams.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "dist", "test-site");
const pagesProject = path.join(root, "dist", "test-site-project");
const simulatorAssetsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");
const simulatorSourceDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "simu-npb");
const simulatorFunctionsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages-project", "functions", "simu-npb");
const simulatorAssets = ["simu-npb.css", "simu-npb-lineup-editor.js"];

function resetGeneratedDirectory(directory, expectedName) {
  const distRoot = path.resolve(root, "dist");
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== distRoot || path.basename(resolved) !== expectedName) {
    throw new Error(`refusing to reset unexpected generated directory: ${resolved}`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`refusing to reset symlinked generated directory: ${resolved}`);
  }
  // Pages uploads every file in the output directory. Recreate both generated
  // outputs so stale Starting9 Test files cannot remain publicly addressable.
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

resetGeneratedDirectory(output, "test-site");
resetGeneratedDirectory(pagesProject, "test-site-project");
const routeManifestSource = path.join(root, "_routes.json");
if (!fs.existsSync(routeManifestSource)) throw new Error("required Pages route manifest missing");
fs.copyFileSync(routeManifestSource, path.join(output, "_routes.json"));
const routeManifestPath = path.join(output, "_routes.json");
const routeManifest = JSON.parse(fs.readFileSync(routeManifestPath, "utf8"));
routeManifest.include = [...new Set([...(routeManifest.include || []), "/", "/simu-npb/*"])];
fs.writeFileSync(routeManifestPath, `${JSON.stringify(routeManifest, null, 2)}\n`);
// Old clone routes may remain at CDN edges for their asset TTL after removal.
// Redirect their document URLs instead of allowing stale cached HTML to
// continue presenting a third public Starting9 frontend.
fs.writeFileSync(path.join(output, "_redirects"), [
  "/starting9 https://starting9-app.pages.dev/ 302",
  "/starting9/ https://starting9-app.pages.dev/ 302",
  "/starting9/* https://starting9-app.pages.dev/ 302",
  "/teams/* https://starting9-app.pages.dev/teams/:splat 302"
].join("\n") + "\n");
const assetsOutput = path.join(output, "assets");
fs.mkdirSync(assetsOutput, { recursive: true });
for (const asset of simulatorAssets) {
  const source = path.join(simulatorAssetsDirectory, asset);
  if (!fs.existsSync(source)) throw new Error(`required Simulated NPB asset missing: ${asset}`);
  fs.copyFileSync(source, path.join(assetsOutput, asset));
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
console.log(`Built Simulated NPB Pages assets at ${path.relative(root, output)}`);
