import { V3_JOB_TYPE, V3_STATE, V3_TIMING, getV3TransitionDefinition } from "./constants.js";

// Pure schedule, slot, eligibility, and phase-status evaluation.
export function deriveV3Schedule(game) {
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(startAt.getTime())) {
    const error = new Error("DB日程に開始時刻がありません。");
    error.code = "V3_GAME_SCHEDULE_INVALID";
    throw error;
  }
  const minutes = (offset) => new Date(startAt.getTime() + offset * 60 * 1000);
  return {
    startAt,
    predictionDeadline: minutes(-V3_TIMING.predictionDeadlineMinutes),
    rosterFetchAt1: minutes(-V3_TIMING.rosterPregameMinutes),
    rosterFetchAt2: minutes(-V3_TIMING.rosterSecondPregameMinutes),
    lineupPollingStart: minutes(-V3_TIMING.lineupPollingStartMinutes),
    finalLineupAt: minutes(V3_TIMING.finalLineupMinutesAfterStart),
    publicationAt: minutes(V3_TIMING.publicationMinutesAfterStart)
  };
}

function uniqueSortedV3Dates(values) {
  return [...new Map(values.filter((value) => value instanceof Date && !Number.isNaN(value.getTime()))
    .map((value) => [value.toISOString(), value])).values()]
    .sort((left, right) => left.getTime() - right.getTime())
    .map((value) => value.toISOString());
}

export function deriveV3DisplaySchedule(game) {
  const schedule = deriveV3Schedule(game);
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const rosterFetchSlots = [
    new Date(schedule.startAt.getTime() - V3_TIMING.rosterPregameMinutes * 60 * 1000),
    new Date(schedule.startAt.getTime() - V3_TIMING.rosterSecondPregameMinutes * 60 * 1000),
    ...V3_TIMING.rosterDailySlotsJst.map((slot) => {
      const [hour, minute] = String(slot).split(":").map(Number);
      return jstV3Slot(gameDate, hour, minute);
    })
  ].filter((slot) => slot instanceof Date
    && !Number.isNaN(slot.getTime())
    && slot.getTime() < schedule.startAt.getTime());
  const lineupPollingSlots = [];
  for (let slot = schedule.lineupPollingStart; slot < schedule.finalLineupAt; slot = new Date(slot.getTime() + V3_TIMING.lineupPollingIntervalMinutes * 60 * 1000)) {
    lineupPollingSlots.push(slot);
  }
  const previousDayProbableStarterAt = jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0);
  return {
    startAt: schedule.startAt.toISOString(),
    predictionDeadline: schedule.predictionDeadline.toISOString(),
    rosterFetchSlots: uniqueSortedV3Dates(rosterFetchSlots),
    lineupPollingStart: schedule.lineupPollingStart.toISOString(),
    lineupPollingSlots: uniqueSortedV3Dates(lineupPollingSlots),
    finalLineupAt: schedule.finalLineupAt.toISOString(),
    scoringEarliestAt: schedule.finalLineupAt.toISOString(),
    publicationAt: schedule.publicationAt.toISOString(),
    probableStarterNextAt: previousDayProbableStarterAt?.toISOString() || null
  };
}

export function getV3RosterSlots(game) {
  return deriveV3DisplaySchedule(game).rosterFetchSlots
    .map((slot) => new Date(slot))
    .filter((slot) => !Number.isNaN(slot.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
}

// Keep planner and executor audit data on the same V3 timing contract.
export function getV3RosterPlanningDiagnostics(game, now = new Date(), selectedSlotAt = "") {
  const current = now instanceof Date ? now : new Date(now);
  const slots = getV3RosterSlots(game);
  const dueSlots = Number.isNaN(current.getTime())
    ? []
    : slots.filter((slot) => slot.getTime() <= current.getTime());
  const selectedDueSlot = selectedSlotAt
    ? new Date(selectedSlotAt)
    : dueSlots[dueSlots.length - 1] || null;
  return {
    generatedSlots: slots.map((slot) => slot.toISOString()),
    dueSlots: dueSlots.map((slot) => slot.toISOString()),
    selectedDueSlot: selectedDueSlot && !Number.isNaN(selectedDueSlot.getTime()) ? selectedDueSlot.toISOString() : null,
    selectedSlotReason: selectedDueSlot ? "latest_due_roster_slot" : "roster_not_due"
  };
}

function formatV3JstTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function latestV3RosterJob(jobs, statuses) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(job?.job_type || job?.jobType || "") === V3_JOB_TYPE.ROSTER_FETCH)
    .filter((job) => statuses.includes(String(job?.status || "")))
    .sort((left, right) => String(right?.updated_at || right?.completed_at || right?.scheduled_at || "")
      .localeCompare(String(left?.updated_at || left?.completed_at || left?.scheduled_at || "")))[0] || null;
}

function rosterPlayerKey(player) {
  const number = String(player?.number || player?.uniformNumber || player?.uniform_number || "").trim();
  if (number) return `number:${number}`;
  const name = String(player?.name || player?.playerName || "").replace(/[\s\u3000]/g, "").toLowerCase();
  return name ? `name:${name}` : "";
}

function rosterPlayerSummary(player) {
  return {
    name: String(player?.name || player?.playerName || "").trim(),
    number: String(player?.number || player?.uniformNumber || player?.uniform_number || "").trim(),
    position: String(player?.position || "").trim()
  };
}

function rosterPlayerName(player) {
  return String(player?.name || player?.playerName || "").replace(/[\s\u3000]/g, "").toLowerCase();
}

