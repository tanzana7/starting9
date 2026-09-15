-- Diagnostic audit history has moved to the standalone AUDIT_DB binding.
-- Drop only the legacy core-D1 audit table and its dedicated indexes after the
-- new audit database has been provisioned and the worker cutover is verified.
DROP INDEX IF EXISTS idx_game_automation_v3_audit_event;
DROP INDEX IF EXISTS idx_game_automation_v3_audit_game;
DROP TABLE IF EXISTS game_automation_v3_audit;
