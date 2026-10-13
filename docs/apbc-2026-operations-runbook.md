# APBC 2026 Starting9 Operations Runbook

APBC 2026 の運営期間に、Starting9 の管理画面と正式な管理APIだけで大会を運用するための手順です。対象は `apbc-2026` とし、D1 Console、直接SQL、手動job投入、WorkerのCron変更は運用手順に含めません。

## Source of truth

| 対象 | 正本・確認方法 |
| --- | --- |
| 公開画面 | `https://starting9-app.pages.dev/?edition=asia` |
| 公開API | Pages の `/api/asia-cs/*` proxy 経由のGET |
| 管理画面 | `https://starting9-app.pages.dev/admin-v3.html?edition=asia` の `Asia CS` タブ |
| Asia Worker health | `https://starting9-asia-cs-api.starting9.workers.dev/health` |
| 大会・試合状態 | `GET /api/asia-cs/competition?competitionId=apbc-2026` |
| 試合単位の管理診断 | 認証済み `GET /api/asia-cs/admin/games/:gameId` |
| 大会単位の管理診断 | 認証済み `GET /api/asia-cs/admin/overview?competitionId=apbc-2026` |

認証はStarting9 Authの既存セッションを使用します。管理操作は同一オリジンのPages proxyから行い、workers.dev URLをブラウザから直接呼びません。

### 現在の本番確認（2026-10-13）

- `apbc-2026` は `draft`。
- GAME1〜GAME6が存在する。
- Japanの予想対象はGAME2、GAME4、GAME5。GAME1、GAME3、GAME6は対象外。
- 公開GETでは、全試合の `canPredict` はdraftのため `false`。
- 公開ランキングは空、Best Nineは `publishedGameCount=0` かつ空。
- Asia Worker `/health` は200。Asia Workerのproduction configにCron triggerはない。
- GAME7/GAME8は未作成。対戦カード確定前に作成しない。

## Pre-activation readiness policy

事前準備の判定では、侍ジャパンの出場決定選手の発表と、大会側の最終公式登録ロースターの公示を分けて扱います。侍ジャパン公式に掲載された出場決定選手とStarting9の対象選手が一致し、技術・日程・締切・予想対象の条件を満たしている場合、大会側の最終ロースターが未公示であることだけを理由に事前準備をNO-GOにはしません。

- `APBC 2026 PRE-ACTIVATION GO WITH FINAL ROSTER RECHECK REQUIRED`: 事前運用の準備は成立。ただしactive化直前に大会側の最終ロースターを再確認する。
- `READY TO ACTIVATE`: 最終ロースター、管理APIのread-back、production health、全active gateを確認済み。実際のactive化操作を許可できる状態。
- `PRE-ACTIVATION NO-GO`: 既知の選手差分、辞退・追加招集の未反映、日程・締切不一致、Worker障害、予想受付gate不具合、またはP1/P2の技術問題がある状態。

「GO WITH FINAL ROSTER RECHECK REQUIRED」は予想受付開始の許可ではありません。`apbc-2026` は引き続き `draft` のまま保持し、active化直前に次を再確認します。

1. 大会側の最終公式ロースターの OUT / IN / 辞退 / 追加招集。
2. GAME2/4/5のJapanロースター15名、選手ID、登録守備位置、表記差。
3. 管理APIのformal job read-back、production health、公開APIの `status` / `acceptingGames` / `canPredict`。