// Compare the official roster payload with the snapshot that public/admin reads.
// This is intentionally pure: it observes source drift without changing the
// fetch, planner, or persistence contract.
export function compareV3RosterSourceSnapshot({
  sourceRoster = [],
  snapshotRoster = [],
  sourceDate = null,
  sourceFetchedAt = null,
  snapshotCapturedAt = null,
  sourceFingerprint = null,
  snapshotFingerprint = null
} = {}) {
  const sourceByKey = new Map((Array.isArray(sourceRoster) ? sourceRoster : [])
    .map((player) => [rosterPlayerKey(player), player])
    .filter(([key]) => key));
  const snapshotByKey = new Map((Array.isArray(snapshotRoster) ? snapshotRoster : [])
    .map((player) => [rosterPlayerKey(player), player])
    .filter(([key]) => key));
  const expectedMissing = [...sourceByKey.entries()]
    .filter(([key, player]) => !snapshotByKey.has(key) || rosterPlayerName(snapshotByKey.get(key)) !== rosterPlayerName(player))
    .map(([, player]) => rosterPlayerSummary(player));
  const removedStillPresent = [...snapshotByKey.entries()]
    .filter(([key, player]) => !sourceByKey.has(key) || rosterPlayerName(sourceByKey.get(key)) !== rosterPlayerName(player))
    .map(([, player]) => rosterPlayerSummary(player));
  const mismatch = expectedMissing.length > 0 || removedStillPresent.length > 0;
  const sourceFetchedMs = new Date(sourceFetchedAt || "").getTime();
  const snapshotCapturedMs = new Date(snapshotCapturedAt || "").getTime();
  const stale = mismatch
    && Number.isFinite(sourceFetchedMs)
    && Number.isFinite(snapshotCapturedMs)
    && sourceFetchedMs > snapshotCapturedMs;
  const reasonCodes = [
    ...(expectedMissing.length ? ["ROSTER_EXPECTED_PLAYER_MISSING"] : []),
    ...(removedStillPresent.length ? ["ROSTER_REMOVED_PLAYER_STILL_PRESENT"] : []),
    ...(mismatch ? ["ROSTER_SOURCE_SNAPSHOT_MISMATCH"] : []),
    ...(stale ? ["ROSTER_SNAPSHOT_STALE"] : [])
  ];
  return {
    status: mismatch ? "ATTENTION" : "OK",
    mismatch,
    remainingMismatch: mismatch,
    stale,
    reasonCode: reasonCodes[0] || null,
    reasonCodes,
    sourceDate: sourceDate || null,
    sourceFetchedAt: sourceFetchedAt || null,
    snapshotCapturedAt: snapshotCapturedAt || null,
    sourceFingerprint: sourceFingerprint || null,
    snapshotFingerprint: snapshotFingerprint || null,
    sourcePlayerCount: sourceByKey.size,
    snapshotPlayerCount: snapshotByKey.size,
    expectedMissing,
    removedStillPresent
  };
}

// This decision is shared by planning/audit and the admin overview. A missing
// snapshot is expected until the first roster slot is due; it is not stale data.
export function getV3RosterStatusDecision({ game, now = new Date(), snapshot = null, jobs = [], noticeState = null, sourceSnapshotComparison = null } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const slotDiagnostics = getV3RosterPlanningDiagnostics(game, current);
  const plannedSlots = slotDiagnostics.generatedSlots;
  const dueSlots = slotDiagnostics.dueSlots;
  const firstSlot = plannedSlots[0] || null;
  const nextSlot = plannedSlots.find((slot) => new Date(slot).getTime() > current.getTime()) || null;
  const freshSnapshotExists = Boolean(snapshot?.isFresh || snapshot?.exists);
  const missingSnapshot = !freshSnapshotExists && String(snapshot?.staleReason || "") === "ROSTER_SNAPSHOT_MISSING";
  const staleSnapshotExists = !freshSnapshotExists && !missingSnapshot && Boolean(snapshot?.isStale);
  const openRosterJob = latestV3RosterJob(jobs, ["pending", "claimed", "retry_wait"]);
  const failedRosterJob = latestV3RosterJob(jobs, ["failed"]);
  const terminalRosterJobExists = Boolean(latestV3RosterJob(jobs, ["completed", "failed", "cancelled"]));
  const retryWait = String(openRosterJob?.status || "") === "retry_wait";
  const pending = ["pending", "claimed"].includes(String(openRosterJob?.status || ""));
  const isBeforeFirstRosterSlot = Boolean(firstSlot && current.getTime() < new Date(firstSlot).getTime());
  const isAfterDueSlot = dueSlots.length > 0;
  const nextCheckAt = openRosterJob?.next_retry_at || nextSlot || null;
  const base = {
    currentJstTime: formatV3JstTimestamp(current),
    plannedSlots,
    dueSlots,
    selectedDueSlot: slotDiagnostics.selectedDueSlot,
    nextCheckAt,
    isBeforeFirstRosterSlot,
    isAfterDueSlot,
    freshSnapshotExists,
    staleSnapshotExists,
    openRosterJobExists: Boolean(openRosterJob),
    terminalRosterJobExists,
    openRosterJob,
    failedRosterJob,
    sourceSnapshotComparison
  };
  if (sourceSnapshotComparison?.remainingMismatch === true || sourceSnapshotComparison?.status === "ATTENTION") {
    const reasonCode = sourceSnapshotComparison.reasonCode || sourceSnapshotComparison.reasonCodes?.[0] || "ROSTER_SOURCE_SNAPSHOT_MISMATCH";
    return { ...base, severity: "ATTENTION", reasonCode, label: "公式sourceとsnapshotが不一致" };
  }
  if (freshSnapshotExists) {
    const changesCaptured = String(noticeState || "") === "ROSTER_CHANGES_CAPTURED";
    return { ...base, severity: "OK", reasonCode: changesCaptured ? "ROSTER_CHANGES_CAPTURED" : "ROSTER_NO_CHANGES", label: changesCaptured ? "公示確認済み（変更あり）" : "公示確認済み" };
  }
  if (isBeforeFirstRosterSlot) {
    return {
      ...base,
      severity: "WAITING",
      reasonCode: staleSnapshotExists ? "ROSTER_SNAPSHOT_STALE_REFETCH_SCHEDULED" : "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE",
      label: staleSnapshotExists ? "再取得予定" : "取得予定"
    };
  }
  if (retryWait) return { ...base, severity: "WAITING", reasonCode: "ROSTER_FETCH_RETRY_WAIT", label: "再試行待ち" };
  if (pending) return { ...base, severity: "WAITING", reasonCode: "ROSTER_FETCH_PENDING", label: "取得中" };
  if (failedRosterJob) return { ...base, severity: "ATTENTION", reasonCode: String(failedRosterJob.failure_code || "ROSTER_FETCH_FAILED"), label: "取得失敗" };
  if (staleSnapshotExists) return { ...base, severity: "ATTENTION", reasonCode: "ROSTER_SNAPSHOT_STALE_AFTER_DUE", label: "再取得が必要" };
  return { ...base, severity: "ATTENTION", reasonCode: "ROSTER_SNAPSHOT_MISSING_AFTER_DUE", label: "取得漏れの可能性" };
}

