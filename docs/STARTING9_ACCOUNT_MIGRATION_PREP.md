# Starting9 専用 Cloudflare account 移行準備書

## 目的と今回の範囲

Starting9 のCloudflare account migrationに関する実施履歴、現行構成、検証結果、運用baseline、ロールバック境界を固定する。

> **STATUS: COMPLETED (2026-10-01):** Account Isolation Phase 4のatomic cutover、Phase 5の安定性確認、Phase 6のbaseline lockを完了した。Production validationは`NORMAL`。現在はPagesをSOURCE accountに残し、Auth Worker・NPB Worker・Cron・D1をTARGET accountで運用している。以下のPhase 1〜5の準備・cutover手順はHISTORICALであり、未完了の将来手順ではない。

Phase 2.5（履歴）では、SOURCEを変更せず、TARGETの空DB・Worker・secretをstaging用に準備した。この時点ではデータ移行とcutoverを実施していなかった。

次の操作は実施しない。

- SOURCE側のCloudflare account、Worker、D1、Pagesの作成・変更
- D1のexport/import、migration適用、SELECTを含む本番データ操作
- SOURCE Worker/Pagesのdeploy、TARGET Cronの有効化、DNS変更
- 本番cutover、job実行、再採点、再公開
- SOURCE secret値の取得・表示・リポジトリ保存

この文書の将来手順は、専用accountと移行時間帯が承認された後に、対象と実行者を再確認してから使う。

## Phase 1〜3準備時のGit基準（HISTORICAL）

| 項目 | 値 |
| --- | --- |
| 正規remote | `https://github.com/tanzana7/starting9.git` |
| 当時の移行準備基準main | `812846324533aac265c0c13910e0f13d8bdd8458` |
| Phase 7 feature | `56054728518729061ec3734e1e07edcbd751921a`（mainへmergeしない。削除しない） |
| 当時のAuth Worker | `starting9-auth` |
| 当時のAuth Worker version | `8317b0c`（当時の記録。現行versionはProduction baseline lockを参照） |
| Phase 3.5作業branch | `codex/starting9-account-isolation-phase3-5` |

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
- `MIGRATION_MAINTENANCE=false`（通常運用。切替時だけSOURCE保守設定で`true`）
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

## Phase 2 migration準備手順（HISTORICAL / 実行しない）

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

## Phase 2.5 staging実績（履歴）

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

TARGET WorkersのCronは設定ファイル上0本とし、Wranglerのtrigger mutatorは実行していない。TARGET Auth `/health` はHTTP 200、NPB Workerは正式な `mode=schedule` と `mode=starter` のread-only GETでHTTP 200を確認した。NPBの `/health` は正式endpointではなく、mode未指定のため400になる。

## Phase 3 precutover readiness（HISTORICAL / COMPLETED）

- package.jsonは`1c3131048e2ac72dc2ea0328175ba7bf9c08794b`から`8ded93d72223114524dea2877e369581e046109d`まで変更なし。Phase 2.5の一時VAPID依存処理の残骸やscript削除はない。
- SOURCE Authの正式Cronは、リポジトリのproduction configに記載された次の5本と確認した。
  - `* * * * *`
  - `*/5 * * * *`
  - `1,16,31,46 * * * *`
  - `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`
  - `0,15,30,45 * * * *`
- TARGET staging config `wrangler.auth.target.jsonc` はCronなしのまま維持する。
- TARGET cutover config `wrangler.auth.target.production.jsonc` を追加し、TARGET account/D1/service bindingと上記5本だけを定義した。今回このconfigでdeploy・trigger変更は行っていない。
- SOURCE/TARGETのconfigでD1 UUIDを混在させず、Authの`NPB_FETCH_WORKER`はTARGET `starting9-npb-fetch`を参照する。
- NPB Workerの正式read-only契約は、ルート直下GETの`mode=schedule&date=YYYY-MM-DD`、`mode=starter`、`mode=roster`、`mode=notice`、`mode=lineup`。外部NPB取得は行うが、D1書き込みを行う経路ではない。
- AuthからNPBへのService Bindingは、dry-runのbinding表示、既存の`fetchNpbWorkerJson`契約テスト、target設定で確認した。空TARGET D1のため、本番相当のAuth read-only APIを使った追加smokeは実施していない。
- 次Phaseのwrite freezeは、prediction/admin/Cron/score/ranking/publish/Push subscription/sessionの各mutationを対象に、既存のmaintenance・service unavailable・feature flagの再利用可否を確認してから実装する。今回新しいmaintenance toggleは追加していない。
- D1 export/import、SOURCE write freeze、Cron停止、TARGET Cron有効化、Pages/API切替は未実施。

