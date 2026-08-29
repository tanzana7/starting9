import {
  V3_ERROR_CLASSES,
  V3_JOB_TYPE,
  V3_STATE,
  createV3Error,
  isV3RankingRecoveryTerminalJob,
  isV3ScoreRecoveryTerminalJob
} from "./constants.js";
import {
  deriveV3Schedule,
  getV3LineupSlot,
  getV3RosterPlanningDiagnostics,
  getV3RosterStatusDecision,
  isV3GameEligible,
  jstV3Slot,
  shiftV3IsoDate
} from "./domain.js";
import { getV3CanonicalRosterSnapshot } from "./roster-repository.js";
import { createV3Job } from "./repository.js";

function parseV3AuditDetails(failureMessage) {
  const text = String(failureMessage || "").trim();
  const summaryMarker = text.indexOf("[v3_summary=");
  if (summaryMarker >= 0) {
    const summaryEnd = text.indexOf("]", summaryMarker + "[v3_summary=".length);
    if (summaryEnd > summaryMarker) {
      try { return JSON.parse(text.slice(summaryMarker + "[v3_summary=".length, summaryEnd)); } catch { /* fall through to the legacy marker */ }
    }
  }
  const marker = text.indexOf("[v3_details=");
  if (marker >= 0) {
    try { return JSON.parse(text.slice(marker + "[v3_details=".length).replace(/\]\s*$/, "")); } catch { return {}; }
  }
  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return {};
}

async function getLatestRosterSourceComparison(db, internalGameId) {
  try {
    const row = await db.prepare(
      `SELECT failure_message
         FROM game_automation_v3_audit
        WHERE internal_game_id = ?1 AND job_type = 'roster_fetch' AND event_type = 'job'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`
    ).bind(internalGameId).first();
    const details = parseV3AuditDetails(row?.failure_message);
    return details.sourceSnapshotComparison || details.diagnostics?.sourceSnapshotComparison || null;
  } catch {
    return null;
  }
}