function v3StatusCategory(reasonCode, severity) {
  const code = String(reasonCode || "").toUpperCase();
  if (severity === "OK" && /NO_|CAPTURED|PUBLISHED|READY|COMPLETED/.test(code)) return "NO_OP_SUCCESS";
  if (/PARSE|INVALID|INTEGRITY|MISMATCH|CONFLICT|UNRESOLVED/.test(code)) return "DATA_INTEGRITY";
  if (/HTTP|NETWORK|TIMEOUT|FETCH|RETRY|TEMPORARY/.test(code)) return "RETRYABLE";
  if (/UNEXPECTED|MISSING_EXECUTOR|MISSING_HELPER|V3_JOB_FAILED/.test(code)) return "SYSTEM";
  if (/PENDING|NOT_YET|NOT_ANNOUNCED|NOT_PUBLISHED|NOT_AVAILABLE|MISSING_BEFORE_DUE|WAITING/.test(code)) return "WAITING";
  return severity === "OK" ? "OK" : "WORKFLOW";
}

function v3PhaseJob(jobs, types, statuses = []) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => types.includes(String(job?.job_type || job?.jobType || "")))
    .filter((job) => !statuses.length || statuses.includes(String(job?.status || "")))
    .sort((left, right) => String(right?.updated_at || right?.completed_at || right?.scheduled_at || "")
      .localeCompare(String(left?.updated_at || left?.completed_at || left?.scheduled_at || "")))[0] || null;
}

function v3NormalizedPhaseStatus(phase, fields = {}) {
  const severity = fields.severity || "WAITING";
  const reasonCode = fields.reasonCode || "";
  const attentionReasons = severity === "ATTENTION" ? [reasonCode || "V3_STATUS_REQUIRES_ATTENTION"] : [];
  return {
    phase,
    severity,
    label: fields.label || "待機",
    reasonCode,
    failureCode: fields.failureCode || null,
    message: fields.message || "",
    nextCheckAt: fields.nextCheckAt || null,
    isBeforeDue: Boolean(fields.isBeforeDue),
    isAfterDue: Boolean(fields.isAfterDue),
    attentionReasons,
    normalizedCategory: v3StatusCategory(reasonCode, severity),
    diagnosticFacts: fields.diagnosticFacts || {},
    displayLines: [fields.label, reasonCode, fields.nextCheckAt].filter(Boolean),
    structuredLogFacts: {
      severity,
      label: fields.label || "待機",
      reasonCode,
      normalizedCategory: v3StatusCategory(reasonCode, severity),
      nextCheckAt: fields.nextCheckAt || null,
      isBeforeDue: Boolean(fields.isBeforeDue),
      isAfterDue: Boolean(fields.isAfterDue),
      openJobExists: Boolean(fields.openJobExists),
      retryWaitJobExists: Boolean(fields.retryWaitJobExists),
      failedJobExists: Boolean(fields.failedJobExists),
      completedJobExists: Boolean(fields.completedJobExists),
      attentionReasons,
      ...(fields.diagnosticFacts || {})
    }
  };
}

const PROBABLE_STARTER_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROBABLE_STARTER_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

