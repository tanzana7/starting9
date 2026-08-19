# V3 / admin-v3 追加試合登録 設計案

## Status

これは追加試合の本登録に関する設計資料です。現時点では本登録を **STOP** とし、production D1へのmigration適用、remote write、追加試合のcommit API実装は行いません。

次Phaseとして、admin-v3専用の `POST /api/admin/v3/schedule/add-game/preview` をread-onlyで実装します。このendpointは入力検証、既存`games`/`game_identifiers`/`detected_game_schedule`の重複候補、deterministicな`idempotencyKey`、schema readiness、想定planだけを返し、`willWrite: false`を保証します。本登録API、commitボタン、V3 state/job/auditの作成は引き続き未実装です。

previewの`idempotencyKey`は `manual-game:v1:{gameDate}:{normalizedStartAt}:{homeTeam}:{awayTeam}:{npbGameCode|no-code}` です。`startAt`を含むため時刻変更は別previewとして再確認します。同日同カードの時刻違い、home/away逆向き、同一NPB codeは候補またはwarningとして表示し、exact duplicateと同一NPB codeはblocking扱いにします。

admin-v3には「追加試合プレビュー」だけを表示し、画面上でも「この操作は書き込みを行わない」「本登録は未実装」と明示します。public UIには導線を追加しません。

前回のSTOP理由は、`games`、identity registry、`detected_game_schedule`、V3 state/job、ranking、public catalogを一括して冪等に初期化する正式サービスがなく、`games`の重複をDBレベルで防げないことでした。本案では、既存の日程同期を壊さず、追加試合を同じcanonical経路へ入れるための前提を定義します。

## 現状監査

- `games`には日付・開始時刻・対戦カードの通常indexしかなく、意図的に一意制約がありません。ダブルヘッダーや開始時刻訂正を自動統合しない方針のため、既存データの重複確認なしにunique indexを追加できません。
- `getOrCreateInternalGame`は、候補検索、`games` insert、schedule metadata更新、identifier登録を個別に行います。追加試合専用のtransaction-like serviceではありません。
- `detected_game_schedule`は`source_game_key`を一意キーとして保持し、通常の日程同期が更新します。adminが`games`だけをinsertするのは不完全です。
- V3の`ensureV3State`と`createV3Job`は再利用できますが、登録操作全体を初期化するサービスはありません。
- public games APIはcanonical `games`を直接候補にするため、登録途中の行を除外する明示的なstaged flagが必要です。

## Canonical identity

### scheduleIdentityKey

`startAt`をidentity keyに含めません。開始時刻の訂正で同じ試合が別試合になることを防ぎます。

```text
scheduleIdentityKey = v1|{gameDate}|{homeTeam}|{awayTeam}|{gameSequence}
```

各値はtrim、lowercase、team codeのcanonical化、日付の`YYYY-MM-DD`検証後に連結します。

`gameSequence`は必須です。通常試合は`1`、同日同カードのダブルヘッダーは`1`と`2`に分けます。開始時刻だけでダブルヘッダーを区別しないため、既存UIには明示入力または重複候補からの選択を設けます。

NPB game codeがある場合は別のprovider identifierとして登録し、後から解決した場合も`scheduleIdentityKey`は変更しません。NPB codeの一意性は非NULL値に限ってDBで保証します。

## Staged registration

公開候補に入る条件を明示的に分けます。

| 状態 | `registrationStatus` | `isPublicCandidate` | 意味 |
| --- | --- | ---: | --- |
| 作成予約 | `pending` | 0 | 入力検証・重複確認済み、未初期化 |
| 初期化中 | `initializing` | 0 | canonical/identity/V3/ranking/auditを処理中 |
| 利用可能 | `ready` | 1 | 公開一覧に出せる状態 |
| 失敗 | `failed` | 0 | admin-v3から再試行可能 |
| 取消 | `cancelled` | 0 | 作成操作を無効化 |

既存の通常同期ゲームはmigration時に`canonical / 1`へ初期化します。追加試合は全初期化が成功した後にだけ`ready / 1`へ遷移します。public APIは将来この2列を必ずfilterし、`pending`や`failed`を返しません。

## Idempotency / lock

`manual_schedule_operations`は操作履歴と冪等性を持ち、`schedule_identity_locks`は同一schedule identityへの同時作成をDBで直列化します。