// Main workflow and auxiliary planners retain the existing job-slot contract.
export async function planV3RosterJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  const current = now instanceof Date ? now : new Date(now);
  for (const game of Array.isArray(games) ? games : []) {
    const diagnostic = {
      internalGameId: game?.internalGameId || null,
      now: Number.isNaN(current.getTime()) ? null : current.toISOString(),
      generatedSlots: [],
      dueSlots: [],
      selectedDueSlot: null,
      actualJobExists: false,
      jobStatus: null,
      planningSkipped: false,
      skipReason: null,
      openJobExists: false,
      existingJobId: null,
      insertAttempted: false,
      insertedRowCount: 0,
      claimResult: "not_attempted",
      rosterSnapshotExists: false,
      rosterSnapshotInternalGameId: null,
      rosterSnapshotStatus: null,
      rosterSnapshotPlayerCount: 0,
      rosterSnapshotCapturedAt: null,
      rosterSnapshotGameDate: null,
      rosterSnapshotSource: null,
      rosterSnapshotFresh: false,
      rosterSnapshotStale: false,
      staleReason: null,
      insertReasonCode: null,
      currentJstTime: null,
      plannedSlots: [],
      nextCheckAt: null,
      isBeforeFirstRosterSlot: false,
      isAfterDueSlot: false,
      freshSnapshotExists: false,
      snapshotVerificationRequired: false,
      sourceSnapshotComparison: null,
      rosterRevalidationRequired: false,
      staleSnapshotExists: false,
      terminalRosterJobExists: false,
      reasonCode: null,
      severity: null
    };
    diagnostics.push(diagnostic);
    try {
      if (!isV3GameEligible(game)) {
        diagnostic.planningSkipped = true;
        diagnostic.skipReason = "ROSTER_GAME_NOT_ELIGIBLE";
        planned.push({ game, plan: null, created: false, reasonCode: diagnostic.skipReason, diagnostic: { ...diagnostic } });
        continue;
      }
      const slotDiagnostics = getV3RosterPlanningDiagnostics(game, current);
      diagnostic.generatedSlots = slotDiagnostics.generatedSlots;
      diagnostic.dueSlots = slotDiagnostics.dueSlots;
      const dueSlots = slotDiagnostics.dueSlots.map((slot) => new Date(slot));
      const snapshot = await getV3CanonicalRosterSnapshot(db, game.internalGameId, { gameDate: game.gameDate || game.game_date });
      const rosterJobs = (await db.prepare(
        `SELECT id, status, scheduled_slot_at, scheduled_at, attempt_count, max_attempts,
                next_retry_at, claimed_at, completed_at, failure_code, updated_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1 AND job_type = ?2
          ORDER BY scheduled_slot_at DESC, id DESC`
      ).bind(game.internalGameId, "roster_fetch").all()).results || [];
      const sourceSnapshotComparison = await getLatestRosterSourceComparison(db, game.internalGameId);
      const rosterStatus = getV3RosterStatusDecision({ game, now: current, snapshot, jobs: rosterJobs, sourceSnapshotComparison });
      const rosterRevalidationRequired = Boolean(
        snapshot.exists
        && (rosterStatus.snapshotVerificationRequired
          || sourceSnapshotComparison?.mismatch === true
          || sourceSnapshotComparison?.remainingMismatch === true
          || sourceSnapshotComparison?.status === "ATTENTION")
      );
      Object.assign(diagnostic, {
        selectedDueSlot: rosterStatus.selectedDueSlot,
        rosterSnapshotExists: snapshot.exists,
        rosterSnapshotInternalGameId: snapshot.internalGameId,
        rosterSnapshotStatus: snapshot.status,
        rosterSnapshotPlayerCount: snapshot.playerCount,
        rosterSnapshotCapturedAt: snapshot.capturedAt,
        rosterSnapshotGameDate: snapshot.gameDate,
        rosterSnapshotSource: snapshot.source,
        rosterSnapshotFresh: snapshot.isFresh,
        rosterSnapshotStale: snapshot.isStale,
        staleReason: snapshot.staleReason,
        currentJstTime: rosterStatus.currentJstTime,
        plannedSlots: rosterStatus.plannedSlots,
        nextCheckAt: rosterStatus.nextCheckAt,
        isBeforeFirstRosterSlot: rosterStatus.isBeforeFirstRosterSlot,
        isAfterDueSlot: rosterStatus.isAfterDueSlot,
        freshSnapshotExists: rosterStatus.freshSnapshotExists,
        snapshotVerificationRequired: rosterStatus.snapshotVerificationRequired,
        sourceSnapshotComparison,
        rosterRevalidationRequired,
        staleSnapshotExists: rosterStatus.staleSnapshotExists,
        openJobExists: rosterStatus.openRosterJobExists,
        terminalRosterJobExists: rosterStatus.terminalRosterJobExists,
        reasonCode: rosterStatus.reasonCode,
        severity: rosterStatus.severity
      });
      if (!dueSlots.length) {
        diagnostic.planningSkipped = true;
        diagnostic.skipReason = "ROSTER_NOT_DUE";
        planned.push({ game, plan: null, created: false, reasonCode: diagnostic.reasonCode, diagnostic: { ...diagnostic } });
        continue;
      }
      const openJob = rosterJobs.find((job) => ["pending", "claimed", "retry_wait"].includes(String(job.status || "")));
      const latestDueSlot = dueSlots[dueSlots.length - 1];
      // Rescue only the latest due slot. Older due slots must not be backfilled
      // one by one after a newer slot has already been processed.
      const selectedDueSlot = latestDueSlot;
      const selectedExistingJob = rosterJobs.find((job) => String(job.scheduled_slot_at || "") === selectedDueSlot.toISOString()) || null;
      diagnostic.actualJobExists = Boolean(selectedExistingJob || openJob);
      diagnostic.jobStatus = selectedExistingJob?.status || openJob?.status || null;
      diagnostic.existingJobId = selectedExistingJob?.id || openJob?.id || null;
      if (openJob) {
        diagnostic.openJobExists = true;
        diagnostic.insertReasonCode = "ROSTER_OPEN_JOB_EXISTS";
        diagnostic.skipReason = "ROSTER_OPEN_JOB_EXISTS";
        planned.push({
          game,
          plan: { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot },
          created: false,
          job: openJob,
          reasonCode: diagnostic.skipReason,
          insertedRowCount: 0,
          existingJobId: openJob.id,
          existingScheduledSlotAt: openJob.scheduled_slot_at,
          existingStatus: openJob.status,
          diagnostic: { ...diagnostic }
        });
        continue;
      }
      if (selectedExistingJob) {
        if (rosterRevalidationRequired && ["completed", "failed", "cancelled"].includes(String(selectedExistingJob.status || ""))) {
          const revalidationSlot = new Date(Math.max(current.getTime(), selectedDueSlot.getTime()));
          const revalidationPlan = { jobType: "roster_fetch", scheduledSlotAt: revalidationSlot, scheduledAt: revalidationSlot };
          const result = await createV3Job(db, { internalGameId: game.internalGameId, ...revalidationPlan });
          diagnostic.insertAttempted = true;
          diagnostic.insertedRowCount = result.created ? 1 : 0;
          diagnostic.insertReasonCode = result.created ? "ROSTER_REVALIDATION_JOB_CREATED" : "ROSTER_REVALIDATION_JOB_EXISTS";
          diagnostic.actualJobExists = Boolean(result.job?.id || selectedExistingJob.id);
          diagnostic.jobStatus = result.job?.status || selectedExistingJob.status;
          diagnostic.existingJobId = result.job?.id || selectedExistingJob.id;
          planned.push({ game, plan: revalidationPlan, ...result, reasonCode: diagnostic.insertReasonCode, diagnostic: { ...diagnostic } });
          continue;
        }
        diagnostic.insertReasonCode = "ROSTER_SLOT_ALREADY_PROCESSED";
        diagnostic.skipReason = diagnostic.insertReasonCode;
        planned.push({
          game,
          plan: { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot },
          created: false,
          job: selectedExistingJob,
          reasonCode: diagnostic.skipReason,
          insertedRowCount: 0,
          existingJobId: selectedExistingJob.id,
          existingScheduledSlotAt: selectedExistingJob.scheduled_slot_at,
          existingStatus: selectedExistingJob.status,
          diagnostic: { ...diagnostic }
        });
        continue;
      }
      const plan = { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot };
      diagnostic.insertAttempted = true;
      const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
      diagnostic.insertedRowCount = result.created ? 1 : 0;
      diagnostic.insertReasonCode = result.created ? "ROSTER_JOB_CREATED" : "ROSTER_INSERT_IGNORED";
      diagnostic.actualJobExists = Boolean(result.job?.id);
      diagnostic.jobStatus = result.job?.status || (result.created ? "pending" : null);
      diagnostic.existingJobId = result.created ? null : result.job?.id || null;
      planned.push({
        game,
        plan,
        ...result,
        reasonCode: diagnostic.insertReasonCode,
        insertedRowCount: diagnostic.insertedRowCount,
        existingJobId: diagnostic.existingJobId,
        existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
        existingStatus: result.created ? null : result.job?.status || null,
        diagnostic: { ...diagnostic }
      });
    } catch (error) {
      diagnostic.planningSkipped = true;
      diagnostic.skipReason = "ROSTER_SLOT_PLANNING_FAILED";
      errors.push({ game, plan: null, error });
    }
  }
  return {
    created: planned.filter((entry) => entry.created).length,
    planned,
    errors,
    diagnostics
  };
}