// A missing starter is operationally actionable close to game time, but is
// expected during the earlier publication window. Keep this decision pure so
// admin diagnostics can share the same rule without changing the runner.
export function getV3ProbableStarterHealthDecision({
  game,
  now = new Date(),
  dataStatus = "unannounced",
  status = "",
  errorCode = "",
  integrityErrorReason = "",
  homePitcherName = "",
  awayPitcherName = "",
  probableStarter = null
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(current.getTime()) || Number.isNaN(startAt.getTime())) return null;

  const row = probableStarter || {};
  const normalizedDataStatus = normalizeProbableStarterDataStatus({
    dataStatus: row.dataStatus || row.data_status || dataStatus,
    status: row.status || status,
    errorCode: row.errorCode || row.error_code || errorCode,
    integrityErrorReason: row.integrityErrorReason || row.integrity_error_reason || integrityErrorReason,
    homePitcherName: row.homePitcherName || row.home_pitcher_name || homePitcherName,
    awayPitcherName: row.awayPitcherName || row.away_pitcher_name || awayPitcherName
  });
  if (normalizedDataStatus === "announced") {
    return {
      severity: "OK",
      label: "発表済み",
      reasonCode: "PROBABLE_STARTER_ANNOUNCED",
      normalizedDataStatus,
      within24Hours: false,
      remainingMilliseconds: Math.max(0, startAt.getTime() - current.getTime()),
      nextCheckAt: null
    };
  }

  const remainingMilliseconds = startAt.getTime() - current.getTime();
  if (remainingMilliseconds <= 0) {
    return {
      severity: "ATTENTION",
      label: "要確認",
      reasonCode: "PROBABLE_STARTER_GAME_STARTED",
      message: "試合開始後も予告先発が確定していません。",
      normalizedDataStatus,
      within24Hours: true,
      remainingMilliseconds,
      isAfterDue: true,
      nextCheckAt: null
    };
  }
  if (remainingMilliseconds > PROBABLE_STARTER_ACTIVE_WINDOW_MS) return null;

  const normalizedErrorCode = String(row.errorCode || row.error_code || errorCode || "").trim().toUpperCase();
  const normalizedIntegrityReason = String(row.integrityErrorReason || row.integrity_error_reason || integrityErrorReason || "").trim().toUpperCase();
  const identityIssue = normalizedDataStatus === "integrity_error"
    || /IDENTITY|MISMATCH|CONFLICT|UNRESOLVED/.test(`${normalizedErrorCode} ${normalizedIntegrityReason}`);
  const sourceUnavailable = normalizedDataStatus === "transient_error"
    || Boolean(normalizedErrorCode);
  const reasonCode = identityIssue
    ? "PROBABLE_STARTER_IDENTITY_UNRESOLVED_WITHIN_24H"
    : sourceUnavailable
      ? "PROBABLE_STARTER_SOURCE_UNAVAILABLE_WITHIN_24H"
      : normalizedDataStatus === "partial"
        ? "PROBABLE_STARTER_PARTIAL_WITHIN_24H"
        : "PROBABLE_STARTER_MISSING_WITHIN_24H";
  const suppliedNextCheckAt = new Date(row.nextCheckAt || row.next_check_at || "");
  const maxNextCheckAt = new Date(Math.min(
    current.getTime() + PROBABLE_STARTER_RECHECK_INTERVAL_MS,
    startAt.getTime() - 30 * 60 * 1000
  ));
  const nextCheckAt = suppliedNextCheckAt > current && suppliedNextCheckAt <= maxNextCheckAt
    ? suppliedNextCheckAt
    : maxNextCheckAt > current ? maxNextCheckAt : null;
  return {
    severity: "ATTENTION",
    label: "要確認",
    reasonCode,
    message: reasonCode === "PROBABLE_STARTER_MISSING_WITHIN_24H"
      ? "試合開始24時間以内ですが、予告先発が未取得です。"
      : "試合開始24時間以内の予告先発取得に問題があります。",
    normalizedDataStatus,
    within24Hours: true,
    remainingMilliseconds,
    nextCheckAt: nextCheckAt?.toISOString() || null
  };
}