- `idempotencyKey`はクライアント任意値ではなく、previewで正規化した入力から生成するか、サーバーで検証します。
- 同じ`idempotencyKey`の再送は同じoperationを返します。
- 異なるkeyでも同じ`scheduleIdentityKey`ならlockのunique制約で2件目を拒否します。
- `startAt`変更はlock keyを変更せず、既存operationの明示的なschedule correctionとして扱います。
- `gameSequence`なしで同日同カードを登録する操作はpreview時点で停止します。

既存gamesをlockへbackfillする前に、重複検出SQLを読み取り専用で実行し、重複があればSTOPします。既存データを自動統合するmigrationは作りません。

## Formal service

仮称: `registerAdminV3Game`

### commit前

1. admin認証とrole確認
2. date/time/team/sequence/NPB codeの検証
3. reason、confirm、idempotencyKeyの検証
4. `schedule_identity_key`、重複候補、NPB code競合を読み取り
5. preview結果を返す

### commit

1. `manual_schedule_operations`を`pending`で作成または既存operationを取得
2. `schedule_identity_locks`をinsertし、競合時は既存operationを返す
3. D1 `batch`で、canonical `games`、`detected_game_schedule`、identifier、operationの初期レコードを作る
4. batch成功後に`ensureV3State`を実行
5. ranking rowを`pending / is_ranking_eligible`で正式helperから作成
6. `registrationStatus=initializing`として、初期jobは既存V3 plannerに計画させる
7. `game_automation_v3_audit`へadmin operationを記録
8. state、ranking、identity、audit、next jobsを検証
9. 全条件を満たした場合のみ`ready / isPublicCandidate=1`へ遷移

plannerが失敗した場合は`initializing`または`failed`のまま公開しません。再試行は同じoperationIdで行い、既存rowを再利用します。published済み試合の巻き戻しはこのサービスの責務外です。

初期jobは手作りの時刻計算で直接insertしません。`deriveV3Schedule`と既存plannerが返すplanを入力に`createV3Job`へ委譲します。NPB codeが未解決の場合は`npb_identity_resolve`を先行させ、lineup系jobを実行可能状態にしません。

## API案

### `POST /api/admin/v3/schedule/add-game/preview`

writeなし。入力を検証し、以下を返します。

```json
{
  "ok": true,
  "idempotencyKey": "v1|2026-08-25|fighters|hawks|1",
  "duplicateCheck": { "status": "clear", "candidates": [] },
  "expected": {
    "workflowState": "scheduled",
    "registrationStatus": "pending",
    "isPublicCandidate": false,
    "nextJobs": ["npb_identity_resolve", "probable_starter_fetch", "roster_fetch", "prediction_close"]
  }
}
```

### `POST /api/admin/v3/schedule/add-game`

admin認証、reason、confirm、preview由来のidempotencyKeyを必須にします。成功時は`operationId`、`internalGameId`、workflow state、registration status、public candidate、next jobs、audit idを返します。途中失敗はHTTP成功として扱わず、operation statusとfailure codeを返します。

### `GET /api/admin/v3/schedule/operations/:operationId`

read-only。登録経路の状態、重複候補、identity、V3 state、ranking、job、audit、次の安全な操作を返します。

## Migration案

設計用SQLは[`docs/migrations/0036_manual_game_registration.sql`](C:/Users/user/Documents/Codex/2026-07-06/chrome-plugin-chrome-openai-bundled-file-6/starting9-result-ui/docs/migrations/0036_manual_game_registration.sql)に置きます。自動適用対象の`migrations/`配下には置いていません。

この案は以下を追加します。

- `manual_schedule_operations`
- `schedule_identity_locks`
- `games.schedule_identity_key`
- `games.registration_status`
- `games.is_public_candidate`
- `games.schedule_source`
- `games.manual_operation_id`
- `games.ranking_eligible`

ただし、既存gamesへのlock backfillとunique index適用は別stepです。重複検出が0件であること、`detected_game_schedule`とgamesのlinkが一意であることを確認してから実行します。重複がある場合はmigrationを適用せず、運用判断を待ちます。

## 読み取り専用の重複検出SQL案

以下は案であり、本番D1には実行していません。

