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

## 手順と失敗

CLIは`prepared → resources_requested → resources_created → deploy_requested → deployed → initialization_requested → initialized`を記録する。source/metadataはhashだけを保存し、administrator secretやコード本文を保存しない。実際にPUTするmetadataも凍結hashと照合する。資源・PUT・初期化の応答喪失ではrequestedを保持し、自動再送・資源の採用・cleanupを行わない。部分作成を巻き戻したと説明しない。

serverはservice TOMLとadmission以外のobjectがあるbucketを拒否する。初期化targetはoperation/deployment/Worker version/config hashで固定する。同一targetの準備・完了は冪等だが、別target・既存legacy admissionを上書きしない。

稼働検証adapterは信頼された内部の読み取り専用callbackとして必須である。HTTP入力のtrue/falseをそのまま証拠にするAPIは設けていない。検証中の設定変更、別deployment、CAS競合は稼働へ昇格せず、未完了ownerを残す。

## 検証と残件

初期化・CAS競合・誤証拠・設定変更・応答喪失・journal/lock・REST資源衝突を自動テストした。既存の一つのcontent-flow結合テストも、新規初期化からShow登録・公開・改訂・停止/再開/削除へ通す経路に置き換えた。別の巨大なE2Eテストは追加していない。

これらはsimulated REST/cache/Queueである。公開CLI/初期化HTTP入口、実際の配信・管理・consumer検証adapterと専用Cloudflare環境での受け入れは残る。通常candidateのready=falseとmanagement書込禁止は維持する。300MB受け入れ・unknown IO回復等のM6共通gateも省略しない。