## 検証チェックリスト

### 準備段階（HISTORICAL）

- [x] mainが`1c3131048e2ac72dc2ea0328175ba7bf9c08794b`と一致
- [x] Phase 7 `56054728518729061ec3734e1e07edcbd751921a`をmainへ混ぜていない
- [x] 現行Auth/NPB設定、5 Cron、D1 binding、Pages proxyをコードから確認
- [x] TARGET専用account、Auth/NPB Worker、Auth/Audit D1を作成
- [x] TARGET D1へschema migrationのみ適用
- [x] TARGET NPB/Auth WorkerをCronなしでstaging deploy
- [x] TARGET VAPID secret 3名を登録（値は非表示・非保存）
- [x] D1 export/import、Pages/API cutoverを実施していない

### target作成後（HISTORICAL）

- [ ] target account、DB、Workerのresource IDと名前を二者確認
- [ ] schema/migration状態がsourceと一致
- [ ] 認証・セッション・Push subscriptionに必要なデータの移行件数とchecksumが一致
- [x] TARGET secret名が確認でき、secret値はログに出ていない
- [ ] data import後にTARGET Push subscriptionをcleanup
- [ ] cutover後に管理者がTARGETへ再購読
- [x] NPB service bindingがtarget Workerを指す
- [x] cutover configの5 CronがSOURCE configと一致する（Cron owner切替は未実施）
- [x] target Auth `/health`とNPB read-only APIが200系（NPB `/health`自体は正式endpointではない）
- [ ] Pages proxyのcookie/CORS/API応答を確認
- [ ] prediction close、lineup、score、ranking、publishを本番job操作なしで観測できる計画がある
- [ ] probable starterとNPB fetchのtarget経路を確認
- [ ] rollback担当者・時刻・判定基準が確定

## 中止条件（HISTORICAL / cutover時の判断基準）

次のいずれかがあれば、targetを公開せず、sourceも変更せずに停止する。

- source/target D1の件数・checksum・migration状態が一致しない
- service bindingがtarget NPB Workerを指していない
- sourceとtargetのCron ownerが同時に有効になる
- TARGET VAPID rotationまたはsecret登録手順が確認できない
- Pages proxyがtargetを向いていない、またはcookie/CORSが壊れる
- targetの正式healthまたはread-only APIが5xxになる
- sourceの本番データを手動SQLで修正する必要が出る
- 未完了jobを手動移行・再実行・再採点する必要が出る
- 新accountの権限や監査ログを確認できない

## 未確認事項（HISTORICAL / Phase 3時点）

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
- 次Phaseで使うmaintenance/write-freeze toggleの正式な実装方式
- 実際のcutover/rollback結果

## 参考資料

- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

## Phase 3.5 移行直前準備（履歴、2026-10-01）

Phase 3.5では、SOURCEの本番データやCron所有権を変更せず、切替時間帯に実行する保守・移行・ロールバック手順をコードと文書へ固定した。今回のfeature branchではdry-run、実データexport/import、SOURCE/TARGETの本番deploy、Pages deploy、Cron切替を実施しない。

### Gitとresourceの基準

| 項目 | 値 |
| --- | --- |
| Phase 3.5基準main | `812846324533aac265c0c13910e0f13d8bdd8458` |
| Phase 3.5 branch | `codex/starting9-account-isolation-phase3-5` |
| Phase 7 CPU experiment | `56054728518729061ec3734e1e07edcbd751921a`（未merge・未deployのまま） |
| SOURCE account | `c81eb6d12b9be16f800f0bd1fc8a1c8a` / profile `starting9-source` |
| TARGET account | `02580fab1c09e144db7da89478e252c8` / profile `starting9-target` |

