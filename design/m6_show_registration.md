# M6: 新規Show予約とdraft制御の初期化

更新日: 2026-10-02

## 範囲と公開gate

新規Show用の`reserveM6Show`と読み取り専用`inspectShowRegistration`、内部管理handler、`ShowRegistrationClient`を追加した。未公開fetch結合入口の`POST /admin/shows`へ接続し、既存の認証・strict bounded JSON・service registry・readiness/version/cache owner gateを通す。

通常`fetchM6Candidate`/`src/m6-worker.ts`と公開CLIの書込gateは維持する。既存`create-show`/`init`/`deploy`やv0.1.1環境は変更しない。local Show TOMLのsite URL要件・metadata編集・明示的publicationは別の既存契約であり、予約だけではmetadata/cover/feedを公開しない。

## Permanent identityと順序

- 新規v2 Show controlに任意の`reservation_id` UUIDを追加した。新規登録では必須とし、既存移行済みcontrolへ自動で追加しない。必要な小さいIDとしてShow削除後も保持する。
- callerはservice/show/reservation IDを送信前に保持する。server/clientはIDを生成しない。新規登録用のreservation recordは既存形式の`{show_id,reservation_id}`のままで、タイトル・メール・site URL・secretを複製しない。
- 既存control・予約・Show/子Episodeのsystem/public/staging dataがないことを照会する。6 prefixをそれぞれlimit=1で調べ、未知object/truncatedも拒否する。旧controlの暗黙変換、既存予約の採用、任意prefix削除は行わない。
- まずShow control keyへ`If-None-Match: *`でgeneration=0/feed_generation=0/lifecycle=draftと永久reservation IDを新規作成する。この単一CASがShow IDの登録勝者を決める。別reservation IDの競合はこの時点で敗れる。
- 次に初期control完全一致とdata不在を再確認し、同じIDのreservation recordを条件付き新規作成する。record衝突はstrict照合し、別IDや不正本文を上書きしない。両recordのID一致を確認した後だけ`control_ready=true`を返す。

control-firstの途中では予約recordが欠落するため、`requireShowReservationReady`が共通受付・対象適格性照会・owner/実行検査で操作を拒否する。Show stateだけを見てstagingを開始できない。既存controlにreservation IDがない場合は、既存の移行/受付規則を維持する。

これは2 objectの原子的transactionではない。途中のcontrolは未完了登録として耐久的に残し、ready gateで操作を禁止する。全R2 Promiseと最後のruntime gateが終了するまでservice invocationを保持する。pauseは新規登録を拒否し、進行中tokenを奪わない。

## 中断と再利用禁止

control/予約PUTの正常・例外終了をawaitする。同じ予約IDの明示的reserveだけが、同一initial controlに不足する予約を補える。controlが既に進んで予約だけ消えている場合、既存予約なのにcontrolがない場合、orphanが現れた場合は安全な新規登録とはみなさず拒否する。

既に一致する登録ではcontrolを再PUTせず、generation/owner/公開停止状態を初期化しない。deleting/deletedは元の予約IDであってもreserveを拒否し、ID再利用・restoreの代用にしない。controlと予約のID不一致は移行inventoryでもblockerにする。

小さいcontrol/予約の条件付きbinding PUTを使う契約であり、REST媒体PUTのCAS保証とは区別する。旧IO収束・既存clientの停止・全routing/cache受け入れを省くものではない。

## Wire/client

strict入力は`schema_version=1`、`service_id`、`show_id`、`reservation_id`と`action=reserve/status`だけ。

| action | 結果 |
| --- | --- |
| `reserve` | 同じidentityの`reserved`/`control_ready=true`。公開・Queue送信・purgeではない |
| `status` | missing/initializing/reserved/occupied、現在のlifecycle/generation、`authorizes_registration=false` |

statusはservice tokenを作らず、両recordの読取後ETagとservice/runtime snapshotを検査する。pause中にも観測できるが、観測だけで登録成功/再送許可やlocal phaseを成立させない。occupied時に別のreservation IDを漏らさない。errors/logsは固定診断だけにする。

内部clientは固定HTTPS origin、管理key、redirect拒否、no-store/JSON/64KB bounded strict応答を使い、service/show/reservation ID/resultを照合する。各callは一回だけで、未知応答や偽receiptを再送・成功扱いしない。公開CLIと送信前durable journalへの接続は残件である。

## 検証と残件

unit/client/fetch結合で新規登録順序・最小record、同ID/別IDの競合、control/予約PUT前後の応答喪失、partial状態でstaging拒否、orphan/不正予約/advanced control/旧control/tombstoneの拒否、途中変更検出、runtime/auth/service/method/paused gate、service IO token保持、strict responseと非再送を回帰した。

Show初回publication fixtureの手動draft control投入も登録helperへ置き換えた。登録identityがpublication→unpublish→restore→deleteまで保持され、削除後に元IDで再登録できないことを内部API/Queueで確認した。

実Cloudflare・公開CLI・full cutover/外部復旧・次versionの受け入れは未完了であり、mockの合格を本番readyとしない。

資料: [R2 Workers APIのconditional put/strong consistency](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
