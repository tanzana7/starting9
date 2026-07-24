-- 管理者が緊急時に特定試合のCron自動処理だけを停止するための制御です。
-- 日程や採点結果を複製せず、既存game_idを参照キーとして使います。
CREATE TABLE IF NOT EXISTS game_workflow_controls (
  game_id TEXT PRIMARY KEY NOT NULL,
  automation_paused INTEGER NOT NULL DEFAULT 0
    CHECK (automation_paused IN (0, 1)),
  paused_at TEXT NULL,
  resumed_at TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_workflow_controls_paused
  ON game_workflow_controls(automation_paused, updated_at);
