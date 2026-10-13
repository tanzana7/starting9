import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const guardrails = require(path.join(root, "asia-cs/public/admin-action-guardrails.js"));

const base = (overrides = {}) => ({
  competition: { status: "active" },
  game: {
    id: "game-2",
    title: "GAME2",
    status: "lineup_confirmed",
    publicationStatus: "pending",
    predictionDeadlineAt: "2026-11-20T08:00:00.000Z",
    currentLineupRevision: 1,
    homeTeam: { id: "team-tpe", name: "Chinese Taipei" },
    awayTeam: { id: "team-jpn", name: "Japan" }
  },
  currentLineup: { revision: 1, lineup: [] },
  formalJobs: [
    { job_type: "score", status: "scheduled", revision_number: null },
    { job_type: "ranking_rebuild", status: "scheduled", revision_number: null },
    { job_type: "publish", status: "scheduled", revision_number: null }
  ],
  ...overrides
});

const japanSummary = { id: "game-2", predictionEligible: true };

test("score remains disabled before deadline and becomes enabled after a lineup is ready", () => {
  const detail = base();
  assert.equal(guardrails.actionState(detail, japanSummary, "score", Date.parse("2026-11-20T07:59:59.000Z")).enabled, false);
  assert.match(guardrails.actionState(detail, japanSummary, "score", Date.parse("2026-11-20T07:59:59.000Z")).reason, /締切前/);
  assert.equal(guardrails.actionState(detail, japanSummary, "score", Date.parse("2026-11-20T08:00:00.000Z")).enabled, true);
});

test("score is disabled when lineup is missing or already scored", () => {
  const missing = base({ currentLineup: null });
  assert.match(guardrails.actionState(missing, japanSummary, "score", Date.parse("2026-11-20T09:00:00.000Z")).reason, /正式スタメン/);
  const scored = base({ game: { ...base().game, status: "scored" } });
  assert.match(guardrails.actionState(scored, japanSummary, "score", Date.parse("2026-11-20T09:00:00.000Z")).reason, /採点済み/);
});

test("non-Japan and draft games do not expose a ready pipeline action", () => {
  const nonJapan = base();
  assert.match(guardrails.actionState(nonJapan, { id: "game-1", predictionEligible: false }, "score").reason, /予想対象外/);
  const draft = base({ competition: { status: "draft" } });
  assert.match(guardrails.actionState(draft, japanSummary, "publish").reason, /active/);
});

test("ranking requires a current completed score and publish requires a current ranking artifact", () => {
  const detail = base({ formalJobs: [
    { job_type: "score", status: "completed", revision_number: 1 },
    { job_type: "ranking_rebuild", status: "scheduled", revision_number: null },
    { job_type: "publish", status: "scheduled", revision_number: null }
  ], game: { ...base().game, status: "scored" } });
  assert.equal(guardrails.actionState(detail, japanSummary, "ranking").enabled, true);
  assert.match(guardrails.actionState(base({ game: { ...base().game, status: "scored" } }), japanSummary, "ranking").reason, /採点処理/);
  assert.match(guardrails.actionState(detail, japanSummary, "publish").reason, /ランキング更新/);
  detail.formalJobs[1] = { job_type: "ranking_rebuild", status: "completed", revision_number: 1, artifact_generation: "generation-1" };
  assert.equal(guardrails.actionState(detail, japanSummary, "publish").enabled, true);
});

test("rescore is available only for an already scored current revision", () => {
  const detail = base({ game: { ...base().game, status: "scored" } });
  assert.equal(guardrails.actionState(detail, japanSummary, "rescore").enabled, true);
  assert.equal(guardrails.actionState(base(), japanSummary, "rescore").enabled, false);
});

test("competition activate and complete states are explicit", () => {
  assert.equal(guardrails.competitionState({ status: "draft" }, "activate").enabled, true);
  assert.equal(guardrails.competitionState({ status: "active" }, "activate").enabled, false);
  assert.equal(guardrails.competitionState({ status: "active" }, "complete").enabled, true);
  assert.equal(guardrails.competitionState({ status: "draft" }, "complete").enabled, false);
  assert.equal(guardrails.competitionState({ status: "completed" }, "complete").enabled, false);
});

test("confirmation text names the operation and its effect", () => {
  assert.match(guardrails.confirmationText("activate", { name: "APBC 2026" }), /予想受付が開始/);
  assert.match(guardrails.confirmationText("score", { name: "GAME2（Chinese Taipei vs Japan）" }), /GAME2/);
  assert.match(guardrails.confirmationText("publish", { name: "GAME2" }), /公開/);
});

test("backend error codes retain an operator-facing reason", () => {
  assert.equal(guardrails.errorMessage({ code: "SCORING_INCOMPLETE", message: "internal" }), "採点処理が完了していません。");
  assert.equal(guardrails.errorMessage({ code: "RANKING_INCOMPLETE", message: "internal" }), "ランキング更新が完了していません。");
});

test("admin markup loads the guardrail helper before the module and exposes visible reasons", () => {
  const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  const helper = html.indexOf("/asia-cs/admin-action-guardrails.js");
  const module = html.indexOf("/asia-cs/admin.js");
  assert.ok(helper >= 0 && helper < module);
  assert.match(html, /id="scoreGameReason"/);
  assert.match(html, /id="activateCompetitionReason"/);
  const admin = fs.readFileSync(path.join(root, "asia-cs/public/admin.js"), "utf8");
  assert.match(admin, /window\.confirm\(guardrails\.confirmationText/);
  assert.match(admin, /if \(state\.operationPending\) return/);
  assert.match(admin, /if \(!window\.confirm\(guardrails\.confirmationText\(action/);
  assert.match(admin, /state\.operationPending/);
});
