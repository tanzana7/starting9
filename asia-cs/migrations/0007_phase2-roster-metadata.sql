-- Migration number: 0007 	 2026-10-02T09:06:01.449Z
-- Phase 2 stores roster metadata without changing the formal lineup contract.
-- Existing Phase 1 players remain valid with an empty position.
ALTER TABLE players ADD COLUMN position TEXT NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN bat TEXT;
ALTER TABLE players ADD COLUMN throw TEXT;
