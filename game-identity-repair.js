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

// Compact NPB-style IDs do not include a start time.  They are eligible for
// automatic linking only after their team codes resolve to one unique schedule
// row on that date; unknown codes deliberately remain manual review items.
const COMPACT_TEAM_CODES = Object.freeze({
  f: "fighters", e: "eagles", m: "marines", l: "lions", b: "buffaloes", h: "hawks",
  g: "giants", t: "tigers", d: "dragons", c: "carp", db: "baystars", s: "swallows"
});

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

function getCompactIdentifier(gameId) {
  const match = /^(\d{4}-\d{2}-\d{2})-([a-z]{1,2})-([a-z]{1,2})-(\d+)$/i.exec(text(gameId));
  if (!match) return null;
  const homeTeam = COMPACT_TEAM_CODES[match[2].toLocaleLowerCase("en-US")];
  const awayTeam = COMPACT_TEAM_CODES[match[3].toLocaleLowerCase("en-US")];
  if (!homeTeam || !awayTeam) return null;
  return {
    gameId: text(gameId),
    gameDate: match[1],
    homeTeam,
    awayTeam,
    gameCode: `${match[2].toLocaleLowerCase("en-US")}-${match[3].toLocaleLowerCase("en-US")}-${match[4]}`
  };
}

function rowUnlinkedCount(row) {
  if (Object.prototype.hasOwnProperty.call(row || {}, "unlinked_row_count")) {
    return Number(row.unlinked_row_count || 0);
  }
  return Number(row?.row_count || 0);
}

function rowInternalGameIds(row) {
  return String(row?.internal_game_ids || row?.internal_game_id || "")
    .split(",").map(text).filter(Boolean);
}

function referencesForGameId(tableRows, gameId) {
  const references = [];
  for (const [table, rows] of Object.entries(tableRows || {})) {
    const row = (rows || []).find((candidate) => text(candidate?.game_id) === gameId);
    if (row) references.push({ table, row });
  }
  return references;
}

function collectReferenceRows(tableRows, gameId) {
  const updates = [];
  for (const table of REPAIRABLE_TABLES) {
    const row = (tableRows?.[table] || []).find((candidate) => text(candidate?.game_id) === gameId);
    const expectedCount = rowUnlinkedCount(row);
    if (row && expectedCount > 0) {
      updates.push({ table, legacyGameId: gameId, expectedCount });
    }
  }
  return updates;
}

function uniqueTableUpdates(...groups) {
  const updates = new Map();
  for (const row of groups.flat()) {
    const key = `${row.table}\u0000${row.legacyGameId}`;
    if (!updates.has(key)) updates.set(key, row);
  }
  return [...updates.values()];
}

function identifierInternalGameIds(identifiers, identifierType, identifierValue) {
  return new Set((identifiers || [])
    .filter((row) => text(row?.identifier_type) === identifierType && text(row?.identifier_value) === identifierValue)
    .map((row) => text(row?.internal_game_id)).filter(Boolean));
}

function hasReferenceInternalGameIdConflict(tableRows, gameId, targetInternalGameId = "") {
  return referencesForGameId(tableRows, gameId).some(({ row }) => rowInternalGameIds(row)
    .some((internalGameId) => internalGameId !== targetInternalGameId));
}

function hasReferenceStartTimeConflict(tableRows, gameId, scheduleRow) {
  const scheduleStart = normalizedStart(scheduleRow?.start_at);
  if (!scheduleStart) return true;
  return referencesForGameId(tableRows, gameId).some(({ row }) => {
    const referenceStart = normalizedStart(row?.start_at);
    return Boolean(referenceStart && referenceStart !== scheduleStart);
  });
}

function collectTableGameIds(tableRows) {
  const gameIds = new Set();
  for (const rows of Object.values(tableRows || {})) {
    for (const row of rows || []) {
      const gameId = text(row?.game_id);
      if (gameId && !isNonGameScope(gameId)) gameIds.add(gameId);
    }
  }
  return gameIds;
}

