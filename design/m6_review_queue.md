# M6: 確認待ち事項と残る技術ゲート

更新日: 2026-10-01

管理者の指示に従い、判断待ちでも独立した開発は進める。これは承認依頼の一覧であり、以下を新たな承認済みpolicyと扱わない。公開停止・再開・削除コマンドは未提供。現行REST単一PUTの維持と未解決懸念U1の非ブロッカー扱いは決定済みで、再承認を求めない。

## まとめて確認する事項

- **削除後に保持する記録の内容・期間**: ID再利用を防ぐShow予約・制御record・Episode tombstoneは維持する設計。凍結request・publication commit marker・status/progress等の最小運用記録について、保持する項目・期間・エラーreasonに含められる情報を最終確認する。現在の削除inventoryはmarkerを保持候補に分類するだけで、実削除や保持期限を適用していない。
- **公開時の利用条件**: 設計第13節のHTTP 404/410/空feed 200、外部cacheの再検証、旧ID再利用禁止、進行中jobへ割り込まない仕様を最終レビューする。内部cache構成によるrequest/CPU/R2 readの増加は、専用環境で測定した結果と併せて確認する。mockテストだけで性能・料金を承認済みとは扱わない。

## 管理者の判断待ちではない技術残件

1. **upload/publication統合**: staging操作IDとdraft job IDの分離、単一PUT前の受付、size/内容照合、切断後のowner/generation照合回復・終了処理、既存publication consumerの新record対応。
2. **consumer invocationの安全な回復**: 現在のtokenは同jobの重複実行を排除するが、取得応答喪失・runtime強制終了ではブロックを保持する。稼働中invocationを解放せずに終了を確認する手順と、次のinvocationへの引継ぎを成立させる。時間/HEAD不在だけの奪取を追加しない。
3. **本番配信とpurge**: gatewayをdefault cache無効の入口へ接続し、cache有効named entrypointへの内部fetchと所有entrypoint内purgeを実装する。GET/HEAD/Range/304・再検証header・失敗時no-storeを実機回帰する。
4. **移行とcapability**: 読み取り専用planに加え、旧書込停止、atomicな移行受付、apply/途中再開、旧cache purge、100% Worker切替、対応機能照会と安全なrollbackを実装する。
5. **再開・物理削除**: restoreの検証→feed/purge準備→active化、削除の配信停止→batch削除→先頭から最終再列挙→tombstone完成、続行message・DLQ・remote retryを実装する。未知keyを黙ってprefix削除しない。
6. **接続と受け入れ**: 注入effectを実装して停止状態機械をQueueへ接続し、管理API・CLIの6操作、確認入力/dry-run、job-status/retry、README/help・復旧手順を完成する。専用Cloudflare環境とLinux x86-64単一バイナリで確認してからReleaseを判断する。

## 今回実装済みだが本番未接続

strictな制御/request/status/progress、Show CAS受付、reserved限定abandon、invocation token、完了解放receipt、移行inventory、削除対象ページ、lifecycle対応feed入力、Show/Episode停止状態機械、公開gateway。個々の自動テスト合格はM6全体の受け入れ合格ではない。

詳細は[M6設計](./m6_content_lifecycle_plan.md)、[実装ログ](./m6_implementation_log.md)、[U1と単一PUT方針](./m6_upload_recovery_options.md)を参照。
