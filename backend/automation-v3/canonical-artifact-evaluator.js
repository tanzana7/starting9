import { assessV3LineupArtifact } from "./lineup-artifacts.js";

const READY_REASON = "ARTIFACT_READY";

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function parseLineup(value) {
  return parseJson(value) || value;
}

function revisionIdentity(row) {
  const revisionId = text(row?.revision_id || row?.revisionId);
  if (revisionId) return revisionId;
  const gameId = text(row?.game_id || row?.gameId);
  const version = Number(row?.version);
  return gameId && Number.isInteger(version) ? `${gameId}:${version}` : null;
}

function validationResult(row, lineupCheck) {
  const raw = row?.validation_json ?? row?.validationJson;
  if (raw === null || raw === undefined || raw === "") return lineupCheck.ok;
  const validation = parseJson(raw);
  return Boolean(validation && validation.ok !== false && validation.valid !== false);
}

function emptyLineup(reason = "CANONICAL_FINAL_REVISION_MISSING") {
  return {
    canonicalFinalRevisionId: null,
    revisionExists: false,
    revisionValidated: false,
    lineupValid: false,
    lineupReady: false,
    reason
  };
}

function evaluateLineup({ canonicalLineup = null, lineupRevisions = [] } = {}) {
  const marker = text(canonicalLineup?.final_lineup_revision_id || canonicalLineup?.finalLineupRevisionId);
  if (!marker) return emptyLineup();
  const revision = (Array.isArray(lineupRevisions) ? lineupRevisions : [])
    .find((row) => revisionIdentity(row) === marker);
  if (!revision) return { ...emptyLineup("CANONICAL_FINAL_REVISION_NOT_FOUND"), canonicalFinalRevisionId: marker };
  const lineupCheck = assessV3LineupArtifact(parseLineup(revision.actual_lineup_json ?? revision.actualLineup));
  const revisionValidated = validationResult(revision, lineupCheck);
  if (!revisionValidated) {
    return {
      canonicalFinalRevisionId: marker,
      revisionExists: true,
      revisionValidated: false,
      lineupValid: false,
      lineupReady: false,
      reason: "CANONICAL_FINAL_REVISION_VALIDATION_INVALID"
    };
  }
  if (!lineupCheck.ok) {
    return {
      canonicalFinalRevisionId: marker,
      revisionExists: true,
      revisionValidated: true,
      lineupValid: false,
      lineupReady: false,
      reason: "CANONICAL_FINAL_LINEUP_INVALID"
    };
  }
  return {
    canonicalFinalRevisionId: marker,
    revisionExists: true,
    revisionValidated: true,
    lineupValid: true,
    lineupReady: true,
    reason: READY_REASON
  };
}

function evaluateScoring({ canonicalLineup = null, lineup = {}, activeScoringRevision = null } = {}) {
  const activeId = text(activeScoringRevision?.id);
  const lineupRevisionId = text(activeScoringRevision?.lineup_revision_id || activeScoringRevision?.lineupRevisionId);
  const canonicalRevisionId = text(lineup.canonicalFinalRevisionId);
  const lineupRevisionMatch = Boolean(activeId && lineupRevisionId && canonicalRevisionId && lineupRevisionId === canonicalRevisionId);
  const scoringStatusAvailable = canonicalLineup && Object.prototype.hasOwnProperty.call(canonicalLineup, "scoring_status");
  const completed = Boolean(activeScoringRevision
    && String(activeScoringRevision.status || "").toLowerCase() === "completed"
    && (!scoringStatusAvailable
      || (String(canonicalLineup.scoring_status || "").toLowerCase() === "scored" && Boolean(canonicalLineup.scored_at))));
  let reason = READY_REASON;
  if (!activeId) reason = "ACTIVE_SCORING_REVISION_MISSING";
  else if (!completed) reason = "SCORING_NOT_COMPLETED";
  else if (!lineupRevisionMatch) reason = "SCORING_LINEUP_REVISION_MISMATCH";
  else if (!lineup.lineupReady) reason = "CANONICAL_FINAL_LINEUP_NOT_READY";
  return {
    activeScoringRevisionId: activeId,
    completed,
    lineupRevisionMatch,
    valid: completed && lineupRevisionMatch && lineup.lineupReady === true,
    reason
  };
}

