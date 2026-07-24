-- Cloudflare Cronの最終実行状態。画面表示用の観測情報であり、ワークフローの制御には使わない。
CREATE TABLE IF NOT EXISTS game_automation_health (
  state_key TEXT PRIMARY KEY,
  cron_last_run_at TEXT,
  cron_last_success_at TEXT,
  cron_last_error_at TEXT,
  cron_last_error_code TEXT,
  processed_game_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK(state_key = 'cron')
);