// Canonical display/diagnostic evaluation for every V3 phase. It does not
// influence planning or execution; callers use it for overview and audits.
export function deriveV3PhaseStatus({ phase, game, now = new Date(), workflowState = "scheduled", jobs = [], snapshot = null, noticeState = null, noOpReason = null, sourceStatus = "", probableStarter = null, sourceSnapshotComparison = null } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const schedule = deriveV3DisplaySchedule(game);
  if (phase === "roster") {
    const roster = getV3RosterStatusDecision({ game, now: current, snapshot, jobs, noticeState, sourceSnapshotComparison });
    return v3NormalizedPhaseStatus(phase, {
      severity: roster.severity,
      label: roster.label,
      reasonCode: roster.reasonCode,
      message: roster.reasonCode === "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE" ? "現時点では当日公示未確認" : roster.label,
      nextCheckAt: roster.nextCheckAt,
      isBeforeDue: roster.isBeforeFirstRosterSlot,
      isAfterDue: roster.isAfterDueSlot,
      openJobExists: roster.openRosterJobExists,
      retryWaitJobExists: String(roster.openRosterJob?.status || "") === "retry_wait",
      failedJobExists: Boolean(roster.failedRosterJob),
      completedJobExists: roster.terminalRosterJobExists,
      diagnosticFacts: {
        currentJstTime: roster.currentJstTime,
        freshSnapshotExists: roster.freshSnapshotExists,
        staleSnapshotExists: roster.staleSnapshotExists,
        plannedSlots: roster.plannedSlots,
        dueSlots: roster.dueSlots,
        selectedSlot: roster.selectedDueSlot
      }
    });
  }
  const typeMap = {
    probable_starter: [V3_JOB_TYPE.PROBABLE_STARTER_FETCH],
    prediction_close: [V3_JOB_TYPE.PREDICTION_CLOSE],
    lineup_fetch: [V3_JOB_TYPE.LINEUP_FETCH, "provisional_lineup_fetch", "final_lineup_fetch"],
    lineup_finalize: [V3_JOB_TYPE.LINEUP_FINALIZE],
    score: [V3_JOB_TYPE.SCORE, "scoring"],
    ranking: [V3_JOB_TYPE.RANKING_REBUILD],
    publish: [V3_JOB_TYPE.PUBLISH, "publication"]
  };
  if (phase === "probable_starter") {
    const probableStarterDecision = getV3ProbableStarterHealthDecision({
      game,
      now: current,
      dataStatus: sourceStatus || "unannounced",
      probableStarter
    });
    if (probableStarterDecision) {
      return v3NormalizedPhaseStatus(phase, {
        severity: probableStarterDecision.severity,
        label: probableStarterDecision.label,
        reasonCode: probableStarterDecision.reasonCode,
        message: probableStarterDecision.message,
        nextCheckAt: probableStarterDecision.nextCheckAt,
        isAfterDue: probableStarterDecision.isAfterDue,
        diagnosticFacts: {
          remainingMilliseconds: probableStarterDecision.remainingMilliseconds,
          within24Hours: probableStarterDecision.within24Hours,
          normalizedDataStatus: probableStarterDecision.normalizedDataStatus
        }
      });
    }
  }
  const types = typeMap[phase] || [];
  const completed = v3PhaseJob(jobs, types, ["completed"]);
  const retry = v3PhaseJob(jobs, types, ["retry_wait"]);
  const open = v3PhaseJob(jobs, types, ["pending", "claimed"]);
  const failed = v3PhaseJob(jobs, types, ["failed", "permanently_failed"]);
  const latest = completed || retry || open || failed || v3PhaseJob(jobs, types);
  const failureCode = String(latest?.failure_code || "");
  const phaseSlots = phase === "lineup_fetch" ? schedule.lineupPollingSlots : [];
  const nextCheckAt = retry?.next_retry_at || phaseSlots.find((slot) => new Date(slot).getTime() > current.getTime()) || null;
  const terminalState = {
    lineup_fetch: ["lineup_ready", "scored", "ranked", "published"],
    lineup_finalize: ["lineup_ready", "scored", "ranked", "published"],
    score: ["scored", "ranked", "published"],
    ranking: ["ranked", "published"],
    publish: ["published"]
  };
  const stateValue = String(workflowState);
  if (["score", "ranking"].includes(phase) && noOpReason) {
    return v3NormalizedPhaseStatus(phase, { severity: "OK", label: "対象なしで完了", reasonCode: noOpReason, completedJobExists: true });
  }
  if (phase === "ranking" && String(retry?.failure_code || "") === "V3_SCORING_INCOMPLETE") {
    return v3NormalizedPhaseStatus(phase, {
      severity: "WAITING",
      label: "採点完了待ち",
      reasonCode: "V3_SCORING_INCOMPLETE",
      message: "採点状態を再確認し、必要なら採点をやり直します。",
      nextCheckAt: retry?.next_retry_at || null,
      openJobExists: true,
      retryWaitJobExists: true
    });
  }
  if (phase === "ranking" && !["scored", "ranked", "published"].includes(stateValue)) {
    return v3NormalizedPhaseStatus(phase, {
      severity: "WAITING",
      label: "採点完了待ち",
      reasonCode: "V3_SCORING_INCOMPLETE",
      message: "採点完了後にランキング反映を実行します。",
      nextCheckAt: retry?.next_retry_at || null,
      openJobExists: Boolean(open || retry),
      retryWaitJobExists: Boolean(retry)
    });
  }
  if (phase === "publish" && !["ranked", "published"].includes(stateValue)) {
    return v3NormalizedPhaseStatus(phase, {
      severity: "WAITING",
      label: "ランキング反映待ち",
      reasonCode: "V3_RANKING_INCOMPLETE",
      message: "ランキング反映後に結果を公開します。",
      nextCheckAt: retry?.next_retry_at || null,
      openJobExists: Boolean(open || retry),
      retryWaitJobExists: Boolean(retry)
    });
  }
  if ((terminalState[phase] || []).includes(stateValue)) {
    return v3NormalizedPhaseStatus(phase, { severity: "OK", label: "完了", reasonCode: `${phase.toUpperCase()}_COMPLETED`, completedJobExists: Boolean(completed) });
  }
  if (completed) return v3NormalizedPhaseStatus(phase, { severity: "OK", label: "完了", reasonCode: `${phase.toUpperCase()}_COMPLETED`, completedJobExists: true });
  if (retry || open) {
    const waitingCode = failureCode || (retry ? `${phase.toUpperCase()}_RETRY_WAIT` : `${phase.toUpperCase()}_PENDING`);
    const integrity = /PARSE|INVALID|INTEGRITY|MISMATCH|CONFLICT|UNEXPECTED|V3_JOB_FAILED/.test(waitingCode);
    return v3NormalizedPhaseStatus(phase, { severity: integrity ? "ATTENTION" : "WAITING", label: integrity ? "要確認" : retry ? "再試行待ち" : "処理待ち", reasonCode: waitingCode, failureCode: failureCode || null, nextCheckAt, openJobExists: Boolean(open || retry), retryWaitJobExists: Boolean(retry), failedJobExists: false, completedJobExists: false });
  }
  if (failed) return v3NormalizedPhaseStatus(phase, { severity: "ATTENTION", label: "要確認", reasonCode: failureCode || `${phase.toUpperCase()}_FAILED`, failureCode: failureCode || null, failedJobExists: true });
  if (phase === "lineup_fetch") {
    if (current.getTime() < new Date(schedule.lineupPollingStart).getTime()) return v3NormalizedPhaseStatus(phase, { severity: "WAITING", label: "取得予定", reasonCode: "LINEUP_NOT_YET_AVAILABLE", nextCheckAt: schedule.lineupPollingStart, isBeforeDue: true });
    return v3NormalizedPhaseStatus(phase, { severity: nextCheckAt ? "WAITING" : "ATTENTION", label: nextCheckAt ? "スタメン未発表" : "要確認", reasonCode: nextCheckAt ? "LINEUP_NOT_ANNOUNCED" : "LINEUP_NOT_PUBLISHED", nextCheckAt, isAfterDue: true });
  }
  if (phase === "publish") return v3NormalizedPhaseStatus(phase, { severity: "WAITING", label: "前提処理待ち", reasonCode: "PUBLISH_PREREQUISITE_PENDING" });
  return v3NormalizedPhaseStatus(phase, { severity: "WAITING", label: "処理待ち", reasonCode: `${phase.toUpperCase()}_PENDING` });
}

const NEXT_ACTION_LABELS = Object.freeze({
  prediction_close: "予想締切",
  roster_fetch: "ロースター取得",
  lineup_fetch: "スタメン取得",
  lineup_finalize: "正式スタメン確定",
  score: "採点",
  ranking_rebuild: "ランキング反映",
  publish: "結果公開"
});

function hasFinishedV3Job(jobs, jobType) {
  return jobs.some((job) => job.job_type === jobType && ["completed", "cancelled"].includes(job.status));
}