Wrangler操作は必ずprofileを明示する。SOURCEの操作はread-only確認または、承認されたPhase 4の保守deployに限定し、TARGETのresource作成・schema適用・staging deployと混同しない。

### SOURCE write freeze

`wrangler.auth.source.maintenance.jsonc` をSOURCE専用の保守設定として追加した。SOURCE account、SOURCE D1 ID、SOURCE NPB service bindingを固定し、`triggers.crons`を明示的に空配列にして、保守deploy後にSOURCE Cronを所有者にしない設定である。Worker varsの`MIGRATION_MAINTENANCE=true`が次の処理を止める。

- POST/PUT/PATCH/DELETEの認証、予想、admin、Push subscription等のmutation
- `/api/auth/me`（GETだが`last_used_at`を更新するため）
- scheduled handlerのheartbeat、audit、formal/auxiliary job、score、ranking、publish、maintenance

`OPTIONS`、`GET /health`、その他の既存GET読み取りは保守中も利用できる。GET経路に副作用があることを確認したものは今後もwrite freezeの判定対象にする。scheduled handlerはD1 binding確認やheartbeatより前に`MIGRATION_MAINTENANCE`を検出して終了するため、Cronが誤って起動してもD1 writeを行わない。

通常運用設定の`wrangler.auth.production.jsonc`、TARGET stagingの`wrangler.auth.target.jsonc`、TARGET切替設定の`wrangler.auth.target.production.jsonc`には、通常状態を明示する`MIGRATION_MAINTENANCE=false`を設定する。保守設定にfalseを設定して解除することはせず、保守設定のdeployと通常設定のdeployを別操作として扱う。

保守開始の実行例（Phase 4で承認された時間帯のみ。今回は未実行）：

```powershell
npx wrangler deploy --dry-run --config wrangler.auth.source.maintenance.jsonc --profile starting9-source
npx wrangler deploy --config wrangler.auth.source.maintenance.jsonc --profile starting9-source
```

実行後はSOURCE `/health`、代表的mutationの503、scheduled no-opを確認する。いずれかが確認できない場合はデータexportへ進まない。

### D1移行戦略の決定

正式採用する方式は「SOURCEをfull exportし、export成功後に作成した新しい空のTARGET D1へfull importする」である。既存TARGET staging DBへdata-only importする方式は、seed行、unique制約、migration metadata、既存staging行との衝突を避けにくいため採用しない。現TARGET D1はstaging確認用として保持し、Phase 4では別名・別IDのcutover用TARGET D1を、SOURCE exportの検証後に作成する。

Full exportではschemaとdataを一体で扱う。cutover用TARGETへimportした後、`sqlite_master`、migration metadata、外部キー、主要tableの件数/checksumを照合し、schemaを二重適用しない。migration directoryはschemaの基準・検査用として残すが、full exportのimport前に無条件でremote migrationsを再適用しない。

データの扱いは次のとおりとする。

| 区分 | 扱い |
| --- | --- |
| COPY | `users`、`sessions`、`predictions`、`games`、identifiers、lineup/revision/artifact、workflow/job/state、scoring、ranking、audit/history |
| COPY（履歴保持） | `admin_alert_incidents`とD1 audit data。通知履歴をPush key更新の都合で削除しない |
| ROTATE/CLEANUP | `admin_push_subscriptions`。VAPIDがTARGETでローテーション済みのため、import直後にTARGET側だけをcleanupし、管理者がTARGETで再購読する |
| REBUILD禁止 | job、state、score、ranking、publishをimport後に手動再生成・再実行しない |

`sessions`はopaque token hashを保存しているため、full import後も有効期限内のsession継続を検証対象とする。セッション署名secretを別途読み出して移行する設計ではない。継続性検証に失敗した場合でも、手動でsessionを改変せず、切替を中止して再ログイン方針を判断する。VAPIDの変更はPush subscriptionにだけ影響し、SOURCE側のPushはcutover前に変更しない。

