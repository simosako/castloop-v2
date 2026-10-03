# M6: 新規初期化と稼働判定の分離

更新日: 2026-10-03

## 範囲

旧サービスのデータ変換を経ず、別名のWorker/private R2/Queue/DLQから開始する内部経路を実装した。既存資源を削除・採用する機能ではない。legacy移行用の`readiness`は互換性と監査のため保持し、新規起動には独立した`runtime_readiness`を用いる。架空のmigration ID・旧IO終了証拠・旧cache purge証拠は作らない。

通常の`init`とM6公開コマンドはまだこの経路へ接続していない。内部経路の自動テスト合格と、実Cloudflare上で利用可能なM6初期化の完成は区別する。

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
2. prepareがexact初期化ownerを確認し、named cache entrypointでtag purgeを実行した後、小さい固定requestを条件付き保存し、一回Queueへ送信する。
3. main Queue consumerがQueue名・実行version・request・初期化ownerを照合し、同記録へCAS receiptを保存する。重複配信は記録を書き換えない。
4. CLIが公開originの認証付きprobeを同URLで二回GETし、request/version/cache ownerと異なるinvocation IDを確認する。Workerも実default loopback fetchを二回呼び出す。
5. Workerが実管理handlerのstrict入力検証、初期化中の配信503、private pathの404/no-storeを確認する。検証前後のconfig・owner・record ETagと二つのREST snapshotを照合してから、共通CASでpausedへ進める。

REST snapshotは認証済み管理者から受け取るCloudflare観測値であり、Cloudflareの署名付き証明ではない。設定検査と実行記録を照合するが、競合するaccount deployerや侵害された管理者からの虚偽snapshotを防ぐ仕組みとは説明しない。初期化中は管理者による他の配備・設定変更を止める。

`publication_routes_verified`はここでは実管理routeの入力検証へ到達した意味であり、Show/Episodeの公開成功やpublication consumerの処理完了を証明しない。`cutover_verified`も新規空サービスの起動境界の意味であり、legacy IO/cache収束の代用ではない。named RPC/purgeの成功はcache HITの実測ではない。コンテンツ公開、cache HIT/purge後の本文、GET/HEAD/Range、300MBは後続の受け入れで確認する。

Queue statusの有限回待機はCLIの観測終了だけである。時間だけでowner/consumerを失効させない。prepare/complete/Queue送信の応答喪失は自動再送せず、既存記録とrequested journalを保持する。Queue receiptが未着なら完了しない。runtime-check記録にはtargetと固定receiptのみを永久保持し、secret・metadata本文・任意の例外messageを保存しない。

## 検証と残件

初期化・CAS競合・誤証拠・設定変更・応答喪失・journal/lock・REST資源衝突を自動テストした。既存の一つのcontent-flow結合テストも、新規初期化からShow登録・公開・改訂・停止/再開/削除へ通す経路に置き換えた。別の巨大なE2Eテストは追加していない。

認証付き初期化HTTP入口と実HTTP/loopback/Queue検証adapterは試験entryへ接続済み。自動テストはsimulated REST/cache/Queueであり、公開CLI/単一binary接続と専用Cloudflare環境での起動・公開受け入れは残る。通常candidateのready=falseとmanagement書込禁止は維持する。300MB受け入れ・unknown IO回復等のM6共通gateも省略しない。
