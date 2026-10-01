# Starting9 専用 Cloudflare account 移行準備書

## 目的と今回の範囲

Starting9 のバックエンドを履修Hubと別のCloudflare accountへ移せるよう、現行構成、移行時の入力、検証、切替、ロールバック手順を固定する。

Phase 2.5では、SOURCEを変更せず、TARGETの空DB・Worker・secretをstaging用に準備した。データ移行とcutoverは引き続き実施しない。

次の操作は実施しない。

- SOURCE側のCloudflare account、Worker、D1、Pagesの作成・変更
- D1のexport/import、migration適用、SELECTを含む本番データ操作
- SOURCE Worker/Pagesのdeploy、TARGET Cronの有効化、DNS変更
- 本番cutover、job実行、再採点、再公開
- SOURCE secret値の取得・表示・リポジトリ保存

この文書の将来手順は、専用accountと移行時間帯が承認された後に、対象と実行者を再確認してから使う。

## 固定するGit基準

| 項目 | 値 |
| --- | --- |
| 正規remote | `https://github.com/tanzana7/starting9.git` |
| 移行準備の基準main | `1c3131048e2ac72dc2ea0328175ba7bf9c08794b` |
| Phase 7 feature | `56054728518729061ec3734e1e07edcbd751921a`（mainへmergeしない。削除しない） |
| 現行Auth Worker | `starting9-auth` |
| 現行Auth Worker version | `8317b0c`（ユーザー提示値。今回の再取得・deployは未実施） |
| 今回の作業branch | `codex/starting9-account-isolation-phase2-5` |

CPU hardeningは今回の移行準備の対象外とする。既存mainを移行基準にし、Phase 7の未merge変更や`probableStarterOnly`変更を混ぜない。

## 現行構成の台帳

設定値の正本はリポジトリの`wrangler.auth.production.jsonc`、`wrangler.npb.jsonc`、`functions/api/[[path]].js`とする。現在のresource IDは移行先へコピーせず、source側の照合用にだけ使う。

| 区分 | 現行構成 | 移行時の扱い |
| --- | --- | --- |
| Pages | Starting9の静的サイトとPages Functions | 今回のbackend-only scopeでは既存accountに残す |
| Pages API proxy | `functions/api/[[path]].js`が`https://starting9-auth.tanzana7.workers.dev`へ中継 | 切替時に新Auth originへ一度だけ変更してPages deploy |
| Auth Worker | `starting9-auth`、entrypoint `auth-worker.js` | 専用accountへ同名で作成・deploy |
| NPB Worker | `starting9-npb-fetch`、entrypoint `cloudflare-worker.js` | Authのservice binding先として専用accountへ先に作成 |
| Auth DB | binding `AUTH_DB`、migration dir `migrations` | 新accountに空DBを作成し、承認済み手順で同じschema/dataを移行 |
| Audit DB | binding `AUDIT_DB`、migration dir `migrations-audit` | 新accountに空DBを作成し、承認済み手順で同じschema/dataを移行 |
| Service binding | `NPB_FETCH_WORKER` → `starting9-npb-fetch` | 新Auth Worker側で新accountのNPB Workerへ再設定 |
| Cron | 1分、5分、15分境界の補助処理など計5本 | source/targetの二重実行を避けて所有権を切替 |

### 現行Cron（targetでも意図的に同じ値を維持）

```text
* * * * *
*/5 * * * *
1,16,31,46 * * * *
2,7,12,17,22,27,32,37,42,47,52,57 * * * *
0,15,30,45 * * * *
```

Cronを移行時に増やしたり、別の毎分Cronを追加したりしない。sourceとtargetを同時にCron所有者にすると、score、ranking、publish、probable starter等の二重処理リスクがある。

### 非secret設定

移行先で次の値を維持する。日付や公開時刻などの運用値は、移行当日の正式な設定ファイルをレビューして確定する。

