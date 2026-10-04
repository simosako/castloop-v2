# M6: 新規初期化と稼働判定の分離

更新日: 2026-10-04

## 範囲

旧サービスのデータ変換を経ず、別名のWorker/private R2/Queue/DLQから開始する内部経路を実装した。既存資源を削除・採用する機能ではない。legacy移行用の`readiness`は互換性と監査のため保持し、新規起動には独立した`runtime_readiness`を用いる。架空のmigration ID・旧IO終了証拠・旧cache purge証拠は作らない。

通常の`init`とM6公開コマンドはまだこの経路へ接続していない。専用の試験バイナリで実Cloudflare初期化・Show/Episode公開・基本配信を確認済みだが、M6全体の公開ゲートとは区別する。

## 小さい責務

- `src/service-admission.ts`: 配信・管理・consumerの現在Worker versionと稼働判定を一か所で照合する。`initializing`中はすべてのmutating invocationを拒否する。
- `src/m6-service-initialization.ts`: 空bucketの確認と初期化ownerのCAS、実行version/config hash、検証前後のREST deployment/settings証拠、最終CASを担当する。完了は`paused`であり、明示再開を別操作とする。
- `packages/cli/src/m6-service-initialization.ts`: 資源作成・配備・初期化の要求前journal保存と一度限りの実行を担当する。保存と非期限lockは既存の共通storageを利用する。
- `packages/cli/src/m6-initialization-rest.ts` / `cloudflare-api.ts`: 新規資源のREST作成、衝突を拒否するWorker名のclaim、凍結metadataの単一PUT、Queue/notification設定と配備検査を担当する。runtime検証をREST設定から推測しない。
- `packages/shared/src/m6-worker-deployment.ts`: CLIとWorkerが同じ配備検査を使用する。Cloudflare応答から、secret/author/未管理設定を除いた最小snapshotを作る。
- `src/m6-setup-*` / `packages/cli/src/m6-setup-client.ts`: 認証付きprepare/status/probe/completeと、実HTTP・loopback・Queue往復の検証を担当する。別の汎用状態機械や独立したchallenge IDを設けず、凍結operation IDを再利用する。

## 手順と失敗

CLIは`prepared → resources_requested → resources_created → deploy_requested → deployed → initialization_requested → initialized`を記録する。source/metadataはhashだけを保存し、administrator secretやコード本文を保存しない。実際にPUTするmetadataも凍結hashと照合する。資源・PUT・初期化の応答喪失ではrequestedを保持し、自動再送・資源の採用・cleanupを行わない。部分作成を巻き戻したと説明しない。

serverはservice TOMLとadmission以外のobjectがあるbucketを拒否する。検証開始後の完了時に限り、同operationの小さいruntime-check記録を許す。初期化targetはoperation/deployment/Worker version/config hashで固定する。同一targetの準備・完了は冪等だが、別target・既存legacy admissionを上書きしない。

稼働検証adapterは信頼された内部の読み取り専用callbackとして必須である。HTTP入力のtrue/falseをそのまま証拠にするAPIは設けていない。検証中の設定変更、別deployment、CAS競合は稼働へ昇格せず、未完了ownerを残す。

## 認証付きの起動時検査

試験専用entry `src/m6-setup-worker.ts`にだけ初期化経路を接続する。通常candidate・既存binaryのready=falseと書込禁止は変えない。

1. CLIがCloudflare RESTからdeployment/version/settings/previewの前後snapshotを採取する。検査の実装はWorkerと共有し、account API tokenはCLIに留める。
   実RESTのsettingsはexportsを省略することがある。前後の100%配備照合とimmutable versionの明示export設定を必須とし、settingsにexportがある場合も照合する。省略をready申告や架空の設定で補完しない。到達待ちは認証付きhealthの有限回GETだけで、対象versionが確認できるまでprepareを送らない。
2. prepareがexact初期化ownerを確認し、named cache entrypointでtag purgeを実行した後、小さい固定requestを条件付き保存し、一回Queueへ送信する。
3. main Queue consumerがQueue名・実行version・request・初期化ownerを照合し、同記録へCAS receiptを保存する。重複配信は記録を書き換えない。
4. CLIが公開originの認証付きprobeを同URLで二回GETし、request/version/cache ownerと異なるinvocation IDを確認する。Workerも実default loopback fetchを二回呼び出す。
5. Workerが実管理handlerのstrict入力検証、初期化中の配信503、private pathの404/no-storeを確認する。検証前後のconfig・owner・record ETagと二つのREST snapshotを照合してから、共通CASでpausedへ進める。

REST snapshotは認証済み管理者から受け取るCloudflare観測値であり、Cloudflareの署名付き証明ではない。設定検査と実行記録を照合するが、競合するaccount deployerや侵害された管理者からの虚偽snapshotを防ぐ仕組みとは説明しない。初期化中は管理者による他の配備・設定変更を止める。

