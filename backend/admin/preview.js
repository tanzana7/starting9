/**
 * Admin preview response contracts.
 *
 * Authentication and input validation stay in auth-worker.js. This module only
 * makes the non-persistence guarantee explicit and reusable for preview routes.
 */

export function buildAdminReadOnlyPreviewMetadata({ fixtureMode = false, fixtureKey = null } = {}) {
  return {
    previewOnly: true,
    fixtureMode: Boolean(fixtureMode),
    fixtureKey: fixtureMode ? fixtureKey : null,
    productionWrite: false,
    writes: {
      database: false,
      predictions: false,
      ranking: false,
      publication: false
    }
  };
}
