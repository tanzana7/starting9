import { compareShadowLineupToManual, isLineupShadowDue, isShadowLineupRevision } from "./lineup-shadow-service.js";

export const LINEUP_SHADOW_ACCURACY_LIMIT = 20;
export const LINEUP_SHADOW_ACCURACY_LOOKBACK_DAYS = 30;
export const LINEUP_SHADOW_STATUS_CODES = Object.freeze({
  NO_TARGET_GAME: "NO_TARGET_GAME",
  SHADOW_DISABLED: "SHADOW_DISABLED",
  WAITING_WINDOW: "WAITING_WINDOW",
  WAITING_LINEUP: "WAITING_LINEUP",
  FETCHED_UNVERIFIED: "FETCHED_UNVERIFIED",
  VERIFIED_WAITING_MANUAL: "VERIFIED_WAITING_MANUAL",
  MATCHED: "MATCHED",
  MISMATCHED: "MISMATCHED",
  INVALID: "INVALID",
  TEMPORARY_FAILURE: "TEMPORARY_FAILURE",
  EXCLUDED_CANCELLED: "EXCLUDED_CANCELLED",
  EXCLUDED_NO_GAME: "EXCLUDED_NO_GAME",
  MANUAL_FINAL_ONLY: "MANUAL_FINAL_ONLY"
});

