-- 管理者がCronによる正式スタメンの自動承認を停止できる、全試合共通の運用設定です。
-- 行が未作成の場合はWorker側で有効として扱うため、既存環境も既定で自動承認になります。
CREATE TABLE IF NOT EXISTS automation_settings (
  setting_key TEXT PRIMARY KEY NOT NULL CHECK (setting_key = 'auto_approve_enabled'),
  setting_value TEXT NOT NULL CHECK (setting_value IN ('0', '1')),
  updated_at TEXT NOT NULL
);