実行例（Phase 4で保管先、承認、実値を再確認してから。すべて今回未実行）：

```powershell
# profileとSOURCE configを明示。--no-schemaは付けずfull exportを選ぶ。
npx wrangler d1 export starting9-auth --remote --config wrangler.auth.source.maintenance.jsonc --profile starting9-source --output <PROTECTED_SOURCE_AUTH_DUMP>
npx wrangler d1 export starting9-audit --remote --config wrangler.auth.source.maintenance.jsonc --profile starting9-source --output <PROTECTED_SOURCE_AUDIT_DUMP>

# exportの存在、サイズ、checksumを機密内容を表示せず検証した後、
# 新規TARGET D1を作成し、実値を一時cutover configへ反映する。
npx wrangler d1 create <CUTOVER_TARGET_AUTH_DB_NAME> --profile starting9-target
npx wrangler d1 create <CUTOVER_TARGET_AUDIT_DB_NAME> --profile starting9-target
npx wrangler d1 execute <CUTOVER_TARGET_AUTH_DB_NAME> --remote --profile starting9-target --file <PROTECTED_SOURCE_AUTH_DUMP>
npx wrangler d1 execute <CUTOVER_TARGET_AUDIT_DB_NAME> --remote --profile starting9-target --file <PROTECTED_SOURCE_AUDIT_DUMP>
```

`<...>`を未確認のまま実行しない。exportファイルはリポジトリ外の暗号化保管先に置き、照合・cutover後に定めた期限で削除する。SOURCE D1への`SELECT`、手動SQL、dual-write、job/state修正はPhase 4でも行わない。

### Pages proxyの切替準備

`functions/api/[[path]].js`は`STARTING9_AUTH_ORIGIN`を読み、許可済みの2 originだけを選ぶ。

- 未設定・不正値：SOURCE `https://starting9-auth.tanzana7.workers.dev`
- cutover時のPages env：TARGET `https://starting9-auth.starting9.workers.dev`
- rollback時：Pages envをSOURCEへ戻す

同一originの`/api/*` proxy、cookieのDomain除去、request header制限、upstream responseのstatus/header伝播は維持する。TARGET以外の任意URLは受け付けないため、環境変数の誤設定で外部originへproxyしない。Pagesのenv変更とdeployはPhase 4のCron所有権切替後に一度だけ行い、今回はPagesへ触れない。

### Local migration simulation

`tests/account-isolation-migration-strategy.test.js`は、現行`migrations/`と`migrations-audit/`をNode `DatabaseSync`で空DBへ適用し、代表的なusers/session、workflowに関係するPush登録、alert履歴、audit行をfixtureとしてfull database imageへ復元する。復元後にtable構成、session、alert history、auditの保持と、`admin_push_subscriptions`だけのcleanup、外部キー整合性を確認する。

これはCloudflare D1の実export/importや本番データのコピーではない。実データの件数・checksumはPhase 4のread-only validationで初めて取得し、不一致ならcutoverを中止する。

### Phase 4 atomic cutover runbook（HISTORICAL / 実績はbaseline lockを参照）

1. source/target account、profile、config、worker version、D1 ID、secret名、Pages envを二者確認する。試合処理中・未完了job・二重Cron ownerがあれば停止する。
2. `starting9-auth`へSOURCE maintenance configを`starting9-source`でdry-runし、承認後にdeployする。health 200、mutation 503、scheduled no-opを確認する。
3. SOURCE Auth/Audit D1をfull exportし、暗号化保管・サイズ・checksum・機密情報の取り扱いを確認する。失敗時はTARGET作成へ進まない。
4. export成功後に新しいcutover用TARGET Auth/Audit D1を`starting9-target`で作成し、一時TARGET production configへ新IDを設定する。既存staging DBは上書きしない。
5. full importとread-only検証を行い、主要table、sessions、workflow/job/state、scoring/ranking/publication lineage、audit件数/checksumを確認する。
6. TARGETの`admin_push_subscriptions`だけを、対象DB・profile・cutover IDを固定した承認済みcleanupで削除する。`admin_alert_incidents`は保持する。cleanup後の外部キーと件数を再確認する。
7. SOURCE Cronが停止済みであることをCloudflare control-planeで確認してから、NPB → Authの順にTARGET production configをdeployする。TARGETは5 Cron ownerになるまで公開trafficへ接続しない。
8. TARGET health/read-only API、service binding、VAPID secret名、Cron heartbeatを確認する。ここでD1 writeが必要になるsmokeは実施しない。
9. Pages envをTARGET originへ変更してPagesを一度deployし、public/admin入口、匿名`/api/auth/me`、cookie、CORS、read-only結果を確認する。
10. maintenance解除後に通常の次回運用でlogin、prediction、admin、Push再購読、formal pipelineを観測する。既存jobの手動run/rescore/republishはしない。

