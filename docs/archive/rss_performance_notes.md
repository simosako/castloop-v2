# RSSガイドから分離した測定上の注意

> 履歴資料。`rss_migration.md` にあった節を保存しています。数値は過去の測定であり、現在の性能保証や実環境操作の承認ではありません。現行の操作は[RSSガイド](../rss_migration.md)、検証の責務は[テスト設計](../../design/testing.md)を参照してください。

## Workerの時間ログと性能比較

対応WorkerのCloudflare Workers Logsを使用し、runtime/version・request/trace IDを照合する。現行経路には公開job IDはない。
保存ログの収集・CPU数値とapplication log・tail配送の不足は区別する。対象要求と対応しない記録や欠測を0msとして扱わない。

SQLiteでは通常Worker HTTP/cacheとDO HTTP/RPC/Alarmを区別する。通常Free HTTPは10ms、DOは既定30秒のCPU上限で評価し、異なるinvocationのCPUを1要求の上限として合算しない。
2026-10-17の旧方式の試験では外側/cache HTTP最大は3/5ms、公開probeは60/60対応したが、現行版や全invocation・未試験負荷の保証ではない。[過去の測定記録](../../design/archive/sqlite_size36_measurement_20261017.md)を参照。

診断ログは本文・秘密・任意例外文を含めない。sampling・保持・tail配送不足とCPU 0msを混同しない。v0.8.0の[限定的な実機確認](releases/release-v0.8.0.md#verification-and-limitations)はRSS一括取り込みを含まず、現行形式のRSS取り込みの実機性能・全Free適合は未実証。

実機試験には別承認が必要。旧`scripts/test-support/`の採取器は削除済みで、現行手順として実行しない。旧Queueのphase・R2カタログ・診断手順は[v0.5.2時点の資料](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/rss_migration.md)に保存する。