### 同日・同カード・同時刻

```sql
SELECT game_date, start_time,
       lower(trim(home_team)) AS home_team,
       lower(trim(away_team)) AS away_team,
       COUNT(*) AS row_count,
       GROUP_CONCAT(internal_game_id) AS internal_game_ids
  FROM games
 GROUP BY game_date, start_time, lower(trim(home_team)), lower(trim(away_team))
HAVING COUNT(*) > 1;
```

### 同一NPB game code

```sql
SELECT npb_game_code, COUNT(*) AS row_count,
       GROUP_CONCAT(internal_game_id) AS internal_game_ids
  FROM games
 WHERE npb_game_code IS NOT NULL AND trim(npb_game_code) <> ''
 GROUP BY npb_game_code
HAVING COUNT(*) > 1;
```

### scheduleとgamesの不一致

```sql
SELECT s.game_id, s.source_game_key, s.internal_game_id,
       g.internal_game_id AS games_internal_game_id,
       s.game_date, s.start_at, g.game_date AS games_date, g.start_time AS games_start_time
  FROM detected_game_schedule AS s
  LEFT JOIN games AS g ON g.internal_game_id = s.internal_game_id
 WHERE s.internal_game_id IS NULL
    OR g.internal_game_id IS NULL
    OR g.game_date <> s.game_date
    OR g.start_time <> s.start_at
    OR lower(trim(g.home_team)) <> lower(trim(s.home_team))
    OR lower(trim(g.away_team)) <> lower(trim(s.away_team));
```

### identifierの複数link

```sql
SELECT provider, identifier_type, identifier_value,
       COUNT(*) AS row_count,
       GROUP_CONCAT(internal_game_id) AS internal_game_ids
  FROM game_identifiers
 GROUP BY provider, identifier_type, identifier_value
HAVING COUNT(*) > 1;
```

### V3 orphan

```sql
SELECT s.internal_game_id
  FROM game_automation_v3_state AS s
  LEFT JOIN games AS g ON g.internal_game_id = s.internal_game_id
 WHERE g.internal_game_id IS NULL
UNION ALL
SELECT j.internal_game_id
  FROM game_jobs_v3 AS j
  LEFT JOIN games AS g ON g.internal_game_id = j.internal_game_id
 WHERE g.internal_game_id IS NULL;
```

## admin-v3 UI案

入力はgameDate、startAt、home/away、gameSequence、venue、NPB code任意、ranking eligible、reason、確認checkboxとします。

操作前にduplicate checkを表示し、commit後はoperationId、idempotencyKey、internalGameId、workflow state、registration status、public candidate、next jobs、audit id、failure reasonを表示します。admin-v3以外の公開UIには操作を露出しません。

## Phase分割

| Phase | 目的 | migration | deploy | rollback / STOP |
| --- | --- | --- | --- | --- |
| 1 | schema案、重複調査、docs、設計テスト | 未適用draftのみ | なし | 既存重複が不明ならSTOP |
| 2 | read-only preview / duplicate check | なし | admin Workerのみ | writeが混ざればSTOP |
| 3 | operations/lock/staged schemaを適用 | 0036相当。事前検出必須 | Worker停止または互換deploy | 重複・backfill失敗でSTOP |
| 4 | formal registration serviceとschedule sync統合 | なし | Worker | batch/再試行/idempotencyテスト失敗でSTOP |
| 5 | admin-v3 UI | なし | Pages/Worker | public bundleに操作が混ざればSTOP |
| 6 | 限定試合で検証 | なし | 本番限定 | 実試合追加は承認後のみ |

rollbackはpublished済み試合を巻き戻さず、登録前は`failed / isPublicCandidate=0`で停止します。migration rollbackが必要な場合は、先にstaged operationとlockの参照がないことを確認する専用migrationを設計し、直接DROPや手動SQLでは対応しません。

## 次のSTOP解除条件

1. 本番read-only重複検出の結果が承認される
2. D1 batchと部分失敗時の再試行契約をテストできる
3. 既存schedule syncもlock/canonical serviceを通る
4. public APIのstaged filterを実装できる
5. ranking rowとV3 plannerの正式契約をテストできる
6. admin-v3でoperation/audit/next jobを診断できる

これらが揃うまで、追加試合をproductionへ登録しません。
