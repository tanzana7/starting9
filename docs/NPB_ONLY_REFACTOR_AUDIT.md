# NPB-only refactor audit

Phase A-1 removes the second product surface and returns public/admin routing to one NPB path. This document records follow-up simplification only; none of these items are implemented in Phase A-1.

## Phase A-2 candidates

- Recheck edition-era shell and state seams after their removal; collapse any wrappers that now have one caller.
- Review single-purpose helpers whose only remaining branch became unconditional after product-boundary removal.
- Audit stale redirects, query compatibility, and deployment configuration for paths that no longer have a runtime target.
- Measure duplicated public/admin state before consolidating it; preserve current user-visible behavior and authorization boundaries.
- Split or reduce oversized frontend modules only with runtime behavior tests and a bounded change surface.
- Remove wrappers only after repository-wide caller and asset-reference checks.
- Reassess tests that only asserted the removed product surface; preserve generic behavior coverage by rewriting fixtures around NPB behavior.
- Simplify deployment and CI configuration only after confirming it no longer participates in production NPB release workflows.

## Out of scope for Phase A-1

No public behavior, scoring, schedule, lineup, prediction, ranking, publication, or automation redesign is authorized by this audit.