- `AUTH_ALLOWED_ORIGINS=https://starting9.pages.dev`
- `SESSION_SAMESITE=None`
- `AUTO_SCORING_DELAY_SECONDS=300`
- `ENABLE_DEVELOPMENT_MODE=false`
- `ENABLE_WORKFLOW_COMPLETION_JOBS=true`
- `ENABLE_GAME_AUTOMATION_V3=true`
- `ENABLE_AUTO_PROBABLE_STARTER=true`
- `ENABLE_AUTO_ROSTER_FETCH=false`
- `ENABLE_AUTO_LINEUP_FETCH=false`
- `ENABLE_LINEUP_SHADOW=true`
- `ENABLE_SEMI_AUTO_LINEUP=true`
- `NPB_FETCH_DISABLED=false`
- `PUBLIC_RANKING_RELEASED_AT`は現行運用値を別途確認して設定

### secretとセッションの扱い

コード上で利用されるsecret binding名は値を表示せず、移行時に新accountへ再登録する。

- `VAPID_PRIVATE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT`

実際のdeploy環境に追加のsecretがないかは、secret名だけを一覧化して照合する。secret値はCloudflareから読み戻さず、Git、ログ、作業メモへ書かない。

### VAPID rotation policy

SOURCEのVAPID private/public keyは読み戻さない。TARGETでは、Push subscriptionの継続性をSOURCEから引き継がない方針を採用し、信頼できる一時実行環境で新しいVAPID key pairを生成して、TARGET Auth Workerへsecret入力経路から登録する。private keyはファイル、コマンド引数、ログ、リポジトリに保存しない。

この方針ではSOURCEで発行済みのPush subscriptionをTARGETへ移行できない。cutover後に管理者がTARGETへ再購読する手順を用意し、データimport後はTARGET側の旧・不要Push subscriptionをcleanupする。cutover完了まではSOURCEのPushを変更せず、TARGETのPush endpointは公開経路へ接続しない。

Auth DBにはユーザー、セッション、認証関連データが含まれるため、D1移行では単なるschema再作成で終わらせない。データ移行の検証が完了するまでtargetを公開しない。

## 専用account作成後の前提条件

次の項目が揃わない限り、deploy/cutoverへ進まない。

1. target account IDと、Workers/D1を操作できる専用の認証profileまたはtokenが用意されている。
2. target accountに`starting9-auth`、`starting9-npb-fetch`、`starting9-auth` DB、`starting9-audit` DBを作成できる。
3. sourceとtargetのresource名、migrations directory、compatibility date、Cronがレビュー済みである。
4. NPB Workerを先にdeployし、Auth Workerの`NPB_FETCH_WORKER`がtargetへ向くことを確認できる。
5. Pages proxyの新Auth originと、必要なら固定API hostname/DNSの方針が決まっている。
6. source Cronを停止してからtarget Cronを有効化する所有権引継ぎ時刻が決まっている。
7. D1 data export/importの承認者、バックアップ保管先、件数・checksum照合方法、ロールバック責任者が決まっている。
8. TARGET用VAPID key rotationの運用方針と、cutover後の管理者再購読手順が確定している。

固定API hostnameを用意できる場合は、Pages proxyの将来のaccount依存を減らせる。用意しない場合も、Pages側のorigin変更は一度のcutover作業として明示的に扱う。

## 将来の実行手順（準備書。今は実行しない）

以下は順序を固定するためのテンプレートである。`<TARGET_...>`を実値に置換し、実行前に承認する。ここにあるコマンドは今回実行していない。

### 1. target設定の作成と静的照合

- production configを直接書き換えず、target専用の未追跡または安全な作業用設定を用意する。
- sourceの本番resource IDをtarget configへコピーしない。
- `AUTH_DB`と`AUDIT_DB`はtarget DB IDへ置換する。
- `NPB_FETCH_WORKER`はtarget accountの`starting9-npb-fetch`へ向ける。
- sourceの5 Cronとtargetの5 Cronが一致することを確認する。
- secretsはconfigへ書かず、Wranglerのsecret入力経路で設定する。

### 2. target D1 schema/data

CloudflareのD1はmigration directoryをリポジトリで管理し、migration適用済み状態をtarget DBで確認する。D1 migrationは対象DBを取り違えないよう、target名とconfigを明示して実行する。D1のexport/importは本番データを扱うため、承認済みの保管先・暗号化・削除期限を先に決める。