function evaluateRanking({ activeScoringRevision = null, rankingReflection = null, scoring = {} } = {}) {
  const activeId = text(activeScoringRevision?.id);
  const reflectedRevisionId = text(rankingReflection?.scoring_revision_id || rankingReflection?.scoringRevisionId);
  const scoringRevisionMatch = Boolean(activeId && reflectedRevisionId && activeId === reflectedRevisionId);
  const reflected = String(rankingReflection?.status || "").toLowerCase() === "reflected";
  let reason = READY_REASON;
  if (!rankingReflection) reason = "RANKING_REFLECTION_MISSING";
  else if (!activeId || !scoringRevisionMatch) reason = "RANKING_SCORING_REVISION_MISMATCH";
  else if (!reflected) reason = "RANKING_NOT_REFLECTED";
  else if (!scoring.valid) reason = "SCORING_ARTIFACT_NOT_READY";
  return {
    reflectedRevisionId,
    scoringRevisionMatch,
    reflected,
    valid: reflected && scoringRevisionMatch && scoring.valid === true,
    reason
  };
}

function evaluatePublication({ canonicalLineup = null, lineup = {}, scoring = {}, ranking = {} } = {}) {
  const publicationStatus = text(canonicalLineup?.publication_status || canonicalLineup?.publicationStatus);
  const publishedAt = text(canonicalLineup?.published_at || canonicalLineup?.publishedAt);
  const rankingRevisionMatch = ranking.valid === true;
  const currentArtifactValid = lineup.lineupReady === true && scoring.valid === true && ranking.valid === true;
  const published = publicationStatus === "published" && Boolean(publishedAt);
  let reason = READY_REASON;
  if (!published) reason = publicationStatus === "published" ? "PUBLICATION_TIMESTAMP_MISSING" : "PUBLICATION_NOT_COMPLETED";
  else if (!rankingRevisionMatch || !currentArtifactValid) reason = "PUBLICATION_CURRENT_ARTIFACT_MISMATCH";
  return {
    publicationStatus,
    publishedAt,
    rankingRevisionMatch,
    currentArtifactValid,
    valid: published && currentArtifactValid,
    reason
  };
}

function hasMismatch(lineup, scoring, ranking, publication) {
  return lineup.reason === "CANONICAL_FINAL_REVISION_NOT_FOUND"
    || lineup.reason === "CANONICAL_FINAL_REVISION_VALIDATION_INVALID"
    || lineup.reason === "CANONICAL_FINAL_LINEUP_INVALID"
    || scoring.reason === "SCORING_LINEUP_REVISION_MISMATCH"
    || ranking.reason === "RANKING_SCORING_REVISION_MISMATCH"
    || publication.reason === "PUBLICATION_CURRENT_ARTIFACT_MISMATCH";
}

export function evaluateCanonicalArtifacts({
  canonicalLineup = null,
  lineupRevisions = [],
  activeScoringRevision = null,
  rankingReflection = null
} = {}) {
  const lineup = evaluateLineup({ canonicalLineup, lineupRevisions });
  const scoring = evaluateScoring({ canonicalLineup, lineup, activeScoringRevision });
  const ranking = evaluateRanking({ activeScoringRevision, rankingReflection, scoring });
  const publication = evaluatePublication({ canonicalLineup, lineup, scoring, ranking });
  const lineupReady = lineup.lineupReady;
  const scoringReady = scoring.valid;
  const rankingReady = ranking.valid;
  const publicationReady = publication.valid;
  const fullyPublished = lineupReady && scoringReady && rankingReady && publicationReady;
  const artifactMismatch = hasMismatch(lineup, scoring, ranking, publication);
  const downstreamEvidence = Boolean(activeScoringRevision || rankingReflection || publication.publicationStatus || publication.publishedAt);
  const completedScoringForAnotherLineup = Boolean(activeScoringRevision
    && String(activeScoringRevision.status || "").toLowerCase() === "completed"
    && !scoring.valid);
  const reprocessingRequired = Boolean(
    (lineupReady && completedScoringForAnotherLineup)
    || (lineupReady && scoringReady && !rankingReady)
    || (rankingReady && publication.publicationStatus === "published" && !publicationReady)
    || (publication.publicationStatus === "published" && !fullyPublished)
  );
  return {
    available: true,
    evaluator: "canonical_artifact",
    version: 1,
    lineup,
    scoring,
    ranking,
    publication,
    aggregate: {
      lineupReady,
      scoringReady,
      rankingReady,
      publicationReady,
      fullyPublished,
      artifactMismatch,
      needsAttention: artifactMismatch || (downstreamEvidence && !fullyPublished && reprocessingRequired),
      reprocessingRequired
    }
  };
}