export function getV3NextAction({ schedule, state = "scheduled", jobs = [], now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!schedule || Number.isNaN(current.getTime()) || ["excluded", "published"].includes(String(state))) {
    return { nextAction: null, nextActionAt: null, nextActionLabel: null };
  }
  const completed = (jobType) => hasFinishedV3Job(jobs, jobType);
  const stateValue = String(state);
  const predictionDeadline = new Date(schedule.predictionDeadline || "");
  const predictionDeadlineElapsed = !Number.isNaN(predictionDeadline.getTime())
    && predictionDeadline.getTime() <= current.getTime();
  if (stateValue === "scheduled" && predictionDeadlineElapsed) {
    const predictionCloseCompleted = jobs.some((job) => job.job_type === "prediction_close" && job.status === "completed");
    if (!predictionCloseCompleted) {
      return {
        nextAction: "prediction_close",
        nextActionAt: predictionDeadline.toISOString(),
        nextActionLabel: NEXT_ACTION_LABELS.prediction_close,
        isOverdue: true
      };
    }
    return {
      nextAction: "prediction_close_state_sync",
      nextActionAt: null,
      nextActionLabel: "締切状態の整合性確認",
      isOverdue: true,
      isBlocked: true,
      blockingReason: "prediction_close jobは完了していますがworkflow stateがscheduledのままです。"
    };
  }
  const candidates = [];
  const add = (action, values, jobType, enabled = true) => {
    if (!enabled || completed(jobType)) return;
    for (const value of Array.isArray(values) ? values : [values]) {
      const at = new Date(value || "");
      if (!Number.isNaN(at.getTime())) {
        candidates.push({ action, at, due: at.getTime() <= current.getTime() });
      }
    }
  };
  add("prediction_close", schedule.predictionDeadline, "prediction_close", stateValue === "scheduled");
  add("roster_fetch", schedule.rosterFetchSlots, "roster_fetch", !["lineup_ready", "scored", "ranked", "published"].includes(stateValue));
  add("lineup_fetch", schedule.lineupPollingSlots, "lineup_fetch", ["prediction_closed", "manual_action_required"].includes(stateValue));
  add("lineup_finalize", schedule.finalLineupAt, "lineup_finalize", ["prediction_closed", "manual_action_required"].includes(stateValue));
  add("score", schedule.scoringEarliestAt, "score", ["scheduled", "prediction_closed"].includes(stateValue));
  add("publish", schedule.publicationAt, "publish", stateValue === "ranked");
  const next = candidates
    .filter((candidate) => !candidate.due)
    .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
  if (next) return { nextAction: next.action, nextActionAt: next.at.toISOString(), nextActionLabel: NEXT_ACTION_LABELS[next.action] };
  const overdue = candidates
    .filter((candidate) => candidate.due)
    .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
  if (overdue) {
    return {
      nextAction: overdue.action,
      nextActionAt: overdue.at.toISOString(),
      nextActionLabel: NEXT_ACTION_LABELS[overdue.action],
      isOverdue: true
    };
  }
  if (["lineup_ready", "manual_action_required"].includes(stateValue) && !completed("score")) {
    return { nextAction: "score_after_final_lineup", nextActionAt: null, nextActionLabel: "採点（正式スタメン確定後）" };
  }
  if (stateValue === "scored" && !completed("ranking_rebuild")) {
    return { nextAction: "ranking_after_scoring", nextActionAt: null, nextActionLabel: "ランキング反映（採点完了後）" };
  }
  if (stateValue === "ranked" && !completed("publish")) {
    return { nextAction: "publish", nextActionAt: schedule.publicationAt, nextActionLabel: NEXT_ACTION_LABELS.publish };
  }
  return { nextAction: null, nextActionAt: null, nextActionLabel: null };
}

function latestV3JobByType(jobs, jobType) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(job?.job_type || job?.jobType || "") === jobType)
    .sort((left, right) => String(right?.updated_at || right?.scheduled_at || "").localeCompare(String(left?.updated_at || left?.scheduled_at || "")))[0] || null;
}

