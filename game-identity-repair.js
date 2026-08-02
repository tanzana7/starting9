import { createScheduleGameIdentifiers, inferGameIdentifierType } from "./game-identity-registry.js";

const NON_GAME_SCOPE_PATTERN = /^(?:day-\d{4}-\d{2}-\d{2}|global|batch|test)(?:-|$)/i;
const REPAIRABLE_TABLES = Object.freeze([
  "predictions",
  "probable_starters",
  "game_roster_snapshots",
  "game_pregame_automation",
  "game_lineups",
  "ranking_games",
  "game_rescore_jobs"
]);

function text(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizedTeam(value) {
  return text(value).toLocaleLowerCase("en-US");
}

function normalizedStart(value) {
  const raw = text(value);
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// This is a deterministic identifier for a reviewed repair plan, not an
// authentication secret. The full plan hash below protects execution.
function stableRepairToken(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function hashGameIdentityRepairPlan(material) {
  const bytes = new TextEncoder().encode(stableJson(material));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isNonGameScope(value) {
  const candidate = text(value);
  return !candidate || NON_GAME_SCOPE_PATTERN.test(candidate);
}

function getScheduleIdentity(row) {
  return {
    gameDate: text(row?.game_date),
    startTime: normalizedStart(row?.start_at),
    homeTeam: normalizedTeam(row?.home_team),
    awayTeam: normalizedTeam(row?.away_team)
  };
}

function hasCompleteScheduleIdentity(row) {
  const identity = getScheduleIdentity(row);
  return Boolean(identity.gameDate && identity.startTime && identity.homeTeam && identity.awayTeam);
}

function isSameIdentity(left, right) {
  const a = getScheduleIdentity(left);
  const b = getScheduleIdentity(right);
  return a.gameDate === b.gameDate && a.startTime === b.startTime
    && a.homeTeam === b.homeTeam && a.awayTeam === b.awayTeam;
}

function getPlanIdentifiers(scheduleRow) {
  return createScheduleGameIdentifiers({
    gameId: text(scheduleRow.game_id),
    gameCode: text(scheduleRow.game_code),
    sourceGameKey: text(scheduleRow.source_game_key)
  }).map((identifier) => ({
    provider: identifier.provider,
    identifierType: identifier.identifierType,
    identifierValue: identifier.identifierValue
  })).filter((identifier) => identifier.identifierValue && !isNonGameScope(identifier.identifierValue));
}

function collectReferenceRows(tableRows, gameId) {
  const updates = [];
  for (const table of REPAIRABLE_TABLES) {
    const row = (tableRows?.[table] || []).find((candidate) => text(candidate?.game_id) === gameId);
    if (row && Number(row.row_count || 0) > 0) {
      updates.push({ table, legacyGameId: gameId, expectedCount: Number(row.row_count || 0) });
    }
  }
  return updates;
}

function findConflictsForGame(stateConflicts, gameId) {
  return (stateConflicts || []).filter((conflict) => String(conflict?.gameId || "").split(",").map(text).includes(gameId));
}

function classifyOrphan(reference) {
  const gameId = text(reference?.gameId);
  if (isNonGameScope(gameId)) {
    return { classification: "IGNORE_NON_GAME_SCOPE", reasonCodes: ["NON_GAME_SCOPE"], riskLevel: "none", requiresConfirmation: false };
  }
  return { classification: "OBSOLETE_ORPHAN", reasonCodes: ["INSUFFICIENT_METADATA"], riskLevel: "high", requiresConfirmation: true };
}

function createPlanMaterial({ classification, scheduleRow, targetInternalGameId, targetGameStatus = "", createInternalGame, identifiersToInsert, tableRowsToUpdate, reasonCodes, stateConflict }) {
  const identity = getScheduleIdentity(scheduleRow || {});
  return {
    classification,
    scheduleGameId: text(scheduleRow?.game_id),
    scheduleIdentity: identity,
    targetInternalGameId: text(targetInternalGameId),
    targetGameStatus: text(targetGameStatus),
    createInternalGame: Boolean(createInternalGame),
    identifiersToInsert: [...identifiersToInsert].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    tableRowsToUpdate: [...tableRowsToUpdate].sort((left, right) => left.table.localeCompare(right.table)),
    reasonCodes: [...new Set(reasonCodes)].sort(),
    stateConflict: Boolean(stateConflict)
  };
}

export async function buildGameIdentityRepairPreview({ scheduleRows = [], games = [], identifiers = [], tableRows = {}, stateConflicts = [], now = new Date() } = {}) {
  const repairPlans = [];
  const manualReviewItems = [];
  const safeAutoLinks = [];
  const safeInternalGameCreations = [];
  const linkedScheduleGames = scheduleRows.filter((row) => text(row.internal_game_id)).length;

  for (const scheduleRow of scheduleRows) {
    const gameId = text(scheduleRow?.game_id);
    if (isNonGameScope(gameId)) continue;
    if (text(scheduleRow.internal_game_id)) continue;

    const reasonCodes = [];
    const rowConflicts = findConflictsForGame(stateConflicts, gameId);
    const planIdentifiers = getPlanIdentifiers(scheduleRow);
    const identityComplete = hasCompleteScheduleIdentity(scheduleRow);
    const exactGames = identityComplete ? games.filter((game) => isSameIdentity(scheduleRow, {
      game_date: game.game_date,
      start_at: game.start_time,
      home_team: game.home_team,
      away_team: game.away_team
    })) : [];
    const sameDateAndTeams = identityComplete ? games.filter((game) => {
      const candidate = getScheduleIdentity({
        game_date: game.game_date,
        start_at: game.start_time,
        home_team: game.home_team,
        away_team: game.away_team
      });
      const current = getScheduleIdentity(scheduleRow);
      return candidate.gameDate === current.gameDate && candidate.homeTeam === current.homeTeam && candidate.awayTeam === current.awayTeam;
    }) : [];
    const sameDateAndStartDifferentTeams = identityComplete ? games.filter((game) => {
      const candidate = getScheduleIdentity({
        game_date: game.game_date,
        start_at: game.start_time,
        home_team: game.home_team,
        away_team: game.away_team
      });
      const current = getScheduleIdentity(scheduleRow);
      return candidate.gameDate === current.gameDate && candidate.startTime === current.startTime
        && (candidate.homeTeam !== current.homeTeam || candidate.awayTeam !== current.awayTeam);
    }) : [];
    const identifierCandidates = new Set();
    const identifierConflict = new Set();
    for (const plannedIdentifier of planIdentifiers) {
      for (const registered of identifiers) {
        if (text(registered.identifier_type) !== plannedIdentifier.identifierType || text(registered.identifier_value) !== plannedIdentifier.identifierValue) continue;
        identifierCandidates.add(text(registered.internal_game_id));
      }
    }
    for (const candidate of identifierCandidates) {
      if (candidate) identifierConflict.add(candidate);
    }
    const gameCandidates = new Set(exactGames.map((game) => text(game.internal_game_id)).filter(Boolean));
    const candidates = new Set([...identifierConflict, ...gameCandidates]);
    const hasDifferentGameCode = exactGames.some((game) => text(game.game_code) && text(scheduleRow.game_code) && text(game.game_code) !== text(scheduleRow.game_code));
    const identifierPointsToDifferentIdentity = [...identifierConflict].some((internalGameId) => !exactGames.some((game) => text(game.internal_game_id) === internalGameId));

    let classification = "MANUAL_REVIEW";
    let targetInternalGameId = "";
    let createInternalGame = false;
    if (!identityComplete) reasonCodes.push("INSUFFICIENT_METADATA");
    if (exactGames.length > 1) reasonCodes.push("DOUBLEHEADER_RISK");
    if (!exactGames.length && sameDateAndTeams.length) reasonCodes.push("START_TIME_MISMATCH");
    if (sameDateAndStartDifferentTeams.length) reasonCodes.push("TEAM_MISMATCH");
    if (candidates.size > 1) reasonCodes.push("MULTIPLE_INTERNAL_CANDIDATES");
    if (hasDifferentGameCode || identifierPointsToDifferentIdentity) reasonCodes.push("GAME_CODE_CONFLICT");
    if (rowConflicts.length) reasonCodes.push("STATE_CONFLICT");
    if (planIdentifiers.some((entry) => !entry.identifierValue)) reasonCodes.push("INSUFFICIENT_METADATA");

    if (!reasonCodes.length && candidates.size === 1) {
      classification = "SAFE_AUTO_LINK";
      targetInternalGameId = [...candidates][0];
      reasonCodes.push("UNIQUE_SCHEDULE_MATCH", "INTERNAL_GAME_ALREADY_EXISTS");
      if (planIdentifiers.some((entry) => entry.identifierType === "npb_game_code")) reasonCodes.push("UNIQUE_NPB_GAME_CODE");
    } else if (!reasonCodes.length && candidates.size === 0) {
      classification = "SAFE_CREATE_INTERNAL_GAME";
      createInternalGame = true;
      reasonCodes.push("UNIQUE_SCHEDULE_MATCH", "INTERNAL_GAME_CREATION_REQUIRED");
    }
    if (classification === "MANUAL_REVIEW" && !reasonCodes.length) reasonCodes.push("INSUFFICIENT_METADATA");

    const material = createPlanMaterial({
      classification,
      scheduleRow,
      targetInternalGameId,
      targetGameStatus: exactGames.find((game) => text(game.internal_game_id) === targetInternalGameId)?.game_status || scheduleRow.game_status || "",
      createInternalGame,
      identifiersToInsert: planIdentifiers,
      tableRowsToUpdate: collectReferenceRows(tableRows, gameId),
      reasonCodes,
      stateConflict: rowConflicts.length > 0
    });
    const planHash = await hashGameIdentityRepairPlan(material);
    const plan = {
      repairId: `gir-${stableRepairToken(`${material.scheduleGameId}|${material.classification}|${material.scheduleIdentity.startTime}`)}`,
      ...material,
      confidence: classification === "SAFE_AUTO_LINK" ? "high" : classification === "SAFE_CREATE_INTERNAL_GAME" ? "medium" : "low",
      riskLevel: classification.startsWith("SAFE_") ? "low" : "high",
      requiresConfirmation: true,
      planHash,
      generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      rollbackData: {
        addedIdentifiers: [],
        linkedRows: [],
        createdInternalGame: false,
        workflowStateCorrection: null
      }
    };
    repairPlans.push(plan);
    if (classification === "SAFE_AUTO_LINK") safeAutoLinks.push(plan);
    else if (classification === "SAFE_CREATE_INTERNAL_GAME") safeInternalGameCreations.push(plan);
    else manualReviewItems.push(plan);
  }

  const orphanReferences = new Map();
  for (const rows of Object.values(tableRows || {})) {
    for (const row of rows || []) {
      const gameId = text(row?.game_id);
      if (!gameId || orphanReferences.has(gameId)) continue;
      if (scheduleRows.some((schedule) => text(schedule.game_id) === gameId)) continue;
      orphanReferences.set(gameId, row);
    }
  }
  const ignoredNonGameScopes = [];
  const obsoleteOrphans = [];
  for (const reference of orphanReferences.values()) {
    const classification = classifyOrphan({ gameId: reference.game_id });
    const item = {
      gameId: text(reference.game_id),
      rowCount: Number(reference.row_count || 0),
      firstSeenAt: reference.first_seen_at || "",
      lastSeenAt: reference.last_seen_at || "",
      ...classification
    };
    if (classification.classification === "IGNORE_NON_GAME_SCOPE") ignoredNonGameScopes.push(item);
    else obsoleteOrphans.push(item);
  }
  const scheduleGames = scheduleRows.length;
  const projectedLinked = linkedScheduleGames + safeAutoLinks.length + safeInternalGameCreations.length;
  return {
    summary: {
      scannedRows: scheduleRows.length + Object.values(tableRows || {}).flat().length,
      scheduleGames,
      linkedScheduleGames,
      unlinkedScheduleGames: Math.max(0, scheduleGames - linkedScheduleGames),
      safeAutoLinkCount: safeAutoLinks.length,
      safeCreateCount: safeInternalGameCreations.length,
      manualReviewCount: manualReviewItems.length,
      ignoredScopeCount: ignoredNonGameScopes.length,
      obsoleteOrphanCount: obsoleteOrphans.length,
      stateConflictCount: stateConflicts.length,
      projectedCoverage: scheduleGames ? projectedLinked / scheduleGames : 0,
      projectedLegacyIdsWithoutInternalGameId: Math.max(0, scheduleGames - projectedLinked)
    },
    safeAutoLinks,
    safeInternalGameCreations,
    manualReviewItems,
    ignoredNonGameScopes,
    obsoleteOrphans,
    stateConflicts,
    repairPlans
  };
}

export { REPAIRABLE_TABLES };
