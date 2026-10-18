import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_PAGE_DIRECTORIES, SHARED_PAGE_FILES, TEST_ONLY_PAGE_FILES } from "../pages-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDirectory = path.join(root, "dist");
const output = path.join(distDirectory, "production-site");
const expectedOutput = path.resolve(root, "dist", "production-site");

if (path.resolve(output) !== expectedOutput || output === root || !output.startsWith(`${path.resolve(root, "dist")}${path.sep}`)) {
  throw new Error("Refusing to build Pages assets outside the dedicated ignored production output directory.");
}

fs.mkdirSync(distDirectory, { recursive: true });
const realRoot = fs.realpathSync(root);
const realDist = fs.realpathSync(distDirectory);
if (!realDist.startsWith(`${realRoot}${path.sep}`)) {
  throw new Error("Refusing to build Pages assets because dist resolves outside the repository.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of SHARED_PAGE_FILES) {
  const source = path.join(root, file);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Required production Pages asset missing: ${file}`);
  }
  fs.copyFileSync(source, path.join(output, file));
}

// Pages treats an artifact without a top-level 404.html as an SPA and serves
// index.html for unknown paths. Production must return an actual 404 for
// removed test-only URLs rather than making them look like valid app routes.
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "404.html"), path.join(output, "404.html"));

for (const directory of SHARED_PAGE_DIRECTORIES) {
  const source = path.join(root, directory);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Required production Pages directory missing: ${directory}`);
  }
  fs.cpSync(source, path.join(output, directory), { recursive: true });
}

function listFiles(directory, relativeTo = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, relativeTo);
    if (entry.isFile()) return [path.relative(relativeTo, absolute).replaceAll(path.sep, "/")];
    throw new Error(`Unexpected non-file entry in production Pages artifact: ${path.relative(relativeTo, absolute)}`);
  });
}

const files = listFiles(output);
const testOnlyNames = new Set(TEST_ONLY_PAGE_FILES);
const leakedFiles = files.filter((file) => testOnlyNames.has(file));
if (leakedFiles.length) throw new Error(`Test-only Pages files found in production artifact: ${leakedFiles.join(", ")}`);

const forbiddenReferences = [
  /test-scenarios\.html/i,
  /scenario-controls\.js/i,
  /\/api\/test\//i,
  /TEST ENVIRONMENT/i,
  /Starting9TestTeam/
];
for (const file of files) {
  const absolute = path.join(output, file);
  const content = fs.readFileSync(absolute);
  if (forbiddenReferences.some((pattern) => pattern.test(content.toString("utf8")))) {
    throw new Error(`Test-only UI/client reference found in production Pages artifact: ${file}`);
  }
}

for (const required of ["404.html", "index.html", "script.js", "style.css", "admin-v3.html", "functions/api/[[path]].js", "frontend/shared/team-context.js"]) {
  if (!files.includes(required)) throw new Error(`Required production Pages artifact file missing: ${required}`);
}

console.log(`Built production Pages artifact with ${files.length} files at ${path.relative(root, output)}`);