export function getV3WorkflowDiagnostics({ schedule, state = "scheduled", game = {}, jobs = [], now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const stateValue = String(state || "scheduled");
  const predictionDeadline = new Date(schedule?.predictionDeadline || "");
  const predictionDeadlineElapsed = !Number.isNaN(predictionDeadline.getTime())
    && !Number.isNaN(current.getTime())
    && predictionDeadline.getTime() <= current.getTime();
  const predictionCloseJob = latestV3JobByType(jobs, "prediction_close");
  const predictionCloseCompleted = String(predictionCloseJob?.status || "") === "completed";
  const predictionCloseStateMismatch = predictionDeadlineElapsed && stateValue === "scheduled" && predictionCloseCompleted;
  const identityJob = latestV3JobByType(jobs, "npb_identity_resolve");
  const npbGameCode = String(game?.npbGameCode || game?.npb_game_code || "").trim();
  const identityCompletedWithoutCode = String(identityJob?.status || "") === "completed" && !npbGameCode;
  const lineupStateAllowed = ["prediction_closed", "manual_action_required"].includes(stateValue);
  let lineupCanRun = lineupStateAllowed;
  let lineupBlockingReasonCode = null;
  let lineupBlockingReason = null;
  if (!lineupStateAllowed) {
    lineupCanRun = false;
    if (!predictionDeadlineElapsed) {
      lineupBlockingReasonCode = null;
      lineupBlockingReason = null;
    } else {
      lineupBlockingReasonCode = predictionCloseStateMismatch
        ? "PREDICTION_CLOSE_STATE_TRANSITION_MISSING"
        : "PREDICTION_CLOSE_STATE_GATE";
      lineupBlockingReason = predictionCloseStateMismatch
        ? "prediction_close jobは完了していますがworkflow stateがscheduledのままです。"
        : "prediction_close完了後のworkflow state遷移待ちです。";
    }
  } else if (!npbGameCode) {
    lineupCanRun = false;
    lineupBlockingReasonCode = "NPB_GAME_CODE_NOT_AVAILABLE";
    lineupBlockingReason = identityCompletedWithoutCode
      ? "NPB識別jobは完了扱いですがgame codeが未解決です。"
      : "NPB game codeが未解決のためスタメン取得を実行できません。";
  } else if (!["resolved", "manually_overridden"].includes(String(game?.npbIdentityState || game?.npb_identity_state || ""))) {
    lineupCanRun = false;
    lineupBlockingReasonCode = "NPB_IDENTITY_UNRESOLVED";
    lineupBlockingReason = "NPB試合識別情報の解決待ちです。";
  }
  return {
    predictionClose: {
      deadlineAt: Number.isNaN(predictionDeadline.getTime()) ? null : predictionDeadline.toISOString(),
      deadlineElapsed: predictionDeadlineElapsed,
      jobStatus: predictionCloseJob?.status || "not_created",
      jobId: predictionCloseJob?.id || null,
      completed: predictionCloseCompleted,
      overdue: predictionDeadlineElapsed && !predictionCloseCompleted,
      stateMismatch: predictionCloseStateMismatch,
      warning: predictionCloseStateMismatch
        ? "締切jobは完了していますがworkflow stateがscheduledのままです。"
        : predictionDeadlineElapsed && !predictionCloseCompleted
          ? "予想締切を過ぎていますが締切jobが完了していません。"
          : null
    },
    identity: {
      codePresent: Boolean(npbGameCode),
      jobStatus: identityJob?.status || "not_created",
      jobId: identityJob?.id || null,
      completedWithoutCode: identityCompletedWithoutCode,
      warning: identityCompletedWithoutCode ? "NPB識別jobは完了扱いですがgame codeが未解決です。" : null
    },
    lineupFetch: {
      canRun: lineupCanRun,
      blockingReasonCode: lineupBlockingReasonCode,
      blockingReason: lineupBlockingReason
    }
  };
}

export function getV3NpbIdentityState(game, now = new Date()) {
  const persisted = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (persisted === "resolved" || persisted === "manually_overridden") return persisted;
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(current.getTime())) return "manual_action_required";
  if (current < new Date(startAt.getTime() - 50 * 60 * 1000)) return "pending";
  if (current <= new Date(startAt.getTime() + 2 * 60 * 1000)) return "retry_wait";
  return "manual_action_required";
}

export function isV3GameEligible(game) {
  if (!game?.internalGameId) return false;
  if (Number(game.isActive) === 0 || game.deletedAt) return false;
  return !["cancelled", "postponed", "no_game", "service_unavailable"].includes(String(game.gameStatus || "").toLowerCase());
}

export function resolveCanonicalProbableStarterRow(rows, internalGameId) {
  const expectedInternalGameId = String(internalGameId || "").trim();
  const allRows = Array.isArray(rows) ? rows : [];
  const mismatchedRows = allRows.filter((row) => {
    const rowInternalGameId = String(row?.internal_game_id || row?.internalGameId || "").trim();
    return rowInternalGameId && rowInternalGameId !== expectedInternalGameId;
  });
  const scopedRows = allRows.filter((row) =>
    String(row?.internal_game_id || row?.internalGameId || "").trim() === expectedInternalGameId
  );
  const canonicalRows = scopedRows.filter((row) =>
    String(row?.game_id || row?.gameId || "").trim() === expectedInternalGameId
  );
  const legacyRows = scopedRows.filter((row) =>
    String(row?.game_id || row?.gameId || "").trim() !== expectedInternalGameId
  );
  const canonicalRow = canonicalRows.length === 1 ? canonicalRows[0] : null;
  return {
    canonicalRow,
    canonicalRowId: canonicalRow?.game_id || canonicalRow?.gameId || null,
    probableStarterRowInternalGameId: canonicalRow?.internal_game_id || canonicalRow?.internalGameId || null,
    conflictingRowId: legacyRows[0]?.game_id || legacyRows[0]?.gameId || null,
    legacyRowDetected: legacyRows.length > 0,
    rowCount: scopedRows.length,
    mismatchedRowId: mismatchedRows[0]?.game_id || mismatchedRows[0]?.gameId || null,
    mismatchedInternalGameId: mismatchedRows[0]?.internal_game_id || mismatchedRows[0]?.internalGameId || null,
    integrityErrorReason: mismatchedRows.length > 0
      ? "PROBABLE_STARTER_INTERNAL_GAME_ID_MISMATCH"
      : canonicalRows.length > 1 ? "MULTIPLE_CANONICAL_PROBABLE_STARTER_ROWS" : null
  };
}

export function normalizeProbableStarterDataStatus(input = {}) {
  const value = typeof input === "string" ? { dataStatus: input } : (input || {});
  const rawStatus = String(value.dataStatus || value.data_status || "").trim().toLowerCase();
  const jobStatus = String(value.status || "").trim().toLowerCase();
  const errorCode = String(value.errorCode || value.error_code || "").trim().toUpperCase();
  const integrityErrorReason = String(value.integrityErrorReason || value.integrity_error_reason || "").trim();
  const homePitcherName = String(value.homePitcherName || value.home_pitcher_name || "").trim();
  const awayPitcherName = String(value.awayPitcherName || value.away_pitcher_name || "").trim();
  const hasHomePitcher = Boolean(homePitcherName);
  const hasAwayPitcher = Boolean(awayPitcherName);
  const integrityError = ["DATA_INTEGRITY_ERROR", "PROBABLE_STARTER_GAME_MISMATCH"].includes(errorCode);
  if (integrityError || integrityErrorReason) return "integrity_error";
  if (errorCode) return "transient_error";
  if (jobStatus === "error" || jobStatus === "failed" || ["error", "failed", "transient_error"].includes(rawStatus)) {
    return "transient_error";
  }
  if (rawStatus === "partial" || (hasHomePitcher !== hasAwayPitcher)) return "partial";
  if ((rawStatus === "announced" || jobStatus === "announced") && hasHomePitcher && hasAwayPitcher) return "announced";
  if (["unannounced", "empty", "pending"].includes(rawStatus) || jobStatus === "unannounced" || !hasHomePitcher && !hasAwayPitcher) return "unannounced";
  return rawStatus || "unannounced";
}