export function toCanonicalArtifactStageArtifacts(canonicalArtifacts) {
  if (canonicalArtifacts?.available !== true) return {};
  const canonical = canonicalArtifacts;
  return {
    lineup_finalize: {
      available: canonical.aggregate.lineupReady,
      valid: canonical.lineup.lineupValid,
      ready: canonical.aggregate.lineupReady,
      canonicalFinalRevisionId: canonical.lineup.canonicalFinalRevisionId,
      canonicalFinalRevisionValid: canonical.lineup.lineupValid,
      reason: canonical.lineup.reason
    },
    scoring: {
      available: canonical.aggregate.scoringReady,
      valid: canonical.scoring.valid,
      ready: canonical.aggregate.scoringReady,
      scoringRevisionId: canonical.scoring.activeScoringRevisionId,
      lineupRevisionMatch: canonical.scoring.lineupRevisionMatch,
      reason: canonical.scoring.reason
    },
    ranking_reflect: {
      available: canonical.aggregate.rankingReady,
      valid: canonical.ranking.valid,
      ready: canonical.aggregate.rankingReady,
      reflected: canonical.ranking.reflected,
      scoringRevisionId: canonical.scoring.activeScoringRevisionId,
      reflectedScoringRevisionId: canonical.ranking.reflectedRevisionId,
      revisionMatches: canonical.ranking.scoringRevisionMatch,
      reason: canonical.ranking.reason
    },
    publish: {
      available: canonical.aggregate.publicationReady,
      valid: canonical.publication.valid,
      ready: canonical.aggregate.publicationReady,
      published: canonical.publication.publicationStatus === "published",
      publishedAt: canonical.publication.publishedAt,
      revisionMatches: canonical.publication.rankingRevisionMatch,
      reason: canonical.publication.reason
    }
  };
}

async function first(db, sql, ...bindings) {
  return db.prepare(sql).bind(...bindings).first();
}

async function all(db, sql, ...bindings) {
  const result = await db.prepare(sql).bind(...bindings).all();
  return result?.results || [];
}

export async function readCanonicalArtifactFacts(db, internalGameId) {
  const id = text(internalGameId);
  if (!id) return { available: false, reason: "INTERNAL_GAME_ID_MISSING", errorCode: "INTERNAL_GAME_ID_MISSING" };
  try {
    const canonicalLineup = await first(db,
      "SELECT * FROM game_lineups WHERE internal_game_id = ?1 LIMIT 1", id);
    const lineupRevisions = await all(db,
      "SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 ORDER BY version DESC", id);
    const activeScoringRevision = await first(db,
      `SELECT id, internal_game_id, lineup_revision_id, status, revision_number, completed_at
         FROM game_scoring_revisions
        WHERE internal_game_id = ?1 AND is_active = 1
        ORDER BY revision_number DESC LIMIT 1`, id);
    const rankingReflection = await first(db,
      `SELECT id, internal_game_id, scoring_revision_id, ranking_update_revision, status, reflected_at
         FROM ranking_reflection_revisions
        WHERE internal_game_id = ?1
        ORDER BY ranking_update_revision DESC, id DESC LIMIT 1`, id);
    return {
      available: true,
      canonicalLineup,
      lineupRevisions,
      activeScoringRevision,
      rankingReflection,
      errorCode: null
    };
  } catch (error) {
    return {
      available: false,
      reason: "CANONICAL_ARTIFACT_READ_FAILED",
      errorCode: String(error?.code || "CANONICAL_ARTIFACT_READ_FAILED"),
      errorMessage: String(error?.message || "").slice(0, 240)
    };
  }
}

export async function evaluateCanonicalArtifactsFromDb(db, internalGameId) {
  const facts = await readCanonicalArtifactFacts(db, internalGameId);
  if (!facts.available) return { ...evaluateCanonicalArtifacts(), available: false, reason: facts.reason, errorCode: facts.errorCode };
  return { ...evaluateCanonicalArtifacts(facts), available: true, reason: null, errorCode: null };
}
