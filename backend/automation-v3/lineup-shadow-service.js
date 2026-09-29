const SHADOW_BEFORE_START_MS = 2 * 60 * 60 * 1000;
const SHADOW_AFTER_START_MS = 24 * 60 * 60 * 1000;
const SHADOW_RETRY_INTERVAL_MS = 5 * 60 * 1000;

import { normalizeScoringPosition } from "../domain/scoring-position.js";

function text(value) {
  return String(value ?? "").trim();
}

export function isShadowLineupRevision(row) {
  const raw = row?.validation_json ?? row?.validationJson;
  if (!raw) return false;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.shadowMode === true;
  } catch {
    return false;
  }
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isLineupShadowEnabled(env = {}) {
  return String(env?.ENABLE_LINEUP_SHADOW || "").trim().toLowerCase() === "true";
}

export function isLineupShadowDue(target = {}, now = new Date()) {
  const start = asDate(target.startAt || target.start_time);
  const current = asDate(now);
  if (!start || !current) return { due: false, reasonCode: "SHADOW_TIME_UNAVAILABLE" };
  if (current.getTime() < start.getTime() - SHADOW_BEFORE_START_MS) {
    return { due: false, reasonCode: "SHADOW_BEFORE_WINDOW" };
  }
  if (current.getTime() > start.getTime() + SHADOW_AFTER_START_MS) {
    return { due: false, reasonCode: "SHADOW_AFTER_WINDOW" };
  }
  return { due: true, reasonCode: "SHADOW_WITHIN_WINDOW" };
}

export function nextLineupShadowRetryAt(observation = {}, now = new Date()) {
  const current = asDate(now);
  if (!current) return null;
  if (["verified", "manual_final_exists", "cancelled", "no_game"].includes(text(observation.status))) return null;
  return new Date(current.getTime() + SHADOW_RETRY_INTERVAL_MS).toISOString();
}

export function shouldRetryLineupShadow(observation = {}, now = new Date()) {
  const status = text(observation.status);
  if (["verified", "manual_final_exists", "cancelled", "no_game"].includes(status)) return false;
  const nextRetryAt = asDate(observation.nextRetryAt);
  const current = asDate(now);
  return !nextRetryAt || !current || nextRetryAt.getTime() <= current.getTime();
}

function normalizedLineup(lineup) {
  return (Array.isArray(lineup) ? lineup : [])
    .map((row) => ({
      battingOrder: Number(row?.battingOrder ?? row?.batting_order ?? row?.order),
      playerId: text(row?.playerId ?? row?.player_id),
      playerName: text(row?.playerName ?? row?.player_name ?? row?.name),
      position: normalizeScoringPosition(row?.position)
    }))
    .sort((left, right) => left.battingOrder - right.battingOrder);
}

function playerIdentity(row) {
  return text(row?.playerId);
}

export function compareShadowLineupToManual(shadowLineup, manualLineup) {
  const shadow = normalizedLineup(shadowLineup);
  const manual = normalizedLineup(manualLineup);
  const max = Math.max(shadow.length, manual.length);
  const differences = [];
  for (let index = 0; index < max; index += 1) {
    const left = shadow[index] || {};
    const right = manual[index] || {};
    const samePlayer = Boolean(playerIdentity(left) && playerIdentity(right) && playerIdentity(left) === playerIdentity(right));
    const samePosition = Boolean(left.position && right.position && left.position === right.position);
    const sameOrder = left.battingOrder === right.battingOrder;
    if (!samePlayer || !samePosition || !sameOrder) {
      differences.push({
        battingOrder: right.battingOrder || left.battingOrder || index + 1,
        shadow: left,
        manual: right,
        playerMismatch: !samePlayer,
        positionMismatch: !samePosition,
        battingOrderMismatch: !sameOrder
      });
    }
  }
  const shadowPlayers = shadow.map(playerIdentity).filter(Boolean);
  const manualPlayers = manual.map(playerIdentity).filter(Boolean);
  const playerMatch = shadow.length === manual.length
    && shadowPlayers.length === shadow.length
    && manualPlayers.length === manual.length
    && new Set(shadowPlayers).size === shadowPlayers.length
    && new Set(manualPlayers).size === manualPlayers.length
    && shadowPlayers.every((playerId) => new Set(manualPlayers).has(playerId));
  const battingOrderMatch = shadow.length === manual.length
    && shadow.every((row, index) => playerIdentity(row) && playerIdentity(row) === playerIdentity(manual[index])
      && row.battingOrder === manual[index]?.battingOrder);
  const positionMatch = shadow.length === manual.length
    && shadow.every((row, index) => row.position && row.position === manual[index]?.position);
  return {
    exactMatch: playerMatch && battingOrderMatch && positionMatch,
    playerMatch,
    battingOrderMatch,
    positionMatch,
    differences,
    differenceCount: differences.length,
    shadowCount: shadow.length,
    manualCount: manual.length
  };
}

export function buildLineupShadowObservation({
  status = "waiting", source = "official", fetchedAt = null, playerCount = 0,
  validationStatus = null, reasonCode = null, nextRetryAt = null, comparison = null
} = {}) {
  return {
    status: text(status) || "waiting",
    source: text(source) || "official",
    fetchedAt: fetchedAt || null,
    playerCount: Number.isFinite(Number(playerCount)) ? Number(playerCount) : 0,
    validationStatus: validationStatus || null,
    reasonCode: reasonCode || null,
    nextRetryAt: nextRetryAt || null,
    comparison: comparison || null
  };
}

export const LINEUP_SHADOW_CONSTANTS = Object.freeze({
  beforeStartMs: SHADOW_BEFORE_START_MS,
  afterStartMs: SHADOW_AFTER_START_MS,
  retryIntervalMs: SHADOW_RETRY_INTERVAL_MS
});