各段階で不一致があれば直前のownerを維持し、次段階へ進まない。SOURCE maintenance deploy後に切替を中止する場合は、原因を記録したうえでSOURCE通常設定を再deployしてCron ownerをSOURCEへ戻し、TARGET CronとPagesは有効化しない。

### Rollback判断

- PagesだけをTARGETへ向ける前：SOURCE maintenanceのまま止め、TARGETを公開しない。
- TARGET Worker検証後、Pages切替前：TARGET Cronを有効化せず、SOURCE通常設定を再deployしてSOURCEをownerに戻す。
- Pages切替後にread-only smoke失敗：Pages envをSOURCEへ戻してdeployし、TARGET Cronを停止したままSOURCE ownerを確認する。
- D1検証不一致：targetを手動修正・job再生成せず、cutoverを中止する。SOURCE D1は変更しない。
- 切替後のjob不整合：dual-writeや手動コピーをせず、Cron ownerを一つに固定し、既存の監査情報だけで復旧判断する。

### Phase 3.5完了判定

当時のPhase 3.5完了判定は「コード・config・runbook・local simulation・dry-runが揃い、Phase 4を安全に開始できる」ことであり、本番cutover完了ではなかった。実D1 export/import、SOURCE maintenance deploy、TARGET cutover config deploy、Pages deploy、Cron切替、production data validationは、その時点では未実施として記録した。

## Production baseline lock（Phase 6、2026-10-01）

Phase 4のcutoverとPhase 5のpost-cutover確認を完了したため、以下をStarting9の正式production baselineとする。SOURCEおよびTARGET staging resourceは、rollback/referenceまたはstaging用途として保持し、別途明示承認がない限り削除しない。

### 本番構成

| 項目 | 正式値 | 運用上の意味 |
| --- | --- | --- |
| Pages | `starting9` / SOURCE account `c81eb6d12b9be16f800f0bd1fc8a1c8a` | `https://starting9.pages.dev`を維持し、Pages proxyからTARGET Authへ接続 |
| Auth Worker | `starting9-auth` / TARGET account `02580fab1c09e144db7da89478e252c8` / version `5ab59e75-d9f4-4572-afcc-eba39c0b91f6` | 正式backend、5 Cronのowner |
| NPB Worker | `starting9-npb-fetch` / TARGET account / version `73a0353a-e7fb-4e48-9197-a710151b0a38` | Authの`NPB_FETCH_WORKER` service binding先 |
| Auth D1 | `starting9-auth-prod` / `326f97c3-768d-4df6-ada2-129fdb1865a1` | TARGET production database |
| Audit D1 | `starting9-audit-prod` / `acfac47d-1963-433a-b16b-36cd3afe9db4` | TARGET production audit database |
| Pages deployment | `3326ee05-b3db-4bee-90ab-42df1e9be61b` | 現行main `667becc` のproduction deployment |

正式Cronは次の5本であり、SOURCE側はmaintenance configで0本を維持する。

```text
* * * * *
*/5 * * * *
1,16,31,46 * * * *
2,7,12,17,22,27,32,37,42,47,52,57 * * * *
0,15,30,45 * * * *
```

### Profileとdeploy guard

アカウントをまたぐため、単一profileや省略profileで本番deployしてはならない。

