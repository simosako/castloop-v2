# a8c7e54 新規r2性能試験 — 最初のShow公開待機で停止

## 結果

新規Workerのinit・独自domain設定・明示resumeは成功。既存run1入力を使った `publish-rss-import` は、最初のShow公開jobの300秒待機上限に到達してexit1となった。**36Episode公開とmetadata-only性能測定はまだ実施できていない。性能改善の判断は未実施。**

## 新規環境・保持状態

- commit: `a8c7e54e8c326ef238a2fcd9d672a27b002bec66`。製品source無改変、既存buildのhash/clean再確認済み。
- CLI SHA-256: `cf2a3756eb2cae8e237817fc39d106ec4674dde2983843cd11df8244595eb97a`。
- service: `rssperf-1012-r2`、bucket: `castloop-rss-perf-20261012-r2`。
- Worker: `castloop-rssperf-1012-r2-0f9dbe46`、version: `0f833389-f021-435c-bdf0-59205115e759`。
- hostname: `castloop-rss-perf-r2.otftalk.com`。
- workspace: `workspaces/rss-performance-20261012-r2`。
- 入力: `imports/rss-20261012-run1` 全116ファイル不変、36MP3 / 1,496,055,589 bytes。再download/原本編集なし。
- 旧updating環境/Issue #11の資源・journalには操作していない。

## 実施経緯

1. API GETで新hostname/service/bucket/route未使用・active/full Zone確認。CLI commit/hash/clean・入力hash確認、wait-helper6tests成功。
2. fresh init成功、paused/drained/M7 capability/runtime readiness確認。同commitの新Workerを作成し、compatible update経路は使っていない。
3. domain addは直後にDNS/TLS未検証で停止。DNS事前承認に従い1.1.1.1明示/TLS検証有効でDNS応答とpaused503を確認後、CLIが案内した**同じoperation ID** `1aa1d68f-af97-4af9-acf7-b7a9bf2e41c8` で検証を続行し成功。process限定TLS透過tunnelを閉じ、domain整合を確認して明示resume。OS/router/権限設定変更なし。
4. 新workspaceで `publish-rss-import` を1回実行。CLI全体354.900秒でexit1:

   ```text
   RSS publication is still pending; rerun this import only to inspect its acknowledged job
   ```

   全体時間は準備/staging/commitも含み、1回の要求やconsumerの測定値ではない。正式RSS待機の上限は300秒。

## 停止後の読み取り（1回ずつ、変更要求なし）

- cursor: `step=4 / phase=waiting`。
- Show job: `69a619df-9115-42e8-87db-e98947635863`。
- operation-status: **processing / ownership=held**。
- service-status: **open / invocations 1件**。
- target-show: **unfinished_show_operation=true**。
- したがって公開失敗・完了・所有権解放のいずれも推定せず、次のEpisodeへ進まない。Show consumerの遅延/停止原因は未確定。
- `.castloop` を `stopped-private-journals/` へ私有copy保存。原本cursor/journal/owner維持。元入力全116hash不変。

## 未実施・次の判断

Episode公開、全36配信照合、catalog36件整合確認、metadata-only計測、改善比較は未実施。新規公開jobに対するtail sessionもこの準備段階では作成していない。変更要求再送、timeout延長build、retry-job、owner/lock解除、pause/resume追加操作、資源削除、旧ホスト変更なし。GitHub共有は今回未指示のため未実施。

エラー時の停止方針に従い、ユーザーに報告して判断待ち。次に行うなら、まず受付済みShow jobのprocessing/heldが長引く原因を読み取りで調べる。現状のownerを無視して新jobに置換したり全36公開を再送したりしない。

主な証跡: `publish-import.stderr`、`publish-import.elapsed.json`、`cursor-after-publish.json`（私有原本）、`input-preservation.json`、`stopped-summary.json`、`stopped-known-job.stdout`、`stopped-service.stdout`、`stopped-show.stdout`、`stopped-private-journals/`、domain/DNS/init証跡、harness/plan snapshot、root活動log。公開には原本の秘密除去が必要。

## 承認後の原因調査（11:59 UTC完了、試験は未再開）

当該Show commitと一致するDLQ markerを確認。progressはfeed、公開先metadata/cover/feed/catalog未作成、Show execution tokenとservice invocation 1が残留。調査後も4つの耐久状態は初回snapshotとbyte一致、元116入力・local journal不変、製品source clean。

未解放execution tokenにより次consumer／明示retryを拒否する仕組みをコード確認。2commit×3完全mock case＝6成功／実HTTP0で、単発IO失敗なら解放して復帰できるが、catch/finallyまでIOが失敗すると今回の残留状態と再試行拒否を再現。これは旧4781fadにも存在し、実機の最初の停止原因やa8c7e54による新規回帰を確定する証拠ではない。カタログ構築、36Episode/MP3 upload、性能比較は未開始。

GraphQL既存token200で同Workerの例外2件等を確認したがjob/eventkindなし。履歴Workers Logs APIはdry照会1回403/code10000、権限/設定変更なし。直接原因確定にはDashboardの対象WorkerでUTC11:34〜11:36（JST20:34〜20:36）のQueue/exceptionログが必要。状態解除／再送／deploy／GitHub共有なし。

詳しい調査とエビデンス: [show-investigation/findings.md](../investigation/findings.md)、`show-investigation/final-validation.json`。
