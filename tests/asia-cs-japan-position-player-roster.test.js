import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = JSON.parse(fs.readFileSync(path.join(root, "asia-cs/staging/phase4/players.template.json"), "utf8"));
const worker = fs.readFileSync(path.join(root, "asia-cs/worker.js"), "utf8");
const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "asia-cs/public/admin.js"), "utf8");

test("APBC Japan provisional roster has the requested display-only categories", () => {
  assert.equal(staging.players.length, 15);
  assert.deepEqual(
    ["捕手", "内野手", "外野手"].map((position) => staging.players.filter((player) => player.registeredPosition === position).length),
    [3, 7, 5]
  );
  assert.equal(new Set(staging.players.map((player) => player.id)).size, staging.players.length);
  assert.ok(staging.players.every((player) => player.club && player.active === true));
  assert.match(worker, /REGISTERED_POSITIONS\s*=\s*Object\.freeze\(\["捕手", "内野手", "外野手"\]\)/);
  assert.match(worker, /registeredPosition/);
});

test("prediction position remains an independent manual selection", () => {
  assert.match(app, /data-field="position"/);
  assert.match(app, /position\.value\s*=\s*value\.position/);
  assert.doesNotMatch(app, /player\.addEventListener\(["']change["'][\s\S]*position\.value\s*=/);
  assert.match(app, /registeredPosition/);
  assert.match(admin, /registeredPosition/);
});
