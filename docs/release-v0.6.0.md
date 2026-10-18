# v0.6.0向け変更点（未リリース）

本書は開発中の変更案内。version更新・タグ・配布公開・Cloudflare配備は別作業であり、現在の公開版はv0.5.2。

## 破壊的変更

- サービス設定`schema_version = 1`のQueue/R2方式をCLI／Worker／配布物から削除する。旧設定は管理要求・配備・鍵／journal作成前に拒否する。
- `castloop init`の既定はschema version 2、`sqlite-sequential-v1`。既存の`--publication-protocol sqlite-sequential-v1`は任意指定として受け付ける。
- Queue専用のdomain、retry/release、`update-service-continue`、`local-operation-status`、旧status familyを削除する。`operation-status lifecycle JOB`は維持する。
- 旧schema version 1からの移行command、設定・制御記録・journal変換、既存資源採用、fallbackは提供しない。

## 維持する機能

SQLiteの公開・一覧・unpublish/restore・RSS取り込み・code-only更新と限定的検証続行を維持する。サービス設定version 2、独立したShow/Episode/revision/requestのversion 1、公開key・protocol・binding/class名・compatibility dateは変えない。

物理delete、独自domain、blocked retry/release、一般cleanupは未提供のまま。旧Queue機能の穴埋めとして追加しない。

## 既存利用者

Queueサービスは対応するv0.5.x CLI/Workerで管理する。[v0.5.xガイド](queue_service.md)を参照し、version値だけを編集してSQLiteへ切り替えない。配備済みWorker・資源・公開probeは本変更だけでは停止・削除・改善されない。

SQLiteも未完了のinit/updateは凍結source hashへ束縛される。適合する旧CLIと原本journalを保持し、証拠不足の要求を昇格・再送しない。通常更新は同config/schema/namespaceでpause/drain後に実行し、検証後もpausedを維持する。

RSSのローカル取り込み→新規Showへの公開は維持するが、service schemaやsubscriberの移行機能ではない。旧ホスト撤去・URL切替・Cloudflare実環境変更は別の明示判断が必要。

ローカル試験はnative性能、全Free適合、300MB実機公開や万能復旧を保証しない。[実装計画・検証記録](../design/schema_v1_removal_plan.md)参照。
