# castloop v0.6.0

> 旧版のリリース記録です。現行の操作は[利用ガイド](../../README.md)を参照してください。

SQLiteサービス単独に整理したLinux x86-64向けCLIです。サービス設定schema version 1のQueue/R2方式を削除し、新規初期化はschema version 2を既定にします。インストールだけでは配備済みWorker・資源・公開状態は変更されません。Cloudflareへの配備は別の明示操作です。

## 破壊的変更

- サービス設定`schema_version = 1`のQueue/R2方式をCLI／Worker／配布物から削除する。旧設定は管理要求・配備・鍵／journal作成前に拒否する。
- `castloop init`の既定はschema version 2、`sqlite-sequential-v1`。既存の`--publication-protocol sqlite-sequential-v1`は任意指定として受け付ける。
- Queue専用のdomain、retry/release、`update-service-continue`、`local-operation-status`、旧status familyを削除する。`operation-status lifecycle JOB`は維持する。
- 旧schema version 1からの移行command、設定・制御記録・journal変換、既存資源採用、fallbackは提供しない。

## 維持する機能

SQLiteの公開・一覧・unpublish/restore・RSS取り込み・code-only更新と限定的検証続行を維持する。サービス設定version 2、独立したShow/Episode/revision/requestのversion 1、公開key・protocol・binding/class名・compatibility dateは変えない。

物理delete、独自domain、blocked retry/release、一般cleanupは未提供のまま。旧Queue機能の穴埋めとして追加しない。

## 既存利用者

Queueサービスは対応するv0.5.x CLI/Workerで管理する。[v0.5.xガイド](../queue_service.md)を参照し、version値だけを編集してSQLiteへ切り替えない。配備済みWorker・資源・公開probeは本変更だけでは停止・削除・改善されない。

SQLiteも未完了のinit/updateは凍結source hashへ束縛される。適合する旧CLIと原本journalを保持し、証拠不足の要求を昇格・再送しない。通常更新は同config/schema/namespaceでpause/drain後に実行し、検証後もpausedを維持する。

RSSのローカル取り込み→新規Showへの公開は維持するが、service schemaやsubscriberの移行機能ではない。旧ホスト撤去・URL切替・Cloudflare実環境変更は別の明示判断が必要。

## 検証・性能情報

- ローカル439テスト成功、TypeScript検査、Linux単体binary build・binary smokeを確認。GitHub CIでもbuild・smoke成功。
- v0.6.0への版番号更新後も同じ検査を再実行し、組み込みWorkerのsource SHA-256が実機合格時の`4d0411acc4edea734b098321307d8813b2d73b9902ce8c0e2bdd95aac643f9c6`と完全一致することを確認しました。
- 新規Cloudflare隔離環境で、既定init、短尺3件＋通常36件のRSS公開、非公開化・復元、Worker更新後の保持を確認。計43 job succeeded、全39音源の全量hash・HEAD/Range/304・cover・private path拒否を確認しました。
- 通常36件・1,496,055,589 bytesは**485.53秒（約8分6秒）**、短尺3件は25.99秒。upload/readback・逐次公開・purge・最終RSS照合を含むcommand全体のwall timeであり、Worker CPU時間ではありません。
- 保存ログ1,985 invocationを確認。通常Workerは外側HTTP最大**3ms**、cache HTTP最大**5ms**、cache RPC最大**2ms**で、取得した1,047件は10ms以内。DOはHTTP最大26ms、RPC最大2ms、Alarm最大7msで、通常Workerの10ms枠とは別の既定30秒枠です。
- Linux binaryの整理前後は83,580,384→82,621,920 bytes（version更新前の比較）。runtime TSは17,653→4,997行。速度改善や将来負荷の性能保証ではありません。

Worker更新はnative反映待機で一度停止しましたが、verified checkpointから再配備せず明示verifyで完了しました。初回の公開試験は外側240秒timeoutの設定ミスで中断したため、途中結果を再利用しない新規環境で全件を再試験しました。異常終了後の統一CLI診断・安全な回復/cleanupは[Issue #40](https://github.com/simosako/castloop-v2/issues/40)の別機能です。

記録：[実装計画](../../../design/archive/schema_v1_removal_plan.md)、[合格サマリー・CPU観測条件](../../../design/archive/schema_v1_removal_live_test.md)。保存ログの全件回収、全Free適合、300MB実機公開、U1解決や万能復旧は保証しません。承認済み試験環境2件は[廃棄済み](../../../design/archive/cloudflare_issue24_cleanup_20261018.md)で、保持環境とローカル原本・journal・証跡は維持しています。

## 配布

GitHub Releaseの`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得してください。管理端末にはBun・Node.js・Wrangler・別R2 S3 credentialsは不要です。macOS/Windows向けbinaryは配布しません。