export function getV3IdentityResolvePlans(game, now = new Date(), workflowState = "") {
  if (!isV3GameEligible(game) || String(workflowState || "") === "published") return [];
  const identityStatus = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (["resolved", "manually_overridden"].includes(identityStatus)) return [];
  const current = now instanceof Date ? now : new Date(now);
  const schedule = deriveV3Schedule(game);
  if (Number.isNaN(current.getTime())) return [];
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const slots = [
    jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0),
    jstV3Slot(gameDate, 16, 0),
    schedule.lineupPollingStart
  ];
  for (let slot = schedule.lineupPollingStart; slot <= schedule.finalLineupAt; slot = new Date(slot.getTime() + 10 * 60 * 1000)) {
    slots.push(slot);
  }
  const uniqueSlots = [...new Map(slots.filter((slot) => slot && !Number.isNaN(slot.getTime()))
    .map((slot) => [slot.toISOString(), slot])).values()]
    .sort((left, right) => left.getTime() - right.getTime());
  return uniqueSlots
    .filter((slot) => slot.getTime() <= current.getTime())
    .filter((slot) => slot.getTime() <= schedule.finalLineupAt.getTime())
    .map((slot) => ({ jobType: "npb_identity_resolve", scheduledSlotAt: slot, scheduledAt: slot }));
}

