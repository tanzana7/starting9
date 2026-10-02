# Starting9 Asia CS MVP

本家Starting9の予想入力・採点・Best Nineの現行契約から必要部分だけを切り出した大会特別版です。`competition_type=ASIA_CS` と専用D1でNPB_REGULARと境界を分離し、V3/V4 Cron・NPB自動取得・週次/月次/年次ランキングは含めません。

## 分離方針

- Pages: `starting9-asia-cs`（このディレクトリの `public/`）
- Worker: `starting9-asia-cs-api`（`worker.js`）
- D1: `starting9-asia-cs-db`（`migrations/`）
- 本番Starting9のPages・Worker・D1・Auth Worker v337のService BindingやSecretは参照しません。
- `wrangler.jsonc` のD1 IDはAsia CS専用IDだけを設定します。現在はプレースホルダーのため、deployは行わないでください。

## ローカル確認

```powershell
npx wrangler d1 migrations apply starting9-asia-cs-db --local --config asia-cs/wrangler.jsonc
npx wrangler dev --config asia-cs/wrangler.jsonc
```

管理者は公開登録では作成しません。ローカルでは `.dev.vars` に秘密の `ADMIN_BOOTSTRAP_TOKEN` を設定し、`X-Admin-Bootstrap-Token` ヘッダー付きで `/api/auth/admin/bootstrap` を一度だけ呼び出してDBへ初期化します。管理者が一人でも存在する場合、同じ経路は再利用できません。`.dev.vars` と `.wrangler/` はコミットしません。

Pagesのローカル静的画面は、別ターミナルで次のように配信します。

```powershell
python -m http.server 8782 --directory asia-cs/public --bind 127.0.0.1
```

画面は `?game=<gameId>` で対象試合を選択します。API Workerを別ポートで起動する場合は、Pages側の同一オリジンルーティングをローカルプロキシで設定してください。

## Pages / Worker接続契約

- Pagesプロジェクトは `starting9-asia-cs`、API Workerは `starting9-asia-cs-api` とし、Pagesの同一ホスト `/api/*` をAsia CS API Workerだけへプロキシします。
- `public/` は相対URL `/api/...` のみを呼ぶため、本家Workerや本家Pagesを転送先に設定してはいけません。
- 本番の `ALLOWED_ORIGIN` はAsia CS Pagesの完全一致Originだけに設定します。`ADMIN_BOOTSTRAP_TOKEN` はWorker Secretとして登録し、Pagesへ渡しません。
- D1 IDがプレースホルダーの間はCloudflareリソース未作成であり、deploy成功・本番疎通済みとは扱いません。
- 試合の正本は `internalGameId` で、外部試合コードは任意です。チームは `teams`、選手は試合単位の `players` に保存し、NPB選手IDを共有namespaceへ強制しません。
- 本番確認では、Pagesの画面から `/api/auth/me`、予想保存、管理API、Best Nine取得の4経路をAsia CS Workerのログで確認してから公開します。

## APIの流れ

1. 管理者が `POST /api/admin/teams` で大会チームを登録し、`POST /api/admin/games` で試合を登録
2. `POST /api/admin/games/:id/players` または `PUT .../players/:playerId` で出場選手を登録・編集
3. ユーザーがログインして `PUT /api/games/:id/prediction` で予想を保存・編集
4. 保存APIは必ずD1に保存された締切とWorkerのサーバー時刻で判定
5. 管理者が正式スタメンを `POST /api/admin/games/:id/lineup` で確定
6. 締切後に `POST /api/admin/games/:id/score`、続けて `POST .../publish`
7. 修正時は `POST /api/admin/games/:id/rescore` が新revisionで全予想を再採点し、公開中なら同じ公開状態のままBest Nineを更新

登録時には `prediction_close`、`score`、`ranking_rebuild`、`publish` の4段階を `formal_jobs` に作成します。Phase 1では自動Cronを起動せず、管理操作が同じ段階の完了記録を進めます。NPB identity / probable / roster fetch / lineup fetch jobは作成しません。

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
