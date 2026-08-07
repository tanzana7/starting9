-- Phase 3: game_automation_health is retired.
--
-- The current V3 runtime records execution state in game_automation_v3_state,
-- game_jobs_v3, and game_automation_v3_audit. The old health row was only
-- consumed by retired V1/V2 readiness and prediction-target switching paths.
-- No current runtime, V3 admin, public API, or required historical read uses it.
DROP TABLE IF EXISTS game_automation_health;