将来の例（今は実行しない）：

```powershell
# sourceのバックアップ取得。承認と保管先確認後のみ実行する。
npx wrangler d1 export <SOURCE_AUTH_DB_NAME> --remote --output <PROTECTED_BACKUP_PATH>

# target schema適用。target configとDB名を再確認してから実行する。
npx wrangler d1 migrations apply <TARGET_AUTH_DB_NAME> --remote --config <TARGET_CONFIG>
npx wrangler d1 migrations apply <TARGET_AUDIT_DB_NAME> --remote --config <TARGET_CONFIG>

# importは件数/checksum/機密情報の扱いを確認した後に実行する。
npx wrangler d1 execute <TARGET_AUTH_DB_NAME> --remote --file <APPROVED_IMPORT_FILE>
```

実際のimport形式はexport結果と現行Wranglerの対応を確認して選ぶ。source export、target import、件数、主要tableのchecksum、migration状態を記録し、照合不一致ならcutoverを中止する。D1のsourceを変更する操作やdual-writeは行わない。

### 3. Workerのstandby検証

1. target NPB Workerをdry-runで検証し、target accountへdeployする。
2. target Auth Workerをdry-runで検証する。
3. target Auth Workerへsecretを登録し、`AUTH_ALLOWED_ORIGINS`等の非secret vars、D1 bindings、service binding、compatibility dateを確認する。
4. standby期間はtarget Cronを有効なownerにしない。HTTP health/read-only検証だけを行う。
5. sourceとtargetのCronが同時に正式処理を実行しないことを、切替手順と設定の両方で確認する。

### 4. Cron所有権の切替

切替時刻は試合処理の境界を避け、運用担当がsourceの最終Cron状態を記録できる時間にする。

1. source側のCron所有権を停止またはdeploy設定から外し、停止時刻を記録する。
2. sourceに未完了jobがないことを、既存のread-only診断で確認する。未完了jobを手作業で移し替えない。
3. target Auth Workerを5 Cron付きで有効化する。
4. targetのheartbeat、`/health`、read-only APIを確認する。
5. targetでCronが1回だけ動いたことを確認し、sourceとtargetの同時実行がないことを監査する。

sourceとtargetが同時にscore/ranking/publishを実行する時間を作らない。特に、sourceのCronを先に止めずtargetを有効化しない。

### 5. Pages proxyの切替

Pages Functionは現在、同一originの`/api/*`をAuth Workerへ転送し、cookieのDomainを除去している。したがってbackend-only移行でも、新Auth originへ向けるためにPages Functionの1行を変更してPagesをdeployする必要がある。

切替時には次を行う。

1. target Authのhealth/read-only endpointを確認する。
2. `functions/api/[[path]].js`のAuth originをtargetへ変更するfeature commitを作る。
3. Pagesのpreviewまたは同等の検証で、cookie、CORS、`/api/auth/me`匿名応答、admin認証境界を確認する。
4. Pages deploy後にpublic `/`、`/api/*`、admin入口を読み取り専用で確認する。
5. 失敗時はPages proxyだけをsource originへ戻し、target Cronは停止したまま原因を調査する。

Pagesの切替は今回行わない。作業前のproxy変更は、target originが存在しないため実行してはいけない。

### 6. ロールバック

ロールバックの基本は「読み取り経路を戻す」「Cron所有者を一つにする」「D1を二重書きしない」である。

1. Pages proxyをsource Auth originへ戻す。
2. target Cronを停止し、sourceを再開する場合はsourceだけをownerにする。
3. targetで生成されたjobをsourceへ手動コピーしない。再開判断は監査後に行う。
4. source/targetのD1を同時に更新するdual-writeを行わない。
5. rollback後にhealth、read-only API、Cron ownershipを記録する。

## Phase 2.5 staging実績

以下はTARGET専用account内で実施したstaging準備であり、SOURCEの本番経路には接続していない。

