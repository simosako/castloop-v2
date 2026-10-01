# M6: 確認待ち事項と残る技術ゲート

更新日: 2026-10-01

管理者の指示に従い、判断待ちでも独立した開発は進める。確認待ちと明示的に承認されたpolicyを区別する。公開停止・再開・削除コマンドは未提供。現行REST単一PUTの維持と未解決懸念U1の非ブロッカー扱いは決定済みで、再承認を求めない。

## まとめて確認する事項

- **削除後に保持する記録の内容・期間**: ID再利用を防ぐShow予約・制御record・Episode tombstoneは維持する設計。凍結request・publication commit marker・status/progress等の最小運用記録について、保持する項目・期間・エラーreasonに含められる情報を最終確認する。現在の削除inventoryはmarkerを保持候補に分類するだけで、実削除や保持期限を適用していない。

### tombstoneと、確認したい記録の違い

**tombstoneは「このIDのShow/Episodeは削除済み」という小さな管理記録**。音源や番組情報のバックアップではなく、ID・deleted状態・generationなどを残す。削除済みと未知のIDを区別し、410応答・ID再利用禁止・古いjobの拒否に使う。system領域に置き、公開コンテンツとして配信しない。物理削除後もこれを残すことは、音源やタイトル/説明文を残すこととは別である。

確認したいのは主に、それ以外の**操作の記録**の扱いである。

| 記録 | 目的 | 確認内容 |
| --- | --- | --- |
| 削除済みIDの最小記録（tombstone・Show予約等） | ID再利用防止、削除済み判定、旧jobの拒否 | 再利用禁止を維持する間は記録が必要。保持項目を最小限にする |
| 凍結request・commit marker | どのjobがどの対象に何を要求したかの照合 | 完了後も保存する範囲・期間。旧job拒否/再送照合に依存する記録を不用意に期限削除しない |
| status/progress・エラーreason | 完了/失敗照会、中断回復、障害調査 | 完了後の保持期間と、reasonに保存してよい情報。未完了/回復中jobは期限だけで消さない |

**レビュー用の提案（未承認）**: M6では音源・cover・公開metadata等のpayloadを物理削除し、必要な小さい制御/操作記録は自動期限削除せず保持する。記録へタイトル・説明文・メールアドレス等の本文を複製せず、API token等のsecretも保存しない。エラーreasonは必要な診断情報に限定する。期限付きの監査cleanupは、安全に削れる依存関係を決めてから別途設計する。これならM6に複雑な保持期限処理を追加せずに済むが、運用記録が残ることをdeleteの説明へ明記する。

## 承認済みの公開時の利用条件（2026-10-01）

管理者が本資料へのannotationで「これでOKです」と承認した。

- 停止時HTTP 404、削除中/削除済み410、公開中の空Showのfeedは200。
- 外部cacheは再検証必須とし、削除したIDは再利用しない。
- 進行中publication/uploadへ停止・削除を割り込ませない。
- 毎要求の状態照会と内部cache呼出に伴うrequest/CPU/R2 read増を許容する構成。

これは仕様・構成の承認であり、測定済みの性能/料金値や実機受け入れ合格を意味しない。専用環境での測定・回帰テストは技術残件として継続する。上記と、確認待ちの運用記録保持policyは分離する。

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
