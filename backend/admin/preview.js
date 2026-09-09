/**
 * Admin preview response contracts.
 *
 * Authentication and input validation stay in auth-worker.js. This module only
 * makes the non-persistence guarantee explicit and reusable for preview routes.
 */

export function buildAdminReadOnlyPreviewMetadata() {
  return {
    previewOnly: true,
    productionWrite: false,
    writes: {
      database: false,
      predictions: false,
      ranking: false,
      publication: false
    }
  };
}
