# Starting9

Starting9 は、プロ野球のスタメンを試合前に予想し、公式発表後に採点・公開するWebアプリです。現在は北海道日本ハムファイターズを対象に、予想入力、認証、V3自動化、ランキング、結果公開までをCloudflare上で運用しています。

このリポジトリは、静的フロントエンド、認証・アプリAPI、NPB取得Worker、D1スキーマ、管理画面V3を一つの小さなプロダクトとして追跡できる構成です。現行の自動実行系はGame Automation V3で、旧V1/V2 runnerは実行経路から切り離されています。

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Testing](docs/TESTING.md)
- [Admin V3 features](docs/ADMIN_FEATURES.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## 概要

ユーザーは試合前に、1〜9番の打順・守備位置・選手を予想します。

実際のスタメン発表後、管理者がスタメン候補を確認・承認し、予想内容と照合して100点満点で採点します。

Xなどで行われている「今日のスタメン予想」文化を、入力・採点・結果表示・共有までできるWeb体験として整理することが目的です。

## 現在できること

- 1〜9番のスタメン予想入力
- 守備位置入力、守備位置ボタンUI
- 選手重複チェック
- 守備位置の自動補完
- 打順カードのドラッグ並び替え
- 守備位置だけのドラッグ入れ替え
- 保存済み予想表示
- localStorageによる予想・実スタメン・採点結果の保存
- 管理者モードの表示切り替え
- NPB公式スコアURL、試合開始日時、対戦カード名の保存・復元
- 実スタメン手動貼り付け
- 実スタメン入力パーサー
- 守備位置の表記ゆれ対応
- 選手名の略称・スペース表記ゆれ対応
- Cloudflare Worker経由でNPB公式ページからスタメン候補取得
- 取得失敗時の `debug=1` 対応
- 管理者用の候補プレビュー
- 管理者承認フロー
- 自動取得・仮承認・自動本承認
- 100点満点採点
- 採点結果表示
- X共有テキスト生成
- スマホ向けUI整理

## ファイル構成

```text
starting9/
├── index.html              # 画面構造
├── style.css               # 見た目・レスポンシブ対応
├── script.js               # アプリ本体の処理
├── auth.js                 # 認証UIと認証APIクライアント
├── players.js              # 日本ハム野手マスタ
├── game-schedule.js        # 手動管理する試合日程
├── cloudflare-worker.js    # NPB公式ページ取得用Worker
├── auth-worker.js          # 認証・公開API・V3 Cronを持つAuth Worker
├── game-automation-v3.js   # V3 planner / state / executorの共通ロジック
├── admin-v3.html/js/css     # 認証済み管理画面V3
├── migrations/              # D1 schema history
├── wrangler.auth.example.jsonc # 認証Worker設定例
└── README.md               # このファイル
```

## ローカルでの起動方法

静的アプリなので、基本的には `index.html` をブラウザで開くだけでも動きます。

ローカルサーバーで確認する場合:

```powershell
cd starting9
python -m http.server 8782 --bind 127.0.0.1
```

通常画面:

```text
http://127.0.0.1:8782/
```

管理者モード:

```text
http://127.0.0.1:8782/?admin=1
```

## 通常画面と管理者モード

### 通常画面

一般ユーザー向けの画面です。

- 予想入力
- 予想保存
- 保存済み予想表示
- 採点結果表示
- X共有
- 対戦カード名の表示

管理者用のURL入力欄、実スタメン貼り付け欄、承認ボタン、自動取得設定などは表示されません。

### 管理者モード（互換画面）

URLに `?admin=1` を付けると表示されます。

```text
index.html?admin=1
```

管理者モードでは以下を操作できます。

- NPB公式スコアURL入力
- 試合開始日時入力
- 対戦カード名入力
- NPB公式ページから候補取得
- 自動取得開始・停止
- 自動本承認ON/OFF
- 実スタメン手動貼り付け
- 候補プレビュー
- 実スタメン承認
- 仮承認の本承認・修正・取り消し
- テスト用予想生成
- テストデータリセット

現在の本番運用・監視は、専用の `admin-v3.html` を使用します。旧画面は互換・確認用として読み取り専用の案内を残しており、V3の通常運用経路ではありません。

## 実戦テスト済みの内容

現時点では、実運用を想定して以下の流れを重点的に確認しています。

- 管理者モードでNPB公式スコアURLを入力
- Cloudflare Worker経由でNPB公式ページを取得
- 抽出した候補スタメンをプレビュー表示
- 候補を承認して採点対象に反映
- 自動取得で9人取得できた場合の仮承認
- 条件OK時の自動本承認
- 取得失敗時のログ・エラー表示
- 実スタメン手動貼り付けによるフォールバック
- 予想保存後、ページリロードしてもlocalStorageから復元
- NPB公式スコアURL、試合開始日時、対戦カード名のリロード後復元
- テストデータリセット後も試合情報は保持
- 通常画面では管理者用エリアが非表示

## 採点ルール

100点満点方式で採点します。

| カテゴリ | ルール | 最大点 |
|---|---|---:|
| 出場的中 | 予想した選手が実スタメンに出場していた場合、1人5点。9人全員的中で+5点 | 50点 |
| 打順的中 | 予想した選手の打順が一致していた場合、1人3点。9人全員的中で+3点 | 30点 |
| 守備位置的中 | 予想した選手の守備位置が一致していた場合、1人2点。9人全員的中で+2点 | 20点 |

合計は最大100点です。100点を超える追加ボーナスはありません。

## データ取得方針

実スタメンは、NPB公式試合ページを確認元とした候補取得に対応しています。

ブラウザからNPB公式ページを直接取得するとCORS制限を受ける可能性があるため、Cloudflare Workerを中継APIとして利用しています。Workerは対象ページを取得し、「最新のオーダー」周辺から日本ハム側の候補スタメンを抽出してJSONで返します。

取得した情報は、即時に正式な実スタメンとして登録しません。管理者用エリアで候補プレビューを表示し、内容確認後に承認することで採点用データとして利用します。

本アプリは公式記録・公式発表の代替を目的としたものではありません。

正確なスタメン、試合結果、選手成績などの最終的な情報については、NPB公式サイトおよび各球団公式発表を確認してください。

## Worker API

Cloudflare Workerのソースコードは `cloudflare-worker.js` で管理しています。

リクエスト例:

```text
https://<worker-url>/?url=https://npb.jp/scores/2026/0707/m-f-12/
```

成功時のレスポンス例:

```json
{
  "ok": true,
  "sourceUrl": "https://npb.jp/scores/2026/0707/m-f-12/",
  "fetchedAt": "2026-07-07T08:00:00.000Z",
  "method": "player-order-table",
  "team": "fighters",
  "lineupText": "1 遊 大塚瑠晏\n2 一 清宮幸太郎\n3 指 レイエス"
}
```

抽出失敗時は、`debug=1` を付けることで調査用のテキスト抜粋を返します。

```text
https://<worker-url>/?url=https://npb.jp/scores/2026/0707/m-f-12/&debug=1
```

## 技術構成

- HTML
- CSS
- JavaScript
- localStorage
- Cloudflare Workers

## 認証とCloudflare構成

メールアドレスを使わないユーザー名＋パスワード認証とアプリAPIは、既存のNPB取得Workerとは分離した `auth-worker.js` に集約しています。認証Workerは次のAPIを提供します。

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

パスワードはWorkerのWeb Crypto APIによるPBKDF2（SHA-256、ユーザーごとのランダムソルト、反復回数100,000）でハッシュ化し、D1には平文や生のセッショントークンを保存しません。セッションは30日間の `s9_session` HttpOnly・Secure・SameSite=Lax Cookieで管理します。

フロントにはログイン・新規登録UIがあり、認証APIが利用できない環境でも未ログインの予想入力は継続できます。アカウント保存、ランキング本人情報、管理画面は認証状態とサーバー認可に依存します。

### D1とWorkerの設定

`migrations/0001_auth.sql` が `users` と `sessions` テーブルを作成します。`migrations/0005_game_lineups.sql` は、承認済み実スタメンと自動採点の待機・処理・失敗状態を保存します。`migrations/0006_user_achievements.sql` は実績マスタとユーザーごとの取得実績を追加します。`migrations/0009_pregame_automation.sql` は試合単位のロースタースナップショット、試合前取得の進行状態、実スタメンの取得元を追加します。`migrations/0010_game_day_schedule_flow.sql` は当日公示、締切時点の固定、採点結果の非公開・公開状態を追加します。`migrations/0019_game_workflow_logs.sql` は通常試合の自動処理・管理操作ログと90日保持のcleanup状態を追加します。`migrations/0020_probable_starters.sql` は試合ごとの予告先発状態と次回確認時刻を追加します。新migrationは作成後にレビューし、対象D1へ適用してからWorkerを更新してください。

試合前自動処理は `game-automation-v3.js` と `auth-worker.js` のV3 planner / executorで時刻と状態を一元管理します。Cronは日本時間の予定slotに従って公示ベースのロースター、予告先発、NPB識別、スタメン、採点、ランキング、公開を独立したjobとして進めます。ブラウザは保存済みAPIデータを表示するだけで、自動化jobを実行しません。Auth Workerは `wrangler.auth.production.jsonc` の `NPB_FETCH_WORKER` Service Bindingを通じて `starting9-npb-fetch` を呼び出します。公開URLを設定する必要はありません。

管理者向けのテスト操作は、通常画面とは別のモードではなく、管理画面内の「開発用テスト」にまとめています。テストAPIは管理者セッションを必須とし、テスト予想は `is_test_prediction` により通常のランキング・実績集計から除外されます。

管理画面の「試合進行ログ」では、通常試合のCron処理と管理者操作を新しい順に確認できます。ログAPIは管理者セッションを必須とし、gameId・種別・状態で絞り込めます。認証情報や予想内容などの秘密情報は保存せず、90日を超えたログはCronのcleanupで削除します。

認証Workerを人間がセットアップする手順:

1. Cloudflare DashboardまたはWranglerで、認証用D1データベースを作成する
2. `wrangler.auth.example.jsonc` を `wrangler.auth.jsonc` にコピーする
3. `wrangler.auth.jsonc` の `database_id` を実際のD1 IDへ変更する
4. `AUTH_ALLOWED_ORIGINS` にStarting9フロントエンドの完全一致オリジンを設定する
5. ローカル確認では `npx wrangler d1 migrations apply starting9-auth --local --config wrangler.auth.jsonc` を実行する
6. 認証Workerを `npx wrangler dev --config wrangler.auth.jsonc` で起動する
7. 本番D1へ適用する場合だけ、内容を確認したうえで `--remote` を付けてmigrationを適用する
8. 認証Workerをデプロイし、フロントと同一カスタムオリジンの `/api/auth/*` へルーティングする

この作業ではD1作成、migrationのremote適用、Workerデプロイ、GitHub push、Secrets登録は実行していません。`wrangler.auth.jsonc`、`.dev.vars`、`.wrangler/` はGit管理対象外です。

既存のNPB取得WorkerはCORS `*` の公開GET APIとして動作しているため、認証APIをそこへ混在させない構成にしています。Cookie認証を安定させる本番構成は、フロントエンドと認証Workerを同一カスタムオリジン配下（例：`https://starting9.example.com` と `https://starting9.example.com/api/auth/*`）へルーティングする方法です。別オリジンの `workers.dev` を直接呼ぶ場合は、`AUTH_ALLOWED_ORIGINS` の厳密な許可リストとCookie/CORS設定が必要で、ブラウザのサードパーティCookie制限の影響を受けます。

開発時もCookieの `Secure` 属性は弱めません。HTTPSのローカルプロキシ、またはブラウザがSecure Cookieを許可するlocalhost環境で確認してください。

`auth.js` の `AUTH_API_BASE_URL` は空文字なら同一オリジンの `/api/auth/*` を使います。認証Workerを別ホストで直接呼ぶ場合は、そのHTTPS URLを設定し、Worker側の `AUTH_ALLOWED_ORIGINS` にフロントのオリジンを登録してください。ただし、別サイト間のCookieはブラウザのサードパーティCookie制限を受けるため、本番は同一カスタムオリジン配下へのルーティングを推奨します。

## 開発ルール

チーム開発では、以下の流れを基本にします。

1. Issueを確認する
2. 作業ブランチを切る
3. 小さく実装する
4. 動作確認とエラーチェックを行う
5. Pull Requestを作成する
6. レビュー後にmainへマージする

### ブランチ運用

- `main` への直接pushは避ける
- 作業ごとにブランチを切る
- ブランチ名は内容が分かるものにする

例:

```text
feature/admin-game-info-storage
fix/position-drag-menu
docs/team-readme
```

### PR運用

PRには以下を書いてください。

- 何を変更したか
- なぜ変更したか
- 確認した動作
- 不安な点、レビューしてほしい点

コード変更時は、最低限以下を確認してください。

```powershell
node --check script.js
git diff --check
```

## Issueの拾い方

1. GitHub Issuesから未着手のIssueを探す
2. 自分が作業するIssueにコメントする
3. 必要なら担当者を自分に設定する
4. 作業ブランチを切る
5. 実装後、Issue番号をPR本文に書く

Issueコメント例:

```text
このIssue対応します。
```

PR本文例:

```text
Closes #12
```

大きいIssueは、画面・ロジック・READMEなどに分けて小さいIssueへ分割してください。

## 今後の改善候補

- 公式リリース前のdebug fixture撤去
- 公開APIの診断レスポンス境界の整理
- X共有画像
- 公示Bot
- 成績リンク / 成績表示
- 両チーム対応
- チーム選択対応
- 他球団対応

リリース前に必ず行う作業は [Release checklist](docs/RELEASE_CHECKLIST.md) で管理します。

## 開発メモ

- 現在はPrivate運用中の個人開発MVPです
- まずは日本ハム専用で体験検証を優先しています
- `players.js` は日本ハム野手マスタとして管理しています
- 通常の予想候補は `isActiveRoster: true` の選手を表示します
- NPB取得や名前照合では、非アクティブ選手も既知選手として扱います
- 公式連携ではなく、NPB公式ページを確認元とした候補取得です