function isV3NpbIdentityResolved(game) {
  return ["resolved", "manually_overridden"].includes(String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim());
}

export const V3_JOB_STATE_GATES = Object.freeze({
  prediction_close: ["scheduled"],
  lineup_fetch: ["prediction_closed", "manual_action_required"],
  lineup_finalize: ["prediction_closed", "manual_action_required"],
  score: ["lineup_ready", "manual_action_required"],
  ranking_rebuild: ["scored"],
  publish: ["ranked"]
});

function normalizePlanningState(state, fallback = V3_STATE.SCHEDULED) {
  const normalized = String(state || "").trim().toLowerCase();
  return normalized || fallback;
}

// The formal planner uses the same due schedule as the V3.5 diagnostic, but
// remains the only layer allowed to create runtime jobs.
export function getV3FormalDuePlans(game, state, now = new Date()) {
  return getV3DuePlans(game, normalizePlanningState(state), now);
}

export function getV3DuePlans(game, state, now = new Date()) {
  if (!isV3GameEligible(game)) return [];
  const schedule = deriveV3Schedule(game);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return [];
  const plans = [];
  if (V3_JOB_STATE_GATES.prediction_close.includes(String(state)) && current >= schedule.predictionDeadline) {
    plans.push({ jobType: "prediction_close", scheduledSlotAt: schedule.predictionDeadline, scheduledAt: schedule.predictionDeadline });
  }
  const lineupState = V3_JOB_STATE_GATES.lineup_fetch.includes(String(state));
  if (lineupState && current >= schedule.lineupPollingStart && current < schedule.finalLineupAt && isV3NpbIdentityResolved(game)) {
    const slot = getV3LineupSlot(schedule.startAt, current);
    if (slot) plans.push({ jobType: "lineup_fetch", scheduledSlotAt: slot, scheduledAt: slot });
  }
  if (V3_JOB_STATE_GATES.lineup_finalize.includes(String(state)) && current >= schedule.finalLineupAt && isV3NpbIdentityResolved(game)) {
    plans.push({ jobType: "lineup_finalize", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt });
  }
  if (V3_JOB_STATE_GATES.score.includes(String(state)) && current >= schedule.finalLineupAt) {
    plans.push({ jobType: "score", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt });
  }
  if (V3_JOB_STATE_GATES.ranking_rebuild.includes(String(state))) {
    plans.push({ jobType: "ranking_rebuild", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt });
  }
  if (V3_JOB_STATE_GATES.publish.includes(String(state)) && current >= schedule.publicationAt) {
    plans.push({ jobType: "publish", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt });
  }
  return plans;
}

export function getV3DuePlan(game, state, now = new Date()) {
  const plans = getV3DuePlans(game, state, now);
  return Array.isArray(plans) ? plans[0] || null : null;
}

export function normalizeV3ExecutionError(error) {
  if (error?.code && error.code !== "V3_JOB_FAILED") return error;
  return createV3Error("UNEXPECTED_EXCEPTION", String(error?.message || "V3ジョブの予期しない例外です。"), {
    errorClass: V3_ERROR_CLASSES.SYSTEM,
    exceptionName: String(error?.name || "Error"),
    exceptionMessage: String(error?.message || ""),
    diagnostics: {
      exceptionName: String(error?.name || "Error"),
      exceptionMessage: String(error?.message || "")
    }
  });
}

export function formatV3JobFailureMessage(error) {
  const message = String(error?.message || "V3ジョブに失敗しました。");
  let diagnostics = "";
  if (error?.diagnostics && typeof error.diagnostics === "object") {
    try {
      diagnostics = JSON.stringify(error.diagnostics);
    } catch {
      diagnostics = "";
    }
  }
  return (diagnostics ? `${message} [diagnostics=${diagnostics}]` : message).slice(0, 1200);
}
