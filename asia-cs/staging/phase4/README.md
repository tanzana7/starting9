# Asia CS Phase 4A staging

このディレクトリは本番投入前の確認用です。本番APIの入力として直接送信しません。

## 確定済み

- 大会名・開催期間・会場・参加4チーム・GAME1〜GAME6は、NPB公式の大会ページに基づく。
- 日時は `Asia/Tokyo` のISO表記で保持する。
- 予想締切はStarting9のプロダクトルールとして、各試合の `startAt` の60分前に固定する。
- `games.json` のGAME1〜GAME6には、上記ルールで算出した締切を `+09:00` のISO表記で設定済み。
- GAME7（3位決定戦）とGAME8（決勝戦）は対戦チーム確定後に作成する。

Source: https://npb.jp/apbc/2026/

## 未確定のまま保持するもの

- 公式選手名簿の最終確定
- 外部試合コード

予想締切ルールは確定済みだが、`readyForProduction: false` は維持する。公式選手名簿、外部試合コード、認証済みadmin運用が未確定のため、このファイルは現時点では本番投入不可である。Asia CS Workerのゲーム登録APIへ送る場合も、検証済みの締切を含むゲームpayloadだけを使用し、staging JSONをそのまま投入しない。

`players.template.csv` と `players.template.json` は、ユーザーから受け取ったAPBC 2026日本代表野手候補15名を確認するための暫定資料である。`id` はイベント内で安定して扱うための内部IDで、NPBの公式選手IDや背番号を推測したものではない。`club` は所属球団表示、`registeredPosition` は捕手・内野手・外野手という登録上の分類で、予想の守備位置を表さない。

暫定JSONの各行は `id`、`name`、`club`、`registeredPosition`、`active` を持つ。背番号・打席・投球・公式選手IDは未提示のため追加しない。

予想入力の守備位置は従来どおり `捕`、`一`、`二`、`三`、`遊`、`左`、`中`、`右`、`指` の9枠をユーザーが手動で選択する。登録上の分類から予想位置を自動入力しない。これにより、同じ選手を複数打順へ登録する既存の重複防止、9枠の完成判定、99点満点の採点契約を変更しない。

`readyForProduction: false` と `official: false` は正式投入前の状態を明示するメタデータである。選手の公式発表、所属、表示名を運用担当が確認するまで、本番APIへ送信しない。管理APIへ送る際は確認済みの `players` 配列だけを使用し、未確認の対戦相手や試合をこの資料から補完しない。

## 本番投入順

1. 認証済みブラウザで通常Starting9とAsia CSの同一identity/admin readを確認。
2. 公式名簿を確定し、選手payloadを作成。
3. `readyForProduction` と認証済みadmin運用を別途レビューしたうえで、competitionを `draft` のまま登録。
4. teams、GAME1〜GAME6、選手を正式admin APIで登録。締切は各 `startAt` の60分前を使用する。
5. GAME7/GAME8は対戦チームと `startAt` 確定後、同じ締切ルールで登録。

## 公式選手名簿発表後の手順

1. 公式発表とチーム所属を照合する。
2. `players.template.json` の `players` 配列を正式選手だけで作成し、CSVと件数・項目を照合する。
3. 重複ID・重複名・所属チーム・守備位置・背番号をローカル検証する。
4. 管理画面の一括登録で入力内容を確認し、`readyForProduction` を別担当が確認する。
5. 認証済みadmin smoke後に、正式な選手payloadだけを本番へ投入する。

大会は管理画面を保存しただけでは `draft` のまま保持し、`active` への変更は明示的に行う。未確定の対戦チーム・選手を推測して補完しない。締切は公式大会ページから推測せず、Starting9の共通プロダクトルールで算出する。

予想受付、正式ラインナップ、採点、ランキング、公開はPhase 5まで開始しない。
