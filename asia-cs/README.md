# Starting9 Asia CS Phase 2

本家Starting9の予想入力・採点・Best Nineの現行契約から必要部分だけを切り出した大会特別版です。`competition_type=ASIA_CS` と専用D1でNPB_REGULARと境界を分離し、V3/V4 Cron・NPB自動取得・週次/月次/年次ランキングは含めません。

## 分離方針

- 本番UI: `https://starting9.pages.dev/asia-cs/`
- 本番API: `https://starting9.pages.dev/api/asia-cs/*`（既存Starting9 Pages Function proxyからAsia CS Workerへ転送）
- Backend Worker: `starting9-asia-cs-api`（`worker.js`）
- D1: `starting9-asia-cs-db`（`migrations/`）
- standalone PagesはDEV ONLY/local preview用で、本番の認証経路・公開UIには使用しません。
- 本番Starting9のD1を直接参照しません。認証だけは既存Starting9 Auth Workerの `/api/auth/me` と host-only `s9_session` を正本として利用します。
- ローカル開発は `wrangler.jsonc`、本番Workerは `wrangler.production.jsonc` を使用します。本番configはTARGET accountとAsia CS専用D1だけを固定し、Cronを持ちません。

## ローカル確認

```powershell
npx wrangler d1 migrations apply starting9-asia-cs-db --local --config asia-cs/wrangler.jsonc
npx wrangler dev --config asia-cs/wrangler.jsonc
```

本番のmigrationとdeployは、TARGET profileを明示して次のconfigを使用します。実大会データの投入は別Phaseで行います。

```powershell
npx wrangler d1 migrations apply starting9-asia-cs-db --remote --config asia-cs/wrangler.production.jsonc --profile starting9-target
npx wrangler deploy --dry-run --config asia-cs/wrangler.production.jsonc --profile starting9-target
npx wrangler deploy --config asia-cs/wrangler.production.jsonc --profile starting9-target
```

本番では独自のユーザー名・パスワード・セッションを使用しません。`STARTING9_AUTH_BASE_URL` は `https://starting9-auth.starting9.workers.dev` の完全一致Originだけを受け付け、既存Auth Workerの `/api/auth/me`（一般ユーザー）または `/api/admin/me`（管理者）が検証した `s9_session` のユーザーID・権限だけを利用します。upstreamは4秒でタイムアウトし、5xx・不正JSON・redirect・未許可Originは匿名扱いにします。ローカルfixture専用の `ASIA_CS_LOCAL_AUTH=true` とbootstrap/login経路は本番設定に含めません。`.dev.vars` と `.wrangler/` はコミットしません。

Pagesのローカル静的画面は、別ターミナルで次のように配信します。

```powershell
python -m http.server 8782 --directory asia-cs/public --bind 127.0.0.1
```

画面は `?game=<gameId>` で対象試合を選択します。ブラウザのAPI呼び出しは `/api/asia-cs/*` の相対URLだけを使用し、workers.devへ直接接続しません。API Workerを別ポートで起動する場合は、Pages側の同一オリジンルーティングをローカルプロキシで設定してください。

## Pages / Worker接続契約

- 本番のStarting9 Pagesは `/asia-cs/` をUIとして提供し、`/api/asia-cs/*` だけをAsia CS API Workerへプロキシします。既存の `/api/*`（Auth・NPB・予想等）は従来のStarting9 upstreamへ転送し、Asia CS prefix以外は変更しません。
- proxyの接続先はPages環境変数 `ASIA_CS_API_ORIGIN` の明示的なHTTPS originだけです。未設定・不正値ではfail closedし、ブラウザからworkers.devへ直接fallbackしません。
- `public/` は `/api/asia-cs/...` の相対URLのみを呼ぶため、本家Workerや本家Pagesを直接転送先に設定してはいけません。
- 本番の `ALLOWED_ORIGIN` はAsia CS Pagesの完全一致Originだけに設定します。`ADMIN_BOOTSTRAP_TOKEN` はWorker Secretとして登録し、Pagesへ渡しません。
- D1 IDがプレースホルダーの間はCloudflareリソース未作成であり、deploy成功・本番疎通済みとは扱いません。
- 試合の正本は `internalGameId` で、外部試合コードは任意です。チームは `teams`、選手は試合単位の `players` に保存し、NPB選手IDを共有namespaceへ強制しません。
- 本番確認では、Pagesの画面から既存Authの `/api/auth/me`、予想保存、管理API、ランキング、Best Nine取得を確認します。Asia CS側へクライアントの `user_id` を渡しても採用しません。