export function shouldStopProbableStarterScheduling({
  dataStatus,
  status,
  errorCode,
  normalizedDataStatus: suppliedNormalizedDataStatus,
  integrityErrorReason,
  homePitcherName,
  awayPitcherName,
  startAt,
  gameStatus,
  now = new Date()
} = {}) {
  const normalizedDataStatus = normalizeProbableStarterDataStatus({
    dataStatus: suppliedNormalizedDataStatus || dataStatus,
    status,
    errorCode,
    integrityErrorReason,
    homePitcherName,
    awayPitcherName
  });
  const normalizedGameStatus = String(gameStatus || "").trim().toLowerCase();
  if (["cancelled", "postponed", "no_game", "service_unavailable", "excluded", "invalid"].includes(normalizedGameStatus)) {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_GAME_NOT_ELIGIBLE" };
  }
  if (normalizedDataStatus === "integrity_error") {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "DATA_INTEGRITY_ERROR" };
  }
  if (normalizedDataStatus === "announced") {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_ANNOUNCED" };
  }
  const current = now instanceof Date ? now : new Date(now);
  const start = new Date(startAt || "");
  if (!Number.isNaN(current.getTime()) && !Number.isNaN(start.getTime()) && start.getTime() <= current.getTime()) {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_GAME_STARTED" };
  }
  return { shouldStopScheduling: false, normalizedDataStatus, reasonCode: null };
}

export function getV3AllowedTransitions(from, to) {
  return Boolean(getV3TransitionDefinition(from, to));
}

export function assertV3Transition(from, to) {
  if (!getV3AllowedTransitions(from, to)) {
    const error = new Error(`V3状態遷移が許可されていません: ${from} -> ${to}`);
    error.code = "V3_STATE_TRANSITION_INVALID";
    throw error;
  }
  return { from, to };
}

export function getV3LineupSlot(startAt, now = new Date()) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const current = now instanceof Date ? now : new Date(now);
  const pollingStart = new Date(start.getTime() - 50 * 60 * 1000);
  if (current < pollingStart) return null;
  const elapsed = Math.max(0, current.getTime() - pollingStart.getTime());
  return new Date(pollingStart.getTime() + Math.floor(elapsed / (10 * 60 * 1000)) * 10 * 60 * 1000);
}

export function shiftV3IsoDate(dateValue, days) {
  const date = new Date(`${String(dateValue || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getV3ProbableStarterSourceDate({ now = new Date(), currentGameStartAt = "", nextGameDate = "" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23"
  }).formatToParts(current);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const currentHour = Number(values.hour || 0);
  const start = new Date(currentGameStartAt || "");
  if (!Number.isNaN(start.getTime()) && current >= start && nextGameDate) return String(nextGameDate);
  if (currentHour >= 18) {
    const tomorrow = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1));
    return tomorrow.toISOString().slice(0, 10);
  }
  return today;
}

export function jstV3Slot(dateValue, hour, minute) {
  const date = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
}

export function getV3ProbableStarterSlot(game) {
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const previousGameDate = shiftV3IsoDate(gameDate, -1);
  return jstV3Slot(previousGameDate, 18, 0);
}

export function getV3ProbableStarterSlots(game) {
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (!gameDate || Number.isNaN(startAt.getTime())) return [];
  const slots = [
    getV3ProbableStarterSlot(game),
    jstV3Slot(gameDate, 9, 0),
    jstV3Slot(gameDate, 12, 0),
    jstV3Slot(gameDate, 15, 0),
    new Date(startAt.getTime() - 120 * 60 * 1000),
    new Date(startAt.getTime() - 60 * 60 * 1000),
    new Date(startAt.getTime() - 30 * 60 * 1000)
  ];
  return [...new Map(slots
    .filter((slot) => slot && !Number.isNaN(slot.getTime()) && slot.getTime() <= startAt.getTime())
    .map((slot) => [slot.toISOString(), slot]))
    .values()]
    .sort((left, right) => left.getTime() - right.getTime());
}

export function getV3ProbableStarterPollingSlots(game) {
  const baseSlots = getV3ProbableStarterSlots(game);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(startAt.getTime())) return baseSlots;
  const hourlyStart = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
  const finalPollingAt = new Date(startAt.getTime() - 30 * 60 * 1000);
  const hourlySlots = [];
  for (let slotAt = new Date(Math.ceil(hourlyStart.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000)); slotAt <= finalPollingAt; slotAt = new Date(slotAt.getTime() + 60 * 60 * 1000)) {
    hourlySlots.push(slotAt);
  }
  return [...new Map([...baseSlots, ...hourlySlots]
    .filter((slot) => slot instanceof Date && !Number.isNaN(slot.getTime()) && slot.getTime() <= startAt.getTime())
    .map((slot) => [slot.toISOString(), slot]))
    .values()]
    .sort((left, right) => left.getTime() - right.getTime());
}

export function getV3ProbableStarterPlan(game, now = new Date()) {
  if (!isV3GameEligible(game)) return null;
  const current = now instanceof Date ? now : new Date(now);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  const slot = getV3ProbableStarterSlot(game);
  if (Number.isNaN(current.getTime()) || Number.isNaN(startAt.getTime()) || !slot) return null;
  if (startAt.getTime() <= current.getTime() || slot.getTime() > current.getTime()) return null;
  return { jobType: "probable_starter_fetch", scheduledSlotAt: slot, scheduledAt: slot };
}