`publication_routes_verified`はここでは実管理routeの入力検証へ到達した意味であり、Show/Episodeの公開成功やpublication consumerの処理完了を証明しない。`cutover_verified`も新規空サービスの起動境界の意味であり、legacy IO/cache収束の代用ではない。named RPC/purgeの成功はcache HITの実測ではない。コンテンツ公開、cache HIT/purge後の本文、GET/HEAD/Range、300MBは後続の受け入れで確認する。

Queue statusの有限回待機はCLIの観測終了だけである。時間だけでowner/consumerを失効させない。prepare/complete/Queue送信の応答喪失は自動再送せず、既存記録とrequested journalを保持する。Queue receiptが未着なら完了しない。runtime-check記録にはtargetと固定receiptのみを永久保持し、secret・metadata本文・任意の例外messageを保存しない。

## 検証と残件

初期化・CAS競合・誤証拠・設定変更・応答喪失・journal/lock・REST資源衝突を自動テストした。既存の一つのcontent-flow結合テストも、新規初期化からShow登録・公開・改訂・停止/再開/削除へ通す経路に置き換えた。別の巨大なE2Eテストは追加していない。

自動テストはsimulated REST/cache/Queueである。通常candidateのready=falseとmanagement書込禁止は維持する。通常更新・六lifecycle操作・cache HITと停止/削除後のpurge・300MB受け入れ・unknown IO回復・公開CLI/案内等のM6共通gateも省略しない。

## 試験バイナリと実Cloudflare受け入れ

`bun scripts/build-cli.ts linux-x64 --m6-test`は、通常binaryとは別の`dist/castloop-m6-test-linux-x64`へ試験entryを埋め込む。管理者のマシンにBun/Node/Wranglerや別R2 credentialを要求せず、envのaccount/tokenとprivate local admin keyを使う。service IDは`m6-test-`、全資源名は`castloop-m6-test-`だけを許す。通常buildのCLI/Worker entryは変えない。

試験CLIは既存のdurable登録/draft/staging/publication runnerを使用する。init完了はpausedで、明示service-resumeが必要。serviceの認証付きstatus/pause/resumeとtarget照会を接続し、pauseでは残存tokenを保持する。実行versionと空registryの再開条件は同じservice CAS snapshotで検査し、競合後にも再検査する。未知応答を自動再送せず、service操作の未知結果復旧は未完成である。

実RESTのR2 PUT receipt.sizeはdecimal stringだった。numberまたはdecimal integer stringだけを安全整数の固定lengthへ照合し、全量GET checksumも引き続き必須とする。aborted receiptをCLIのstaged成功として表示しない。

`experiments/m6/verify-fresh-service.ts`で新規専用資源を作り、standaloneから登録→TOML/cover/audio staging→明示commit→実notification/Queue consumer→公開まで検証した。feed書込はconsumer完了より先になるため、feedにGUIDが現れただけで媒体検証を始めず、targetのactive/owner解放とregistry返却も待つ。有限回の待機終了ではowner/tokenを解除しない。continuationは明示指定したacknowledged checkpointだけで、未知のPOST/PUT/commitを再送しない。

- 合格環境: Worker/R2/main Queue `castloop-m6-test-9c80a9b8`、DLQは同名`-dlq`。既存v0.1.1資源には変更しない。
- 初期化operation `52190e82-ec82-41be-a90a-f4b099655b5e`、確認済みversion `5a1f489a-351e-42c1-b53a-d49a38518a8f`。実HTTP/loopback/Queue receipt、初期paused、明示再開を確認した。
- Show job `57842670-da9d-4479-9b0f-91f2ee37088a`、Episode job `7e195537-32bf-4d62-a7e8-4cb8f5752b84`。GUID・revision・20,850-byte synthetic MP3 checksum、feed/68-byte PNG cover、GET/HEAD/Rangeと再検証headerを確認した。300MB/聴取品質/cache HIT/全coloの受け入れではない。
- ローカル入力/REST応答形式/早期配信観測の修正後、保存済みのacknowledged checkpointから続行した。新規作成から無中断で一回成功した試験とは説明しない。最後に全tokenの通常返却を確認し、pause `088a5eca-8eab-4f45-b09f-aaae1af411c6`で保持した。privateな`/tmp/opencode/castloop-m6-test-9c80a9b8/acceptance.json`へsecret/本文なしの結果を保存する。
- 最初の`castloop-m6-test-a3b60278`は旧inspectorのexports省略拒否でlocal deploy_requestedを保持した。PUT再送/採用/削除せず残し、初期化済み・pausedとは扱わない。Worker version `e63497ad-051a-4b08-87ac-22a9deddb571`のGET観測はdeploy acknowledgementの代用にしない。

処理途中のconsumerは最終的に通常完了した。CPU/subrequest limit障害とは断定しない。local fixtureではShow/Episodeに317/359 R2 callsがあり、重複guard整理の検討余地はあるが、安全条件を外して制限を回避する修正はしていない。観測permissionの不足や時間経過だけでtokenの終了を認定しない。
