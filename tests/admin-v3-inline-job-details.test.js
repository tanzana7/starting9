import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-job-details.js"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

test("job詳細は対象行直下の複数開閉可能なアコーディオンとして描画される", () => {
  assert.match(renderer, /job-entry/);
  assert.match(renderer, /renderInline\(game, job\)/);
  const state = fs.readFileSync(path.join(root, "frontend", "admin-v3", "state.js"), "utf8");
  assert.match(state, /jobDetailsOpen: new Set/);
  assert.match(renderer, /aria-expanded="\$\{open \? "true" : "false"\}"/);
  assert.match(renderer, /aria-label="job詳細"/);
  assert.match(client, /v3State\.jobDetailsOpen\.delete\(key\)/);
  assert.doesNotMatch(client, /window\.alert/);
  assert.doesNotMatch(client, /window\.open/);
});

test("job詳細は既存GET APIをjobIdとinternalGameIdで検証し、キャッシュと再取得を持つ", () => {
  assert.match(client, /loadV3JobDetail\(internalGameId, jobId/);
  assert.match(client, /v3State\.jobDetailsLoading\.has\(key\)/);
  assert.match(client, /v3State\.jobDetails\.set\(key, detail\)/);
  assert.match(renderer, /data-v3-job-detail-refresh/);
  assert.match(client, /detail\.internalGameId !== internalGameId/);
  assert.match(client, /Number\(detail\.job\?\.id\) !== numericJobId/);
  assert.match(client, /error\.code \|\| "V3_JOB_DETAIL_FAILED"/);
});

test("failure message、UUID、監査JSONを選択・コピーでき、Clipboard fallbackを持つ", () => {
  for (const value of ["failureMessage", "failure_code", "job_id", "internal_game_id", "all"]) {
    assert.match(renderer, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(renderer, /navigator\?\.clipboard\?\.writeText/);
  assert.match(renderer, /document\.execCommand\("copy"\)/);
  assert.match(client, /コピーしました/);
  assert.match(renderer, /aria-live="polite"/);
  assert.match(renderer, /JSON\.stringify\(detail\.audits, null, 2\)/);
  assert.match(css, /\.job-detail-pre[^}]*white-space: pre-wrap/);
});

test("job詳細はPC二列・モバイル一列で長文を折り返し、キャッシュバスターを更新する", () => {
  assert.match(css, /\.job-detail-grid \{[^}]*grid-template-columns: repeat\(2/);
  assert.match(css, /\.job-detail-value[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.job-detail-pre[^}]*white-space: pre-wrap/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.job-detail-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(page, /admin-v3\.css\?v=admin-v3-current-stage-status-fix-1/);
  assert.match(page, /admin-v3\.js\?v=admin-v3-current-stage-status-fix-1/);
});