function collectUnlinkedTableGameIds(tableRows) {
  const gameIds = new Set();
  for (const rows of Object.values(tableRows || {})) {
    for (const row of rows || []) {
      const gameId = text(row?.game_id);
      if (gameId && !isNonGameScope(gameId) && rowUnlinkedCount(row) > 0) gameIds.add(gameId);
    }
  }
  return gameIds;
}

function hasPotentialCompactMatch(scheduleRow, compactGameIds) {
  const scheduleIdentity = getScheduleIdentity(scheduleRow);
  return (compactGameIds || []).some((gameId) => {
    const compact = getCompactIdentifier(gameId);
    return compact && compact.gameDate === scheduleIdentity.gameDate
      && compact.homeTeam === scheduleIdentity.homeTeam && compact.awayTeam === scheduleIdentity.awayTeam;
  });
}

function planLegacyGameIds(plan) {
  return [...new Set([
    ...(plan?.legacyGameIds || []),
    plan?.compactGameId,
    plan?.scheduleGameId
  ].map(text).filter(Boolean))];
}

function addIdsToSet(target, items) {
  for (const item of items || []) target.add(item);
}

function setIntersection(left, right) {
  return [...left].filter((value) => right.has(value)).sort();
}

function createProjectedLegacyIdBreakdown(gameIds, tableRows, classifications, reasonCodesByGameId) {
  return [...gameIds].sort().map((gameId) => {
    const tableRowsWithCounts = referencesForGameId(tableRows, gameId)
      .map(({ table, row }) => ({ table, count: rowUnlinkedCount(row) }))
      .filter((row) => row.count > 0)
      .sort((left, right) => left.table.localeCompare(right.table));
    const classification = classifications.get(gameId) || "OBSOLETE_ORPHAN";
    const reasonCodes = reasonCodesByGameId.get(gameId) || (classification === "MANUAL_REVIEW"
      ? ["MANUAL_REVIEW_REQUIRED"]
      : ["NO_SAFE_REPAIR_PLAN"]);
    return {
      gameId,
      classification,
      tableCount: tableRowsWithCounts.length,
      tableRows: tableRowsWithCounts,
      reasonCodes
    };
  });
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

function createPlanMaterial({ classification, scheduleRow, targetInternalGameId, targetGameStatus = "", createInternalGame, identifiersToInsert, tableRowsToUpdate, legacyGameIds = [], reasonCodes, stateConflict }) {
  const identity = getScheduleIdentity(scheduleRow || {});
  return {
    classification,
    scheduleGameId: text(scheduleRow?.game_id),
    scheduleIdentity: identity,
    targetInternalGameId: text(targetInternalGameId),
    targetGameStatus: text(targetGameStatus),
    createInternalGame: Boolean(createInternalGame),
    legacyGameIds: [...new Set(legacyGameIds.map(text).filter(Boolean))].sort(),
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
  const scheduleGameIds = new Set(scheduleRows.map((row) => text(row?.game_id)).filter(Boolean));
  const compactOrphanIds = [...collectTableGameIds(tableRows)].filter((gameId) => {
    return !scheduleGameIds.has(gameId) && inferGameIdentifierType(gameId) === "legacy_compact_game_id";
  });
  const compactReviewIds = new Set();
  const safeCompactIds = new Set();

  for (const scheduleRow of scheduleRows) {
    const gameId = text(scheduleRow?.game_id);
    if (isNonGameScope(gameId)) continue;
    const existingScheduleInternalGameId = text(scheduleRow.internal_game_id);
    if (existingScheduleInternalGameId && !hasPotentialCompactMatch(scheduleRow, compactOrphanIds)) continue;

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
    const sameScheduleCard = identityComplete ? scheduleRows.filter((candidate) => {
      const current = getScheduleIdentity(scheduleRow);
      const candidateIdentity = getScheduleIdentity(candidate);
      return candidateIdentity.gameDate === current.gameDate
        && candidateIdentity.homeTeam === current.homeTeam && candidateIdentity.awayTeam === current.awayTeam;
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
    if (existingScheduleInternalGameId) gameCandidates.add(existingScheduleInternalGameId);
    const candidates = new Set([...identifierConflict, ...gameCandidates]);
    const hasDifferentGameCode = exactGames.some((game) => text(game.game_code) && text(scheduleRow.game_code) && text(game.game_code) !== text(scheduleRow.game_code));
    const identifierPointsToDifferentIdentity = [...identifierConflict].some((internalGameId) => !exactGames.some((game) => text(game.internal_game_id) === internalGameId));

    let classification = "MANUAL_REVIEW";
    let targetInternalGameId = "";
    let createInternalGame = false;
    if (!identityComplete) reasonCodes.push("INSUFFICIENT_METADATA");
    if (exactGames.length > 1) reasonCodes.push("DOUBLEHEADER_RISK");
    if (sameScheduleCard.length > 1) reasonCodes.push("DOUBLEHEADER_RISK");
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

    const compactIdsForPlan = [];
    const compactIdentifiers = [];
    const compactTableUpdates = [];
    if (classification.startsWith("SAFE_")) {
      for (const compactGameId of compactOrphanIds) {
        const compact = getCompactIdentifier(compactGameId);
        if (!compact) continue;
        const current = getScheduleIdentity(scheduleRow);
        if (compact.gameDate !== current.gameDate || compact.homeTeam !== current.homeTeam || compact.awayTeam !== current.awayTeam) continue;

        const compactReasonCodes = [];
        const exactScheduleRows = scheduleRows.filter((candidate) => {
          const identity = getScheduleIdentity(candidate);
          return identity.gameDate === compact.gameDate && identity.homeTeam === compact.homeTeam && identity.awayTeam === compact.awayTeam;
        });
        const reverseScheduleRows = scheduleRows.filter((candidate) => {
          const identity = getScheduleIdentity(candidate);
          return identity.gameDate === compact.gameDate && identity.homeTeam === compact.awayTeam && identity.awayTeam === compact.homeTeam;
        });
        const compactIdentifiersRegistered = identifierInternalGameIds(identifiers, "legacy_compact_game_id", compact.gameId);
        const plannedTarget = targetInternalGameId;
        if (exactScheduleRows.length !== 1) compactReasonCodes.push("DOUBLEHEADER_RISK");
        if (reverseScheduleRows.length) compactReasonCodes.push("REVERSE_HOME_AWAY_RISK");
        if (text(scheduleRow.game_code) && text(scheduleRow.game_code).toLocaleLowerCase("en-US") !== compact.gameCode) compactReasonCodes.push("GAME_CODE_CONFLICT");
        if (compactIdentifiersRegistered.size > 1 || [...compactIdentifiersRegistered].some((candidate) => candidate !== plannedTarget)) {
          compactReasonCodes.push("GAME_IDENTIFIER_CONFLICT");
        }
        if (hasReferenceInternalGameIdConflict(tableRows, compact.gameId, plannedTarget)) compactReasonCodes.push("TABLE_INTERNAL_GAME_ID_CONFLICT");
        if (hasReferenceStartTimeConflict(tableRows, compact.gameId, scheduleRow)) compactReasonCodes.push("START_TIME_MISMATCH");

        if (compactReasonCodes.length) {
          compactReviewIds.add(compact.gameId);
          manualReviewItems.push({
            classification: "MANUAL_REVIEW",
            compactGameId: compact.gameId,
            scheduleGameId: gameId,
            reasonCodes: [...new Set(compactReasonCodes)].sort(),
            riskLevel: "high",
            requiresConfirmation: true
          });
          continue;
        }
        compactIdsForPlan.push(compact.gameId);
        safeCompactIds.add(compact.gameId);
        compactIdentifiers.push({ provider: "starting9", identifierType: "legacy_compact_game_id", identifierValue: compact.gameId });
        compactTableUpdates.push(collectReferenceRows(tableRows, compact.gameId));
      }
    }

    const material = createPlanMaterial({
      classification,
      scheduleRow,
      targetInternalGameId,
      targetGameStatus: exactGames.find((game) => text(game.internal_game_id) === targetInternalGameId)?.game_status || scheduleRow.game_status || "",
      createInternalGame,
      identifiersToInsert: [...planIdentifiers, ...compactIdentifiers],
      tableRowsToUpdate: uniqueTableUpdates(collectReferenceRows(tableRows, gameId), ...compactTableUpdates),
      legacyGameIds: [gameId, ...compactIdsForPlan],
      reasonCodes: [...reasonCodes, ...(compactIdsForPlan.length ? ["UNIQUE_COMPACT_LEGACY_MATCH"] : [])],
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

  // A compact ID whose only same-day team match is reversed must never be
  // silently reported as a generic orphan: it needs an explicit operator
  // decision because home/away changes the game identity.
  for (const compactGameId of compactOrphanIds) {
    if (safeCompactIds.has(compactGameId) || compactReviewIds.has(compactGameId)) continue;
    const compact = getCompactIdentifier(compactGameId);
    if (!compact) continue;
    const reverseScheduleRows = scheduleRows.filter((candidate) => {
      const identity = getScheduleIdentity(candidate);
      return identity.gameDate === compact.gameDate
        && identity.homeTeam === compact.awayTeam && identity.awayTeam === compact.homeTeam;
    });
    if (!reverseScheduleRows.length) continue;
    compactReviewIds.add(compactGameId);
    manualReviewItems.push({
      classification: "MANUAL_REVIEW",
      compactGameId,
      relatedScheduleGameId: text(reverseScheduleRows[0]?.game_id),
      reasonCodes: ["REVERSE_HOME_AWAY_RISK"],
      riskLevel: "high",
      requiresConfirmation: true
    });
  }

  const orphanReferences = new Map();
  const safeAutoLinkLegacyIds = new Set();
  const safeCreateLegacyIds = new Set();
  const safeLegacyIds = new Set();
  const manualReviewLegacyIds = new Set();
  const reasonCodesByGameId = new Map();
  for (const plan of safeAutoLinks) addIdsToSet(safeAutoLinkLegacyIds, planLegacyGameIds(plan));
  for (const plan of safeInternalGameCreations) addIdsToSet(safeCreateLegacyIds, planLegacyGameIds(plan));
  addIdsToSet(safeLegacyIds, safeAutoLinkLegacyIds);
  addIdsToSet(safeLegacyIds, safeCreateLegacyIds);
  for (const plan of manualReviewItems) {
    const gameIds = planLegacyGameIds(plan);
    addIdsToSet(manualReviewLegacyIds, gameIds);
    for (const gameId of gameIds) reasonCodesByGameId.set(gameId, plan.reasonCodes || ["MANUAL_REVIEW_REQUIRED"]);
  }
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
  const ignoredLegacyIds = new Set();
  const obsoleteLegacyIds = new Set();
  for (const reference of orphanReferences.values()) {
    const gameId = text(reference.game_id);
    if (safeLegacyIds.has(gameId) || manualReviewLegacyIds.has(gameId)) continue;
    const classification = classifyOrphan({ gameId: reference.game_id });
    const item = {
      gameId,
      rowCount: Number(reference.row_count || 0),
      firstSeenAt: reference.first_seen_at || "",
      lastSeenAt: reference.last_seen_at || "",
      ...classification
    };
    if (compactReviewIds.has(item.gameId)) continue;
    if (classification.classification === "IGNORE_NON_GAME_SCOPE") {
      ignoredNonGameScopes.push(item);
      ignoredLegacyIds.add(item.gameId);
    } else {
      obsoleteOrphans.push(item);
      obsoleteLegacyIds.add(item.gameId);
      reasonCodesByGameId.set(item.gameId, item.reasonCodes || ["NO_SAFE_REPAIR_PLAN"]);
    }
  }
  const scheduleGames = scheduleRows.length;
  const projectedLinked = linkedScheduleGames + safeAutoLinks.length + safeInternalGameCreations.length;
  const projectedSafeLegacyIds = new Set([...safeAutoLinks, ...safeInternalGameCreations]
    .flatMap((plan) => plan.legacyGameIds || [plan.scheduleGameId]));
  const unlinkedScheduleIds = new Set(scheduleRows
    .filter((row) => !text(row?.internal_game_id) && !isNonGameScope(row?.game_id))
    .map((row) => text(row.game_id)));
  const unlinkedAllTableIds = collectUnlinkedTableGameIds(tableRows);
  const unlinkedAllLegacyIds = new Set([...unlinkedScheduleIds, ...unlinkedAllTableIds]);
  const projectedIds = [...unlinkedAllLegacyIds].filter((gameId) => !projectedSafeLegacyIds.has(gameId));
  const projectedScheduleIds = [...unlinkedScheduleIds].filter((gameId) => !projectedSafeLegacyIds.has(gameId));
  const projectedCompactIds = projectedIds.filter((gameId) => inferGameIdentifierType(gameId) === "legacy_compact_game_id");
  const projectedDescriptiveIds = projectedIds.filter((gameId) => inferGameIdentifierType(gameId) === "descriptive_game_id");
  const classifications = new Map();
  for (const gameId of safeAutoLinkLegacyIds) classifications.set(gameId, "SAFE_AUTO_LINK");
  for (const gameId of safeCreateLegacyIds) classifications.set(gameId, "SAFE_CREATE_INTERNAL_GAME");
  for (const gameId of manualReviewLegacyIds) classifications.set(gameId, "MANUAL_REVIEW");
  for (const gameId of ignoredLegacyIds) classifications.set(gameId, "IGNORE_NON_GAME_SCOPE");
  for (const gameId of obsoleteLegacyIds) classifications.set(gameId, "OBSOLETE_ORPHAN");
  const safeAndObsolete = setIntersection(safeLegacyIds, obsoleteLegacyIds);
  const safeAutoLinkAndSafeCreate = setIntersection(safeAutoLinkLegacyIds, safeCreateLegacyIds);
  const safeAndManualReview = setIntersection(safeLegacyIds, manualReviewLegacyIds);
  const manualReviewAndObsolete = setIntersection(manualReviewLegacyIds, obsoleteLegacyIds);
  const ignoreAndOther = setIntersection(ignoredLegacyIds, new Set([
    ...safeLegacyIds, ...manualReviewLegacyIds, ...obsoleteLegacyIds
  ]));
  const repairPlanAndObsolete = setIntersection(new Set(repairPlans.flatMap(planLegacyGameIds)), obsoleteLegacyIds);
  const classificationIntegrity = {
    valid: !safeAndObsolete.length && !safeAutoLinkAndSafeCreate.length && !safeAndManualReview.length && !manualReviewAndObsolete.length
      && !ignoreAndOther.length && !repairPlanAndObsolete.length,
    safeAndObsolete,
    safeAutoLinkAndSafeCreate,
    safeAndManualReview,
    manualReviewAndObsolete,
    ignoreAndOther,
    repairPlanAndObsolete
  };
  const projectedAllTableLegacyIdBreakdown = createProjectedLegacyIdBreakdown(projectedIds, tableRows, classifications, reasonCodesByGameId);
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
      // Kept for API compatibility. It was schedule-only, which is why it can
      // be zero while compact IDs remain unlinked in related tables.
      projectedLegacyIdsWithoutInternalGameId: projectedScheduleIds.length,
      projectedScheduleLegacyIdsWithoutInternalGameId: projectedScheduleIds.length,
      projectedAllTableLegacyIdsWithoutInternalGameId: projectedIds.length,
      projectedCompactIdsWithoutInternalGameId: projectedCompactIds.length,
      projectedDescriptiveIdsWithoutInternalGameId: projectedDescriptiveIds.length,
      projectedAllTableLegacyIdBreakdown
    },
    safeAutoLinks,
    safeInternalGameCreations,
    manualReviewItems,
    ignoredNonGameScopes,
    obsoleteOrphans,
    stateConflicts,
    repairPlans,
    classificationIntegrity
  };
}

export { REPAIRABLE_TABLES };