| 対象 | 必須profile | 正式config / project |
| --- | --- | --- |
| Auth Worker | `starting9-target` | `wrangler.auth.target.production.jsonc` |
| NPB Worker | `starting9-target` | `wrangler.npb.target.jsonc` |
| Pages | `starting9-source` | Pages project `starting9` |

```powershell
npx wrangler deploy --config wrangler.npb.target.jsonc --profile starting9-target
npx wrangler deploy --config wrangler.auth.target.production.jsonc --profile starting9-target
npx wrangler pages deploy . --project-name starting9 --profile starting9-source
```

上記のPages deployはSOURCE accountで実行するが、backend upstreamをSOURCEへ戻す操作ではない。Pages secret `STARTING9_AUTH_ORIGIN`はTARGET Auth originを指す。`wrangler.auth.production.jsonc`とSOURCE maintenance configはrollback/reference用であり、通常のTARGET本番deployには使用しない。

SOURCEのrollback用Workerは `MIGRATION_MAINTENANCE=true`、Cron 0本のまま保持する。rollbackが必要な場合も、TARGET Cronを停止し、Pages proxyの向きとWorker ownerを一つずつ確認してから、別承認の手順で実施する。

### Phase 6確認結果

- main / origin/main: `667beccf19a5d692c9aebbe099765f123c4d05be`
- TARGET heartbeat: `completed`、`last_failed_at=null`
- Pages root、Pages public API、TARGET Auth `/health`、TARGET NPB schedule: HTTP 200
- TARGET主要データとjob履歴はcutover後のread-only spot-checkで確認済み
- migration SQL dumpはAuth/Auditとも削除済み。本文は保存しない
- SOURCE resource、TARGET staging resource、Phase 7 CPU experimentは保持

このbaseline lock自体ではWorker、Pages、Cron、D1、secret、job/stateを変更しない。今後の機能変更はこのbaselineからfeature branchで行い、profile/config guard、dry-run、CIを通過させてから本番反映する。

## Migration closeout（COMPLETED、2026-10-01）

### Final status

- **STATUS:** `COMPLETED`
- **Production validation:** `NORMAL`
- **Baseline:** `667beccf19a5d692c9aebbe099765f123c4d05be`
- **Architecture:** PagesはSOURCE、Auth Worker・NPB Worker・Cron・production D1はTARGET
- **Cleanup:** SOURCE Worker/D1/secretsとTARGET staging resourceは保持。ユーザーの明示承認なしに削除しない

Account migrationの目的は達成済みであり、このmigrationを未完了作業として再実行しない。Phase 1〜5の準備・cutover手順はHISTORICAL、Phase 6のbaseline lockと本節が現行の運用基準である。

### 現行production運用ルール

| 対象 | account / profile | 正式なdeploy対象 |
| --- | --- | --- |
| Auth Worker | TARGET / `starting9-target` | `wrangler.auth.target.production.jsonc` |
| NPB Worker | TARGET / `starting9-target` | `wrangler.npb.target.jsonc` |
| Pages | SOURCE / `starting9-source` | Pages project `starting9` |

通常運用で次を行わない。

- SOURCE Auth production configへのdeploy
- SOURCE Cronの再有効化
- SOURCE D1のproduction利用
- TARGET staging DBへの差し替え
- profileを省略したdeploy

### Rollback境界

SOURCEはrollback/reference専用であり、TARGETでproduction writeが継続しているため、単純にSOURCEへ戻してはならない。障害時はまずTARGETをmaintenance modeへ移し、TARGET Cronを0本にしたうえで、データのdivergenceを確認する。SOURCEへの切り戻しは別途承認された手順でのみ行う。

### CPU caveat

account-level isolationは履修Hubとのresource消費分離を達成したが、Cloudflare Free Workersのper-invocation CPU制限そのものを解決するものではない。今後のCPU最適化はaccount migrationとは別issueとして扱う。

### Phase 7 freeze

`56054728518729061ec3734e1e07edcbd751921a`はmigrationに含めず、未merge・未deployのCPU experimentとして保持する。

### Closeout safety

このcloseoutではWorker/Pages deploy、Cron変更、D1操作、SQL、secret変更、resource作成・削除、job/state変更、repair、再採点、再公開、Push操作を実施しない。