const TERMINAL_EXCLUDED_STATUSES = new Set([
  "cancelled", "canceled", "postponed", "no_game", "service_unavailable", "excluded"
]);
const MANUAL_FINAL_SOURCES = new Set(["manual", "manual-revision", "restore"]);

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function dateValue(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoValue(value) {
  const date = dateValue(value);
  return date ? date.toISOString() : null;
}

function parseLineup(value) {
  const parsed = Array.isArray(value) ? value : parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function metadata(row) {
  const payload = parseJson(row?.validation_json ?? row?.validationJson, {});
  const validation = payload.validation && typeof payload.validation === "object" ? payload.validation : {};
  return { payload, validation };
}

function revisionTimestamp(row, payload = {}) {
  return isoValue(row?.captured_at || payload.fetchedAt || payload.fetched_at || row?.created_at);
}

function manualFinalTimestamp(row) {
  return isoValue(row?.finalized_at || row?.created_at);
}

function lifecycleStatus(row, payload, validation) {
  return text(payload.lifecycleStatus || payload.status || (validation.ok ? "verified" : "invalid_lineup")).toLowerCase();
}

export function describeShadowRevision(row) {
  const { payload, validation } = metadata(row);
  const status = lifecycleStatus(row, payload, validation);
  return {
    row,
    status,
    source: text(payload.source || row?.source || "official") || "official",
    fetchedAt: revisionTimestamp(row, payload),
    playerCount: Number(validation.playerCount || validation.parsedCount || parseLineup(row?.actual_lineup_json).length || 0),
    fingerprint: text(row?.lineup_fingerprint || row?.lineupFingerprint) || null,
    validationStatus: text(validation.status || (validation.ok ? "verified" : "")) || null,
    lineup: parseLineup(row?.actual_lineup_json),
    verified: status === "verified" || validation.status === "verified" || validation.ok === true
  };
}

function shadowRows(revisions) {
  return (Array.isArray(revisions) ? revisions : [])
    .filter((row) => Number(row?.is_final || 0) !== 1 && isShadowLineupRevision(row))
    .map(describeShadowRevision)
    .sort((left, right) => {
      const leftAt = dateValue(left.fetchedAt)?.getTime() || 0;
      const rightAt = dateValue(right.fetchedAt)?.getTime() || 0;
      return rightAt - leftAt || Number(right.row?.version || 0) - Number(left.row?.version || 0);
    });
}

function manualFinalRow(revisions) {
  return (Array.isArray(revisions) ? revisions : [])
    .filter((row) => Number(row?.is_final || 0) === 1 && MANUAL_FINAL_SOURCES.has(text(row?.source).toLowerCase()))
    .sort((left, right) => {
      const leftAt = dateValue(manualFinalTimestamp(left))?.getTime() || 0;
      const rightAt = dateValue(manualFinalTimestamp(right))?.getTime() || 0;
      return rightAt - leftAt || Number(right.version || 0) - Number(left.version || 0);
    })[0] || null;
}

export function selectShadowRevisionForComparison(revisions, manualFinal = null) {
  const candidates = shadowRows(revisions).filter((candidate) => candidate.verified);
  const manualAt = dateValue(manualFinalTimestamp(manualFinal))?.getTime() || null;
  const beforeManual = manualAt === null
    ? candidates
    : candidates.filter((candidate) => {
      const capturedAt = dateValue(candidate.fetchedAt)?.getTime();
      return capturedAt !== null && capturedAt <= manualAt;
    });
  return beforeManual[0] || null;
}

function firstShadowFetchAt(rows, logs) {
  const values = [
    ...rows.map((row) => row.fetchedAt),
    ...(Array.isArray(logs) ? logs : []).flatMap((log) => {
      const data = parseJson(log?.metadata, {});
      return [data.firstFetchAt, data.fetchedAt, log?.occurred_at];
    })
  ].map(dateValue).filter(Boolean).sort((left, right) => left.getTime() - right.getTime());
  return values[0]?.toISOString() || null;
}

function latestLogStatus(logs) {
  const sorted = (Array.isArray(logs) ? logs : []).slice().sort((left, right) => {
    const leftAt = dateValue(left?.occurred_at)?.getTime() || 0;
    const rightAt = dateValue(right?.occurred_at)?.getTime() || 0;
    return rightAt - leftAt;
  });
  const latest = sorted[0];
  if (!latest) return null;
  const data = parseJson(latest.metadata, {});
  return text(data.status || latest.status || "").toLowerCase() || null;
}

function latestLog(logs) {
  return (Array.isArray(logs) ? logs : []).slice().sort((left, right) => {
    const leftAt = dateValue(left?.occurred_at)?.getTime() || 0;
    const rightAt = dateValue(right?.occurred_at)?.getTime() || 0;
    return rightAt - leftAt;
  })[0] || null;
}

function timeMetrics({ firstFetchAt, verifiedAt, manualFinalizedAt, gameStartAt }) {
  const first = dateValue(firstFetchAt);
  const verified = dateValue(verifiedAt);
  const manual = dateValue(manualFinalizedAt);
  const start = dateValue(gameStartAt);
  return {
    firstFetchAt: first?.toISOString() || null,
    verifiedAt: verified?.toISOString() || null,
    manualFinalizedAt: manual?.toISOString() || null,
    gameStartAt: start?.toISOString() || null,
    timeToVerifiedMs: first && verified ? Math.max(0, verified.getTime() - first.getTime()) : null,
    verifiedLeadTimeMs: verified && start ? start.getTime() - verified.getTime() : null,
    manualLeadTimeMs: manual && start ? start.getTime() - manual.getTime() : null
  };
}

export function buildLineupShadowAccuracyRecord({ game = {}, revisions = [], logs = [] } = {}) {
  const gameStatus = text(game.gameStatus || game.game_status).toLowerCase();
  const shadows = shadowRows(revisions);
  const manualFinal = manualFinalRow(revisions);
  const manualFinalizedAt = manualFinalTimestamp(manualFinal);
  const verified = selectShadowRevisionForComparison(revisions, manualFinal);
  const latestAttempt = latestLog(logs);
  const hasPostManualVerified = Boolean(manualFinal && shadows.some((candidate) => candidate.verified
    && dateValue(candidate.fetchedAt)?.getTime() > (dateValue(manualFinalizedAt)?.getTime() || Number.POSITIVE_INFINITY)));
  const attempted = shadows.length > 0 || logs.length > 0;
  const fetched = shadows.length > 0;
  const excluded = TERMINAL_EXCLUDED_STATUSES.has(gameStatus);
  const common = {
    internalGameId: text(game.internalGameId || game.internal_game_id),
    gameDate: text(game.gameDate || game.game_date) || null,
    homeTeam: text(game.homeTeam || game.home_team) || null,
    awayTeam: text(game.awayTeam || game.away_team) || null,
    npbGameCode: text(game.npbGameCode || game.npb_game_code) || null,
    gameStatus: gameStatus || "scheduled",
    attempted,
    fetched,
    verified: Boolean(verified),
    source: verified?.source || shadows[0]?.source || "official",
    fetchedAt: verified?.fetchedAt || shadows[0]?.fetchedAt || null,
    firstFetchAt: firstShadowFetchAt(shadows, logs),
    verifiedAt: verified?.fetchedAt || null,
    lastAttemptAt: isoValue(latestAttempt?.occurred_at || shadows[0]?.fetchedAt),
    lastFetchedAt: shadows[0]?.fetchedAt || null,
    lastVerifiedAt: verified?.fetchedAt || null,
    latestAttemptStatus: latestLogStatus(logs),
    manualFinalRevisionId: manualFinal?.revision_id || manualFinal?.revisionId || null,
    manualFinalizedAt,
    playerCount: verified?.playerCount || shadows[0]?.playerCount || 0,
    fingerprint: verified?.fingerprint || shadows[0]?.fingerprint || null,
    validationStatus: verified?.validationStatus || shadows[0]?.validationStatus || null,
    shadowRevisionId: verified?.row?.revision_id || verified?.row?.revisionId || null,
    shadowRevisionVersion: verified?.row?.version ?? null,
    timing: null,
    comparison: null,
    differenceCount: 0,
    exclusionReason: null,
    reason: null
  };
  common.timing = timeMetrics({
    firstFetchAt: common.firstFetchAt,
    verifiedAt: common.verifiedAt,
    manualFinalizedAt,
    gameStartAt: game.startAt || game.start_time
  });
  if (excluded) {
    common.status = "excluded";
    common.exclusionReason = gameStatus === "no_game" || gameStatus === "postponed" ? gameStatus : "cancelled";
    return common;
  }
  if (!manualFinal) {
    if (verified) common.status = "pending";
    else if (shadows.some((candidate) => ["invalid_lineup", "rejected", "identity_mismatch"].includes(candidate.status))) common.status = "invalid";
    else common.status = attempted ? "pending" : "unobserved";
    common.reason = common.status === "pending" ? "manual_final_pending" : latestLogStatus(logs);
    return common;
  }
  if (hasPostManualVerified && !verified) {
    common.status = "excluded";
    common.exclusionReason = "shadow_after_manual_final";
    return common;
  }
  if (!verified) {
    common.status = shadows.length ? "invalid" : "missing";
    common.reason = shadows.length ? "no_verified_candidate_before_manual_final" : "shadow_not_observed";
    return common;
  }
  common.comparison = compareShadowLineupToManual(verified.lineup, parseLineup(manualFinal.actual_lineup_json));
  common.differenceCount = common.comparison.differenceCount;
  common.status = common.comparison.exactMatch ? "matched" : "mismatched";
  return common;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

export function aggregateLineupShadowAccuracy(records = []) {
  const items = Array.isArray(records) ? records : [];
  const eligible = items.filter((item) => !["excluded", "unobserved"].includes(item.status));
  const comparable = eligible.filter((item) => item.comparison);
  const count = (predicate) => items.filter(predicate).length;
  const exactMatches = count((item) => item.comparison?.exactMatch === true);
  const playerMatches = count((item) => item.comparison?.playerMatch === true);
  const orderMatches = count((item) => item.comparison?.battingOrderMatch === true);
  const positionMatches = count((item) => item.comparison?.positionMatch === true);
  const attempted = count((item) => item.attempted && item.status !== "excluded");
  const fetched = count((item) => item.fetched && item.status !== "excluded");
  const verified = count((item) => item.verified && item.status !== "excluded");
  const missing = count((item) => item.status === "missing");
  const invalid = count((item) => item.status === "invalid");
  const excluded = count((item) => item.status === "excluded");
  const unobserved = count((item) => item.status === "unobserved");
  const mismatched = count((item) => item.status === "mismatched");
  return {
    totalGames: items.length,
    eligibleGames: eligible.length,
    unobserved,
    attempted,
    fetched,
    verified,
    comparable: comparable.length,
    exactMatches,
    playerMatches,
    battingOrderMatches: orderMatches,
    positionMatches,
    mismatched,
    missing,
    invalid,
    excluded,
    rates: {
      attempted: rate(attempted, eligible.length),
      fetched: rate(fetched, attempted),
      verified: rate(verified, attempted),
      exactMatch: rate(exactMatches, comparable.length),
      playerMatch: rate(playerMatches, comparable.length),
      battingOrderMatch: rate(orderMatches, comparable.length),
      positionMatch: rate(positionMatches, comparable.length)
    }
  };
}

function jstDateString(value) {
  const date = dateValue(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function gameDateString(game) {
  const explicit = text(game?.gameDate || game?.game_date);
  if (/^\d{4}-\d{2}-\d{2}/.test(explicit)) return explicit.slice(0, 10);
  return jstDateString(game?.startAt || game?.start_time);
}

function excludedCode(gameStatus) {
  return ["no_game", "postponed"].includes(gameStatus)
    ? LINEUP_SHADOW_STATUS_CODES.EXCLUDED_NO_GAME
    : LINEUP_SHADOW_STATUS_CODES.EXCLUDED_CANCELLED;
}

function currentGameView(game) {
  return {
    internalGameId: text(game?.internalGameId || game?.internal_game_id) || null,
    gameDate: gameDateString(game),
    startAt: isoValue(game?.startAt || game?.start_time),
    homeTeam: text(game?.homeTeam || game?.home_team) || null,
    awayTeam: text(game?.awayTeam || game?.away_team) || null,
    npbGameCode: text(game?.npbGameCode || game?.npb_game_code) || null,
    gameStatus: text(game?.gameStatus || game?.game_status).toLowerCase() || "scheduled"
  };
}

function currentGameSort(left, right, now) {
  const leftStart = dateValue(left?.startAt || left?.start_time)?.getTime() || Number.MAX_SAFE_INTEGER;
  const rightStart = dateValue(right?.startAt || right?.start_time)?.getTime() || Number.MAX_SAFE_INTEGER;
  const current = dateValue(now)?.getTime() || 0;
  const leftDistance = Math.abs(leftStart - current);
  const rightDistance = Math.abs(rightStart - current);
  return leftDistance - rightDistance || leftStart - rightStart || text(left?.internalGameId).localeCompare(text(right?.internalGameId));
}

function currentStatusForRecord(record, game, now) {
  const normalizedGameStatus = text(game?.gameStatus || game?.game_status || "scheduled").toLowerCase();
  if (TERMINAL_EXCLUDED_STATUSES.has(normalizedGameStatus)) {
    return {
      code: excludedCode(normalizedGameStatus),
      health: "waiting",
      label: "評価対象外",
      reason: normalizedGameStatus === "no_game" || normalizedGameStatus === "postponed" ? "試合なし・延期" : "中止",
      stale: false
    };
  }
  const due = isLineupShadowDue({ startAt: game?.startAt || game?.start_time }, now);
  const start = dateValue(game?.startAt || game?.start_time);
  const current = dateValue(now);
  if (!record) {
    return {
      code: due.due ? LINEUP_SHADOW_STATUS_CODES.WAITING_LINEUP : LINEUP_SHADOW_STATUS_CODES.WAITING_WINDOW,
      health: "waiting",
      label: due.due ? "スタメン発表待ち" : "取得時間前",
      reason: due.due ? "Shadow候補待ち" : "取得時間前",
      stale: false
    };
  }
  if (record.status === "matched") {
    return { code: LINEUP_SHADOW_STATUS_CODES.MATCHED, health: "normal", label: "完全一致", reason: "player・打順・守備位置が一致", stale: false };
  }
  if (record.status === "mismatched") {
    return { code: LINEUP_SHADOW_STATUS_CODES.MISMATCHED, health: "attention", label: "差分あり", reason: `${record.differenceCount || 0}件の差分`, stale: false };
  }
  if (record.status === "invalid") {
    return { code: LINEUP_SHADOW_STATUS_CODES.INVALID, health: "attention", label: "要確認", reason: "候補の検証に失敗", stale: false };
  }
  if (record.status === "missing" && record.manualFinalRevisionId) {
    return { code: LINEUP_SHADOW_STATUS_CODES.MANUAL_FINAL_ONLY, health: "waiting", label: "Manual確定済み", reason: "Shadow候補なし", stale: false };
  }
  if (record.status === "pending" && record.verified) {
    return { code: LINEUP_SHADOW_STATUS_CODES.VERIFIED_WAITING_MANUAL, health: "waiting", label: "比較待ち", reason: "Verified済み・Manual確定待ち", stale: false };
  }
  if (["temporary_failure", "failed", "timeout"].includes(record.latestAttemptStatus)) {
    return { code: LINEUP_SHADOW_STATUS_CODES.TEMPORARY_FAILURE, health: "attention", label: "再試行中", reason: record.latestAttemptStatus, stale: false };
  }
  if (record.fetched && !record.verified) {
    return { code: LINEUP_SHADOW_STATUS_CODES.FETCHED_UNVERIFIED, health: "attention", label: "検証待ち", reason: "取得済み・検証未完了", stale: false };
  }
  const stale = Boolean(start && current && current.getTime() > start.getTime() + 10 * 60 * 1000 && !record.attempted);
  return {
    code: due.due ? LINEUP_SHADOW_STATUS_CODES.WAITING_LINEUP : LINEUP_SHADOW_STATUS_CODES.WAITING_WINDOW,
    health: stale ? "attention" : "waiting",
    label: stale ? "要確認" : due.due ? "スタメン発表待ち" : "取得時間前",
    reason: stale ? "Shadowが動いていない可能性（attempt記録なし）" : due.due ? "Shadow候補待ち" : "取得時間前",
    reasonCode: due.reasonCode,
    stale
  };
}

export function buildLineupShadowCurrentStatus({ games = [], records = [], now = new Date(), enabled = true } = {}) {
  if (!enabled) {
    return {
      code: LINEUP_SHADOW_STATUS_CODES.SHADOW_DISABLED,
      health: "waiting",
      label: "Shadow無効",
      reason: "ENABLE_LINEUP_SHADOW=false",
      stale: false,
      game: null,
      recent: [],
      lastAttemptAt: null,
      lastFetchedAt: null,
      lastVerifiedAt: null
    };
  }
  const currentDate = dateValue(now);
  if (!currentDate) {
    return {
      code: LINEUP_SHADOW_STATUS_CODES.NO_TARGET_GAME,
      health: "attention",
      label: "要確認",
      reason: "現在時刻を判定できません",
      stale: false,
      game: null,
      recent: [],
      lastAttemptAt: null,
      lastFetchedAt: null,
      lastVerifiedAt: null
    };
  }
  const today = jstDateString(now);
  const tomorrow = jstDateString(new Date(currentDate.getTime() + 24 * 60 * 60 * 1000));
  const bounded = (Array.isArray(games) ? games : [])
    .filter((game) => [today, tomorrow].includes(gameDateString(game)))
    .sort((left, right) => currentGameSort(left, right, now));
  if (!bounded.length) {
    return {
      code: LINEUP_SHADOW_STATUS_CODES.NO_TARGET_GAME,
      health: "waiting",
      label: "対象試合なし",
      reason: "本日・明日の対象試合なし",
      stale: false,
      game: null,
      recent: [],
      lastAttemptAt: null,
      lastFetchedAt: null,
      lastVerifiedAt: null
    };
  }
  const byId = new Map((Array.isArray(records) ? records : []).map((record) => [record.internalGameId, record]));
  const recent = bounded.map((game) => {
    const record = byId.get(text(game?.internalGameId || game?.internal_game_id));
    return { game: currentGameView(game), ...currentStatusForRecord(record, game, now), timing: {
      lastAttemptAt: record?.lastAttemptAt || null,
      lastFetchedAt: record?.lastFetchedAt || null,
      lastVerifiedAt: record?.lastVerifiedAt || null
    } };
  });
  const active = recent.filter((item) => ![LINEUP_SHADOW_STATUS_CODES.EXCLUDED_CANCELLED, LINEUP_SHADOW_STATUS_CODES.EXCLUDED_NO_GAME].includes(item.code));
  const selected = active[0] || recent[0];
  return {
    ...selected,
    game: selected.game,
    recent: recent.slice(0, 4),
    lastAttemptAt: selected.timing.lastAttemptAt,
    lastFetchedAt: selected.timing.lastFetchedAt,
    lastVerifiedAt: selected.timing.lastVerifiedAt
  };
}

export function buildLineupShadowAccuracyReport(records = [], { limit = LINEUP_SHADOW_ACCURACY_LIMIT, lookbackDays = LINEUP_SHADOW_ACCURACY_LOOKBACK_DAYS, games = [], now = new Date(), enabled = true } = {}) {
  const bounded = (Array.isArray(records) ? records : []).slice(0, Math.min(LINEUP_SHADOW_ACCURACY_LIMIT, Math.max(1, Number(limit) || LINEUP_SHADOW_ACCURACY_LIMIT)));
  return {
    available: true,
    historyLimit: bounded.length,
    lookbackDays: Number(lookbackDays) || LINEUP_SHADOW_ACCURACY_LOOKBACK_DAYS,
    metrics: aggregateLineupShadowAccuracy(bounded),
    games: bounded,
    shadowEnabled: Boolean(enabled),
    autoFinalEnabled: false,
    current: buildLineupShadowCurrentStatus({ games, records: bounded, now, enabled })
  };
}