## APIの流れ

1. 管理者が `POST /api/admin/teams` で大会チームを登録し、`POST /api/admin/games` で試合を登録（`gameDate`、`startAt`、`predictionDeadlineAt` はすべて必須。締切は開始より前、`gameDate` は東京時間の開始日と一致させる）
2. `POST /api/admin/games/:id/players` または `PUT .../players/:playerId` で出場選手を登録・編集
3. ユーザーがログインして `PUT /api/games/:id/prediction` で予想を保存・編集
4. 保存APIは必ずD1に保存された締切とWorkerのサーバー時刻で判定
5. 管理者が正式スタメンを `POST /api/admin/games/:id/lineup` で確定
6. 締切後に `POST /api/admin/games/:id/score`、`POST .../ranking`、`POST .../publish` の順で実行
7. `GET /api/rankings?competitionId=...` は `competitionId` を必須とし、公開済み世代だけを返します。ランキング更新前・公開前の得点や別大会の得点は返しません
8. 修正時は `POST /api/admin/games/:id/rescore` が新revisionで全予想を再採点し、ランキング更新・公開を再度実行する。旧revisionを公開結果として再利用しない

## Phase 2の大会モード

- `GET /api/competition?competitionId=...` が大会メタデータ、次戦、受付中試合、過去試合を返します。
- `GET /api/games?competitionId=...` が同大会のscheduleを日付順で返し、ログイン中だけ自分の提出状態を付加します。
- `GET /api/best-nine?competitionId=...` は公開済み試合の正式ラインナップだけから大会Best Nineを集計します。未公開・採点中の試合は対象外です。
- `GET /api/games/:id/result` は公開済み試合の正式ラインナップと、ログイン中ユーザー自身の予想・得点・内訳だけを返します。
- `POST /api/admin/competition` で大会名・期間・状態（`draft` / `active` / `completed`）を管理します。`completed` は新規予想を拒否し、既存結果は読み取り専用で表示します。
- `POST /api/admin/players/import` と `POST /api/admin/games/import` は全行を検証してから一括保存します。CSVはヘッダー付き文字列、JSONは配列を受け付け、選手取込では守備位置・背番号も検証します。
- 公開・管理UIともにStarting9 Pagesの `/asia-cs/` と `/api/asia-cs/*` だけを使用し、ブラウザからWorkerのworkers.dev URLへ接続しません。

Best Nineの同点順は `selectionCount DESC`、守備位置の日本語昇順、選手名昇順、内部選手ID昇順です。公開対象は大会の公開済みgameに限ります。

登録時には `prediction_close`、`score`、`ranking_rebuild`、`publish` の4段階を `formal_jobs` に作成します。Phase 1では自動Cronを起動せず、管理操作が同じ段階の完了記録を進めます。`ranking` は大会全試合の現行採点を再集計し、同じrevisionでの再実行はno-opです。`publish` は同じrevisionのranking job完了を必須にします。NPB identity / probable / roster fetch / lineup fetch jobは作成しません。

## Best Nineの契約

本家の現行Daily Best Nineの公開条件と順位処理を再利用しています。

- 公開済み試合（`status=published` / `publication_status=published`）だけを対象
- 正式採点済みでserver側の `score` と `max_score` が存在する最新予想だけを対象
- 最大9人
- 並び順は `score DESC`、同点時は `submitted_at ASC`、次に `username ASC`、最後に `user_id ASC`
- 同点でも順位番号は1, 2, 3…の表示順。クライアント入力の得点は信頼しない
- 再採点時は予想の `score`、`scored_revision`、`actual_lineup_json` を全件更新し、Best Nineはmaterialized tableではなく現行server結果から再集計

## テスト

```powershell
node --test tests/asia-cs-mvp.test.js
```

この結合テストは、予想保存→サーバー締切拒否→正式スタメン登録→採点→公開→Best Nine→正式スタメン修正→再採点→Best Nine更新を、SQLite上のD1 adapterで確認します。
