import { V3_JOB_TYPE, V3_OPEN_JOB_STATUS_SQL } from "./constants.js";
import {
  getV3ProbableStarterPollingSlots,
  isV3GameEligible,
  normalizeProbableStarterDataStatus,
  resolveCanonicalProbableStarterRow,
  shouldStopProbableStarterScheduling
} from "./domain.js";
import { createV3Job } from "./repository.js";

// Planner for the independent probable-starter polling lifecycle.
export async function planV3ProbableStarterJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  const current = now instanceof Date ? now : new Date(now);
  for (const game of Array.isArray(games) ? games : []) {
    const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
    const diagnostic = {
      internalGameId: game?.internalGameId || null,
      now: Number.isNaN(current.getTime()) ? null : current.toISOString(),
      startAt: Number.isNaN(startAt.getTime()) ? null : startAt.toISOString(),
      generatedSlots: [],
      dueSlots: [],
      selectedDueSlot: null,
      currentDataStatus: "unannounced",
      homePitcherPresent: false,
      awayPitcherPresent: false,
      shouldStopScheduling: false,
      openJobExists: false,
      openJobId: null,
      sameSlotJobExists: false,
      sameSlotJobId: null,
      actualJobExists: false,
      jobStatus: null,
      insertAttempted: false,
      insertedRowCount: 0,
      insertReasonCode: null,
      claimEligible: false,
      claimResult: "not_attempted",
      integrityErrorReason: null,
      canonicalRowId: null,
      probableStarterRowInternalGameId: null,
      conflictingRowId: null,
      legacyRowDetected: false,
      mismatchedRowId: null,
      mismatchedInternalGameId: null,
      reasonCode: null
    };
    const recordDiagnostic = () => diagnostics.push({ ...diagnostic });
    if (Number.isNaN(current.getTime()) || !isV3GameEligible(game)) {
      diagnostic.reasonCode = "PROBABLE_STARTER_GAME_NOT_ELIGIBLE";
      recordDiagnostic();
      continue;
    }
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() <= current.getTime()) {
      diagnostic.reasonCode = "PROBABLE_STARTER_NOT_DUE";
      recordDiagnostic();
      continue;
    }
    const generatedSlots = getV3ProbableStarterPollingSlots(game);
    diagnostic.generatedSlots = generatedSlots.map((slot) => slot.toISOString());
    const slots = generatedSlots.filter((slot) => slot.getTime() <= current.getTime());
    diagnostic.dueSlots = slots.map((slot) => slot.toISOString());
    const latestDueSlot = slots[slots.length - 1] || null;
    if (!latestDueSlot) {
      diagnostic.reasonCode = "PROBABLE_STARTER_NOT_DUE";
      recordDiagnostic();
      continue;
    }
    diagnostic.selectedDueSlot = latestDueSlot.toISOString();
    diagnostic.scheduledSlotAt = latestDueSlot.toISOString();
    const plan = { jobType: "probable_starter_fetch", scheduledSlotAt: latestDueSlot, scheduledAt: latestDueSlot };
    try {
      let stateRow = null;
      try {
        stateRow = await db.prepare(
          "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
        ).bind(game.internalGameId).first();
      } catch {
        // V3 state行が未作成、または旧テストadapterの場合も対象抽出は継続します。
      }
      if (["excluded", "published"].includes(String(stateRow?.state || game?.workflowState || ""))) {
        diagnostic.reasonCode = "PROBABLE_STARTER_GAME_NOT_ELIGIBLE";
        recordDiagnostic();
        continue;
      }
      let probableRow = null;
      try {
        let probableRows = [];
        try {
          probableRows = (await db.prepare(
            `SELECT game_id, internal_game_id, status, data_status, error_code, home_pitcher_name, away_pitcher_name
               FROM probable_starters
              WHERE internal_game_id = ?1
              ORDER BY COALESCE(fetched_at, updated_at) DESC
               LIMIT 3`
          ).bind(game.internalGameId).all()).results || [];
        } catch {
          // Older fixtures may lack the optional data_status column. The
          // canonical UUID scope remains unchanged; only the projection narrows.
          try {
            probableRows = (await db.prepare(
              `SELECT game_id, internal_game_id, status, error_code, home_pitcher_name, away_pitcher_name
                 FROM probable_starters
                WHERE internal_game_id = ?1
                ORDER BY COALESCE(fetched_at, updated_at) DESC
                 LIMIT 3`
            ).bind(game.internalGameId).all()).results || [];
          } catch {
            // Pre-audit schemas may also lack error_code. Keep the canonical
            // UUID lookup and retain the status/pitcher fields needed by V3.
            probableRows = (await db.prepare(
              `SELECT game_id, internal_game_id, status, home_pitcher_name, away_pitcher_name
                 FROM probable_starters
                WHERE internal_game_id = ?1
                ORDER BY updated_at DESC
                 LIMIT 3`
            ).bind(game.internalGameId).all()).results || [];
          }
        }
        const canonical = resolveCanonicalProbableStarterRow(probableRows, game.internalGameId);
        probableRow = canonical.canonicalRow;
        diagnostic.integrityErrorReason = canonical.integrityErrorReason;
        diagnostic.canonicalRowId = canonical.canonicalRowId;
        diagnostic.probableStarterRowInternalGameId = canonical.probableStarterRowInternalGameId;
        diagnostic.conflictingRowId = canonical.conflictingRowId;
        diagnostic.legacyRowDetected = canonical.legacyRowDetected;
        diagnostic.mismatchedRowId = canonical.mismatchedRowId;
        diagnostic.mismatchedInternalGameId = canonical.mismatchedInternalGameId;
        if (canonical.integrityErrorReason) {
          diagnostic.currentDataStatus = "integrity_error";
          diagnostic.shouldStopScheduling = true;
          diagnostic.reasonCode = "DATA_INTEGRITY_ERROR";
          planned.push({ game, plan, created: false, job: null, reasonCode: diagnostic.reasonCode, insertedRowCount: 0, diagnostic: { ...diagnostic } });
          recordDiagnostic();
          continue;
        }
      } catch {
        // 旧adapterまたは未適用の補助スキーマでも、V3 job計画自体は継続します。
      }
      const hasHomePitcher = Boolean(String(probableRow?.home_pitcher_name || "").trim());
      const hasAwayPitcher = Boolean(String(probableRow?.away_pitcher_name || "").trim());
      const stopDecision = shouldStopProbableStarterScheduling({
        dataStatus: probableRow?.data_status,
        status: probableRow?.status,
        errorCode: probableRow?.error_code,
        integrityErrorReason: diagnostic.integrityErrorReason,
        homePitcherName: probableRow?.home_pitcher_name,
        awayPitcherName: probableRow?.away_pitcher_name,
        startAt,
        gameStatus: stateRow?.state === "excluded" ? "excluded" : game?.gameStatus,
        now: current
      });
      diagnostic.currentDataStatus = stopDecision.normalizedDataStatus;
      diagnostic.homePitcherPresent = hasHomePitcher;
      diagnostic.awayPitcherPresent = hasAwayPitcher;
      diagnostic.shouldStopScheduling = stopDecision.shouldStopScheduling;
      if (stopDecision.shouldStopScheduling) {
        diagnostic.reasonCode = stopDecision.reasonCode;
        planned.push({ game, plan, created: false, job: null, reasonCode: stopDecision.reasonCode, insertedRowCount: 0, diagnostic: { ...diagnostic } });
        recordDiagnostic();
        continue;
      }
      const openJob = await db.prepare(
        `SELECT id, status, scheduled_slot_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1
            AND job_type = ?2
            AND status IN (${V3_OPEN_JOB_STATUS_SQL})
          LIMIT 1`
      ).bind(game.internalGameId, plan.jobType).first();
      if (openJob) {
        diagnostic.openJobExists = true;
        diagnostic.openJobId = openJob.id;
        diagnostic.actualJobExists = true;
        diagnostic.jobStatus = openJob.status;
        diagnostic.insertReasonCode = "PROBABLE_STARTER_OPEN_JOB_EXISTS";
        diagnostic.reasonCode = "PROBABLE_STARTER_OPEN_JOB_EXISTS";
        diagnostic.claimEligible = openJob.status === "pending" && new Date(plan.scheduledAt).getTime() <= current.getTime();
        planned.push({
          game,
          plan,
          created: false,
          job: openJob,
          reasonCode: "PROBABLE_STARTER_OPEN_JOB_EXISTS",
          insertedRowCount: 0,
          existingJobId: openJob.id,
          existingScheduledSlotAt: openJob.scheduled_slot_at,
          existingStatus: openJob.status,
          diagnostic: { ...diagnostic }
        });
        recordDiagnostic();
        continue;
      }
      const existingJob = await db.prepare(
        `SELECT id, status, scheduled_slot_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1
            AND job_type = ?2
            AND scheduled_slot_at = ?3
          LIMIT 1`
      ).bind(game.internalGameId, plan.jobType, latestDueSlot.toISOString()).first();
      if (existingJob) {
        diagnostic.sameSlotJobExists = true;
        diagnostic.sameSlotJobId = existingJob.id;
        diagnostic.actualJobExists = true;
        diagnostic.jobStatus = existingJob.status;
        diagnostic.insertReasonCode = "PROBABLE_STARTER_SLOT_ALREADY_EXISTS";
        diagnostic.reasonCode = "PROBABLE_STARTER_SLOT_ALREADY_EXISTS";
        diagnostic.claimEligible = ["pending", "retry_wait"].includes(String(existingJob.status || ""))
          && new Date(plan.scheduledAt).getTime() <= current.getTime();
        planned.push({
          game,
          plan,
          created: false,
          job: existingJob,
          reasonCode: "PROBABLE_STARTER_JOB_ALREADY_EXISTS",
          insertedRowCount: 0,
          existingJobId: existingJob.id,
          existingScheduledSlotAt: existingJob.scheduled_slot_at,
          existingStatus: existingJob.status,
          diagnostic: { ...diagnostic }
        });
        recordDiagnostic();
        continue;
      }
      diagnostic.insertAttempted = true;
      const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
      diagnostic.insertedRowCount = result.created ? 1 : 0;
      diagnostic.insertReasonCode = result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED";
      diagnostic.reasonCode = result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED";
      diagnostic.sameSlotJobExists = !result.created && Boolean(result.job?.id);
      diagnostic.sameSlotJobId = result.created ? null : result.job?.id || null;
      diagnostic.actualJobExists = Boolean(result.job?.id);
      diagnostic.jobStatus = result.job?.status || (result.created ? "pending" : null);
      diagnostic.claimEligible = Boolean(result.job?.status === "pending"
        && new Date(result.job?.scheduled_at || plan.scheduledAt).getTime() <= current.getTime());
      planned.push({
        game,
        plan,
        ...result,
        reasonCode: result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED",
        insertedRowCount: result.created ? 1 : 0,
        existingJobId: result.created ? null : result.job?.id || null,
        existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
        existingStatus: result.created ? null : result.job?.status || null,
        diagnostic: { ...diagnostic }
      });
      recordDiagnostic();
    } catch (error) {
      diagnostic.reasonCode = "PROBABLE_STARTER_SLOT_SELECTION_FAILED";
      recordDiagnostic();
      errors.push({ game, plan, error });
    }
  }
  return {
    created: planned.filter((entry) => entry.created).length,
    planned,
    errors,
    diagnostics
  };
}
