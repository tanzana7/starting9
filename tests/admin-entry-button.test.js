const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

test("通常公開画面に旧admin入口と管理者状態を持たない", () => {
  assert.doesNotMatch(html, /openAdminButton|openAdminV3Button|adminModeBadge|adminDetails/);
  assert.doesNotMatch(script, /openAdminPanel|refreshAdminAccess|state\.adminAccess|state\.isAdminMode/);
});

test("管理画面は独立したadmin-v3入口として残る", () => {
  assert.match(adminHtml, /admin-v3/);
  assert.match(adminHtml, /admin-v3\.js/);
});