侍ジャパンの選手発表は[公式選手一覧](https://i.japan-baseball.jp/jp/team/topteam/2026/apbc/player.html)、大会側の最終ロースター公示は大会公式発表を正本とします。

## Before 11/10

11/10 00:00に自動でactiveにはなりません。次の確認を完了してから、運営責任者が明示的にactiveへ変更します。

- [ ] `/admin-v3.html?edition=asia` を開き、`Asia CS`を選択できる。
- [ ] 管理者認証が成功し、`大会設定`と`試合・チーム登録`が表示される。
- [ ] `apbc-2026`、大会名、開催期間が正しい。
- [ ] Japan、Korea、Australia、Chinese Taipeiの4チームが存在する。
- [ ] GAME1〜GAME6のカード、順序、開始日時、対戦相手が正しい。
- [ ] GAME2/4/5のJapanロースターが各15名で、登録選手がactiveになっている。
- [ ] GAME2/4/5の締切が開始60分前である。
- [ ] Japan対象試合のformal jobが4件ずつ、非対象試合が0件である。確認は管理画面の試合詳細またはoverviewで行う。
- [ ] Asia Worker health、Authの管理者認証、canonical Pagesが応答する。
- [ ] 公開ランキングとBest Nineが大会開始前の空状態である。
- [ ] 予想件数など、開始前に存在してよいデータだけである。

## Activate Competition

大会設定の状態を `draft` から `active` に変更するのは、上記チェックを全て確認した後です。管理画面の状態を `active` にして保存します。正式APIでは `POST /api/asia-cs/admin/competition` に大会ID、表示名、短縮名、期間、`status: "active"` を送ります。

active化は自動ではありません。保存後、公開GETを再取得して次を確認します。

- Japan戦（GAME2/4/5）は、締切前かつ試合がopenなら `predictionEligible=true` かつ `canPredict=true`。
- GAME1/3/6は `predictionEligible=false` かつ `canPredict=false`。
- draft、completed、対象外試合では予想保存APIがfail-closedになる。

状態選択には `completed` も表示されます。completed化は大会終了時だけに行い、運用中に選択しないでください。これは重要な管理操作なので、保存前に大会IDと対象状態を声に出して確認します。

## GAME2

GAME2は2026-11-12 19:00 JST開始、予想締切は18:00 JSTです。Worker内部では `2026-11-12T10:00:00.000Z` と `2026-11-12T09:00:00.000Z` で保持されます。

### 締切前

- [ ] Asia Editionの公開画面でGAME2が対象として表示される。
- [ ] 公開GETの `canPredict=true` を確認する。
- [ ] GAME2のJapanロースター15名を確認する。
- [ ] 管理詳細の `formalJobs` が `prediction_close`、`score`、`ranking_rebuild`、`publish` の4件である。
- [ ] 締切が18:00 JSTであることを管理画面と公開GETで確認する。

### 正式スタメン発表後

管理画面で対象試合をGAME2に固定し、Japanの正式スタメンを登録します。登録するのは1〜9番の打順、選手、守備位置です。候補選手はその試合のactiveなJapanロースターに含まれている必要があります。重複選手、重複打順、不正な守備位置、別チームの選手はAPIが拒否します。

正式スタメン登録は `POST /api/asia-cs/admin/games/apbc-2026-g2/lineup` です。保存後、管理詳細でcurrent lineupとrevisionを再取得します。採点前にこの確認を完了してください。

### 18:00 JST以降

予想保存・更新・削除は、DBに保存された締切とWorkerのサーバー時刻で拒否されます。別の `prediction_close` ボタンやprediction closeの手動実行はありません。`prediction_close` のformal job行は処理の状態・revisionを記録するもので、Asia WorkerのCronが自動実行するものではありません。

### 採点・ランキング・公開

管理画面の対象試合を再確認してから、次の順序で1回ずつ実行します。

1. **採点** — `POST /api/asia-cs/admin/games/apbc-2026-g2/score`。締切後かつ正式スタメン確定後に実行する。`LINEUP_REQUIRED`、`INITIAL_SCORING_NOT_ALLOWED`、`PREDICTION_OPEN` が出た場合は操作を止め、状態を読み直す。
2. **ランキング更新** — 採点完了後に `.../ranking`。`SCORING_REQUIRED` または `SCORING_INCOMPLETE` なら採点の完了を確認する。
3. **公開** — ranking rebuild完了後に `.../publish`。`RANKING_INCOMPLETE` または `RANKING_GENERATION_STALE` なら再公開を繰り返さず、ランキング世代とrevisionを読み直す。

同じrevisionの採点・ランキング・公開はno-opまたは既存の整合性エラーになります。連打せず、各操作後に管理詳細を再取得してください。公開後は公開result、ランキング、Best NineのGETで反映を確認します。

## GAME4

GAME4は2026-11-13 19:00 JST開始、締切は18:00 JST（UTCでは開始10:00、締切09:00）です。GAME2と同じ順序を繰り返します。

- [ ] active、GAME4選択、Japanロースター15名、`canPredict=true`を確認。
- [ ] 正式スタメン発表後にGAME4のlineupを登録。
- [ ] 締切後に採点 → ranking rebuild → publish。
- [ ] 各段階で管理詳細のrevision、job status、artifact generationを再取得。

## GAME5

GAME5は2026-11-14 12:00 JST開始、締切は11:00 JST（UTCでは開始03:00、締切02:00）です。午前中の運用になるため、前日までに管理者認証とGAME5選択を確認し、当日は11:00より前に次を済ませます。

- [ ] active、GAME5選択、Japanロースター15名、締切11:00 JSTを確認。
- [ ] 正式スタメン発表後にlineupを登録。
- [ ] 11:00以降に採点 → ranking rebuild → publish。
- [ ] 公開後にGAME5 resultと大会rankingを確認。

## GAME1 / GAME3 / GAME6

GAME1、GAME3、GAME6はJapanが出場しないため、予想対象ではありません。`predictionEligible=false`、formal jobsは0件です。これらの試合でロースター、正式スタメン、採点、ランキング、公開の予想パイプライン操作を行いません。大会の試合情報を確認するだけにします。

## GAME7 / GAME8

GAME7/GAME8は対戦カードが公式に確定してから、Asia管理画面の試合登録または正式な一括登録だけで追加します。D1 Consoleや直接SQLは使いません。既存GAME2/4/5のロースターは自動継承されないため、Japanが出場する場合は新しい試合にJapanの15名を登録します。

### Japanが出場する場合

- GAME7: 2026-11-15 11:00 JST、締切10:00 JST。
- GAME8: 2026-11-15 19:00 JST、締切18:00 JST。
- Japan参加をチームIDから確認する。
- `predictionEligible=true`、formal jobsは4件であることを管理詳細で確認する。
- その試合専用のJapanロースター15名を登録する。
- active化後、締切前に予想受付を確認する。

### Japanが出場しない場合

`predictionEligible=false`、formal jobsは0件です。予想用ロースターやformal pipelineを作成しません。

開始日時はISO日時で送信し、`gameDate`はAsia/Tokyoの開始日と一致させます。締切を省略してもサーバーが開始60分前を導出します。入力する場合も導出値と完全一致させてください。

## Ranking / Publish

Asia Workerには本番Cronがないため、試合登録時に作成される `scheduled` 行は実行予約の表示ではなく、formal処理の状態記録です。管理者が正式APIのボタンを順番に操作して、同じ行をcompletedへ進めます。

依存関係は次のとおりです。

```text
deadline gate + confirmed lineup
        ↓
score
        ↓
ranking_rebuild
        ↓
publish
```

rankingは同一大会の現行採点を再集計し、公開済み世代だけを公開GETに返します。publishは同一revisionの採点とranking世代を必須とし、古い世代を公開しません。修正が必要な場合はrescoreで新revisionを作成し、rankingとpublishを改めて実行します。直接job状態を変更しません。

## Best Nine

Best Nineは別の手動作成・手動publish操作を持ちません。公開済み試合の正式ラインナップから、公開条件を満たす現行server結果をGET時に集計します。採点・ranking・publishの完了後に `GET /api/asia-cs/best-nine?competitionId=apbc-2026` を確認します。未公開または採点中の試合は対象外です。

## Complete Competition

大会の全ての予想対象試合について、正式スタメン、採点、ranking、publish、公開resultを確認した後、管理画面で `active` から `completed` に変更します。完了前に次を再確認します。

- [ ] GAME2、GAME4、GAME5の公開resultが存在する。
- [ ] 大会rankingが最後の公開世代を返す。
- [ ] Best Nineが最後の公開済み試合を対象に返す。
- [ ] 未処理のprediction対象、lineup、score、ranking、publishがない。
- [ ] GAME7/GAME8を追加した場合も、Japan参加試合の処理を確認済み。

completed後はpredictionの変更と管理mutationが拒否されます。既存の公開result、公開ranking、Best Nineは読み取り可能なまま維持されます。誤ってcompletedにしないよう、状態を保存する前に大会ID・状態・完了チェックを二人で確認します。

## Admin UI audit

`/admin-v3.html?edition=asia` のAsia Editionには、大会設定、試合・チーム登録、選手・ロースター・正式処理、正式スタメン・採点・公開があり、認証済み管理者だけが表示・操作できます。対象試合の管理詳細には次が返ります。

- competition status
- game status / publication status
- startAt / predictionDeadlineAt
- current lineup / revision
- predictions
- formalJobs
- requiredFormalJobTypes / missingFormalJobTypes
- ranking generation

UIはoverview/detail GETで取得したcompetition status、Japan戦判定、締切、lineup revision、formalJobsを使い、score、rescore、ranking、publishの前提未達操作をdisabledにします。disabled理由は各ボタンの下に表示されます。draft→active、active→completed、score、rescore、ranking、publishには確認ダイアログがあり、送信中は二重操作を防止します。これは操作ミスを減らすためのUI補助であり、認証・CSRF・状態遷移・依存関係の判定は引き続きAsia Workerが行います。GETでreconcileやjob生成は行いません。非Japan試合はprediction pipeline操作の対象外として表示されます。

## Troubleshooting / Emergency Checks

障害時は次の順でread-only確認します。

1. canonical Pagesが200か確認。
2. Authのログイン状態と管理者権限を管理画面で確認。Cookie/tokenを抽出・手入力しない。
3. Asia Worker `/health` が200か確認。
4. 公開competition GETで大会statusと対象試合を確認。
5. admin overviewまたは試合詳細GETで対象game、deadline、lineup、revision、formalJobsを確認。
6. `missingFormalJobTypes`、job `status`、`attempts`、`completed_at`、`artifact_generation`を記録。
7. scoreなら`LINEUP_REQUIRED` / `PREDICTION_OPEN` / `INITIAL_SCORING_NOT_ALLOWED`、rankingなら`SCORING_REQUIRED` / `SCORING_INCOMPLETE`、publishなら`RANKING_INCOMPLETE` / `RANKING_GENERATION_STALE`を確認。
8. 最後に成功したrevisionとranking generationを記録し、管理画面の正式操作だけで再開可能か判断。

次の行為を障害対応の初手にしません。

- D1 Console、manual SQL、直接UPDATE/DELETE
- jobの手動投入、status/leaseの書き換え
- prediction、score、ranking、publishの無断再実行
- completed大会の復旧目的の直接書き換え

再実行が必要でも、対象試合とrevisionを再確認し、正式admin APIの依存関係に従います。APIが拒否した場合は、エラーコードとread-backを保存してから判断します。

## One-page quick checklist

### Before Japan game

- [ ] Asia Worker health 200
- [ ] Auth /admin-v3認証済み
- [ ] competition `active`
- [ ] 対象gameを固定
- [ ] Japan roster 15名
- [ ] startAt / deadline確認
- [ ] formal jobs 4件

### After lineup announcement

- [ ] Japanの1〜9番・守備位置を登録
- [ ] lineup validation成功
- [ ] current revisionをread-back

### After deadline

- [ ] prediction保存が締切で拒否されることを確認
- [ ] prediction_closeの別操作は行わない
- [ ] 対象gameを再確認

### After game

- [ ] score
- [ ] ranking rebuild
- [ ] publish
- [ ] result / ranking / Best Nine GET
- [ ] job status・revision・generationをread-back

## Audit conclusion

- P1: なし。
- P2: なし。公開APIのJapan-only、draft fail-closed、deadline導出、formal job依存、completed後のmutation拒否、Best Nineの公開条件をコードとテストで確認した。
- P3: Asia管理画面の危険操作ボタンは前提未達でも表示され、操作確認ダイアログもない。runbookのread-back・二重確認で運用する。将来、前提連動disabledと確認UIを検討する。
- 本番管理UIの認証済みクリック操作、実大会のactive化、試合処理、GAME7/8作成、公開処理は今回実施していない。

このrunbookを使用する限り、判定は **APBC 2026 FINAL OPERATIONS READY WITH P3 NOTES** とします。