- TARGET account: `02580fab1c09e144db7da89478e252c8`
- TARGET Auth D1: `starting9-auth` / `c5137bcc-0fcc-4822-95b8-996dffaf0818`
- TARGET Audit D1: `starting9-audit` / `9d97a0fb-9767-4ef2-9ba2-dcf0bd92774f`
- TARGET NPB Worker: `starting9-npb-fetch`（Cronなし）
- TARGET Auth Worker: `starting9-auth`（Cronなし、最終staging version `0f5858d5-1b6b-4f6c-8733-555eee2353b2`）
- TARGET Auth/NPB service binding: `NPB_FETCH_WORKER` → `starting9-npb-fetch`
- TARGET D1: schema migrationのみ。production data importなし
- TARGET VAPID secret: 3名を登録済み。値の表示・保存・SOURCEからの読み出しなし
- workers.dev subdomain: 新規登録なし。Pages/API cutoverなし

TARGET WorkersのCronは設定ファイル上0本とし、Wranglerのtrigger mutatorは実行していない。workers.dev direct healthはsubdomain未登録のため未確認であり、公開到達性の成功とは扱わない。

## 検証チェックリスト

### 準備段階（今回実施可能な範囲）

- [x] mainが`1c3131048e2ac72dc2ea0328175ba7bf9c08794b`と一致
- [x] Phase 7 `56054728518729061ec3734e1e07edcbd751921a`をmainへ混ぜていない
- [x] 現行Auth/NPB設定、5 Cron、D1 binding、Pages proxyをコードから確認
- [x] TARGET専用account、Auth/NPB Worker、Auth/Audit D1を作成
- [x] TARGET D1へschema migrationのみ適用
- [x] TARGET NPB/Auth WorkerをCronなしでstaging deploy
- [x] TARGET VAPID secret 3名を登録（値は非表示・非保存）
- [x] D1 export/import、Pages/API cutoverを実施していない

### target作成後（将来）

- [ ] target account、DB、Workerのresource IDと名前を二者確認
- [ ] schema/migration状態がsourceと一致
- [ ] 認証・セッション・Push subscriptionに必要なデータの移行件数とchecksumが一致
- [x] TARGET secret名が確認でき、secret値はログに出ていない
- [ ] data import後にTARGET Push subscriptionをcleanup
- [ ] cutover後に管理者がTARGETへ再購読
- [ ] NPB service bindingがtarget Workerを指す
- [ ] 5 Cronが一致し、Cron ownerが一つだけ
- [ ] target `/health`とread-only APIが200系
- [ ] Pages proxyのcookie/CORS/API応答を確認
- [ ] prediction close、lineup、score、ranking、publishを本番job操作なしで観測できる計画がある
- [ ] probable starterとNPB fetchのtarget経路を確認
- [ ] rollback担当者・時刻・判定基準が確定

## 中止条件

次のいずれかがあれば、targetを公開せず、sourceも変更せずに停止する。

- source/target D1の件数・checksum・migration状態が一致しない
- service bindingがtarget NPB Workerを指していない
- sourceとtargetのCron ownerが同時に有効になる
- TARGET VAPID rotationまたはsecret登録手順が確認できない
- Pages proxyがtargetを向いていない、またはcookie/CORSが壊れる
- target healthまたはread-only APIが5xxになる
- sourceの本番データを手動SQLで修正する必要が出る
- 未完了jobを手動移行・再実行・再採点する必要が出る
- 新accountの権限や監査ログを確認できない

## 未確認事項

今回の準備では、以下はまだ確定していない。

- target D1のdata import結果
- source D1のexport/checksumおよび本番データ件数
- session関連secretをSOURCEから安全に継続する方法
- data import後のTARGET Push subscription cleanup実績
- cutover後の管理者TARGET再購読実績
- 新Auth Workerのcustom hostnameを使うかworkers.devを使うか
- Pages projectの所属accountと、Pagesを同時移管するかどうか
- Cronを停止/切替するCloudflare上の具体的操作と所要時間
- targetでの本番相当read-only smoke結果
- 実際のcutover/rollback結果

## 参考資料

- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
