# Asia CS Phase 4A staging

このディレクトリは本番投入前の確認用です。本番APIの入力として直接送信しません。

## 確定済み

- 大会名・開催期間・会場・参加4チーム・GAME1〜GAME6は、NPB公式の大会ページに基づく。
- 日時は `Asia/Tokyo` のISO表記で保持する。
- GAME7（3位決定戦）とGAME8（決勝戦）は対戦チーム確定後に作成する。

Source: https://npb.jp/apbc/2026/

## 未確定のまま保持するもの

- 公式選手名簿（選手発表待ち）
- 本番の予想締切時刻（運用ルール確認待ち）
- 外部試合コード

`games.json` の `predictionDeadlineAt: null` と `readyForProduction: false` は、未確定値を誤って本番へ送らないための明示的なゲートである。Asia CS Workerのゲーム登録APIは締切を必須とするため、このファイルは現時点では本番import不可。

`players.template.csv` は公式名簿発表後に埋めるためのテンプレートであり、架空選手を含まない。

## 本番投入順

1. 認証済みブラウザで通常Starting9とAsia CSの同一identity/admin readを確認。
2. 公式名簿と本番締切ルールを確定。
3. `readyForProduction` を別途レビューしたうえで、competitionを `draft` のまま登録。
4. teams、GAME1〜GAME6、選手を正式admin APIで登録。
5. GAME7/GAME8は対戦チーム確定後に登録。

予想受付、正式ラインナップ、採点、ランキング、公開はPhase 5まで開始しない。
