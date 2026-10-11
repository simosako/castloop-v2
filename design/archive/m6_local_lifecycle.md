# M6: lifecycle previewから明示確認・durable実行へ

未公開`previewLocalM6Lifecycle`はtargetのgenerationを読み、UUID/秒精度timestampを一度生成し、strict schemaでcanonical化した要求をdry-runへ渡す。返すplanはexact要求とpreviewだけで、current Episode本文を含まない。local file、R2 record、Queue、tokenに書き込まない。

previewはoperation/delete authorizationを与えず、missing/ineligible/paused/unfinishedのblockersを表示するためのsnapshot。要求ID・generation・timestamp・actionを変えずに管理者へ提示する。request hashはcanonical要求のSHA-256であり、入力objectのproperty順序に依存したhashを確認へ流用しない。

`prepareLocalM6Lifecycle`はexact service/request/hash付きeligible previewと別途明示されたconfirmationを検査し、private prepared journalを保存する。confirmationを自動生成しない。deleteにはirreversible/retained-records両acknowledgementも必要。requested/残存lock/異なる凍結要求は拒否する。

`executeLocalM6Lifecycle`はこの準備に続けて既存runnerのclaim/commitを実行する。古いpreviewでもserverのatomic admission/current generation/owner/runtime検査を省略しない。commit成功はconsumer完了ではなく、応答喪失はrequestedのまま非再送とする。

new Show/二Episodeの全体flowにも接続し、六操作をsnapshot→dry-run→明示確認→local journal→管理API→consumerまで通した。確認欠落/hash変更/foreign plan/blockers/stale generation/lost acknowledgementを個別回帰した。実Cloudflare/公開CLIではない。

## 試験専用standaloneへの接続（2026-10-04）

`--m6-test` buildだけに次の入口を接続した。service IDとWorker/R2/Queue/DLQの専用prefixを先に検査し、通常binaryでは使えない。

```sh
castloop-m6-test-linux-x64 preview-show-lifecycle SHOW unpublish
castloop-m6-test-linux-x64 preview-episode-lifecycle SHOW EPISODE delete
castloop-m6-test-linux-x64 lifecycle-execute PLAN_JSON REQUEST_SHA256 confirm
castloop-m6-test-linux-x64 lifecycle-execute PLAN_JSON REQUEST_SHA256 confirm-delete-retain-records
castloop-m6-test-linux-x64 operation-status lifecycle JOB_UUID
castloop-m6-test-linux-x64 lifecycle-retry JOB_UUID REQUEST_SHA256 confirm-delete-retain-records
```

previewのJSONを保存し、対象・action・blockers・hashを確認してから別途confirmationを渡す。実行時にpreviewからconfirmationを自動生成しない。deleteの確認文字列はpayloadの不可逆削除と小さい管理記録/IDの永久保持を承認する。planはbounded/no-follow readerから読み、既存helperでidentity/hash/eligibleを検査する。

`lifecycle-committed`はQueue処理完了ではない。完了はstatus/progressのfinished・purge確認・owner解放・invocation返却を照会する。retryは元のprivate journal、同じhash、明示confirmationを使い、serverのowner/token条件を省略しない。unknown outcome・残存lock・実行中tokenをこのcommandで解除しない。Worker/bucket/QueueなどのCloudflare資源自体は削除しない。

公開CLI、unknown outcome/lock/tokenの外部復旧、実機受け入れ・release案内は残る。
