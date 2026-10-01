# M6: 承認済み方針と残る技術ゲート

更新日: 2026-10-01

管理者の指示に従い、判断待ちでも独立した開発は進める。確認待ちと明示的に承認されたpolicyを区別する。公開停止・再開・削除コマンドは未提供。現行REST単一PUTの維持と未解決懸念U1の非ブロッカー扱いは決定済みで、再承認を求めない。

## 承認済みの削除後記録保持（2026-10-01）

管理者が説明へのannotationで「これでOKです。記録して、実装に進めてください」と承認した。Show予約・制御record・Episode tombstone、凍結request・publication commit marker・status/progress等の必要な小さい管理/操作記録は自動期限削除せず保持する。音源・cover・公開metadata等のpayloadは明示的deleteで物理削除する。タイトル・説明文・メールアドレス等の本文やsecretを記録へ複製しない。期限付きの記録整理は後続とする。

### tombstoneと操作記録の違い

**tombstoneは「このIDのShow/Episodeは削除済み」という小さな管理記録**。音源や番組情報のバックアップではなく、ID・deleted状態・generationなどを残す。削除済みと未知のIDを区別し、410応答・ID再利用禁止・古いjobの拒否に使う。system領域に置き、公開コンテンツとして配信しない。物理削除後もこれを残すことは、音源やタイトル/説明文を残すこととは別である。

これとは別に、**操作の記録**を次の方針で保持する。

| 記録 | 目的 | 承認済みの扱い |
| --- | --- | --- |
| 削除済みIDの最小記録（tombstone・Show予約等） | ID再利用防止、削除済み判定、旧jobの拒否 | 自動期限削除しない。保持項目は最小限にする |
| 凍結request・commit marker | どのjobがどの対象に何を要求したかの照合 | 本文を複製せず、完了後も照合に必要な小さい記録を保持する |
| status/progress・エラーreason | 完了/失敗照会、中断回復、障害調査 | 完了後も必要な記録を保持する。reasonに本文/個人情報/secretを保存しない |

エラーreasonは必要な診断情報に限定する。期限付きの監査cleanupは、安全に削れる依存関係を決めてから別途設計する。M6に自動保持期限処理を追加せず、運用記録が残ることをdeleteの説明へ明記する。未完了/回復中jobも時間だけで記録を消さない。

## 承認済みの公開時の利用条件（2026-10-01）

管理者が本資料へのannotationで「これでOKです」と承認した。

- 停止時HTTP 404、削除中/削除済み410、公開中の空Showのfeedは200。
- 外部cacheは再検証必須とし、削除したIDは再利用しない。
- 進行中publication/uploadへ停止・削除を割り込ませない。
- 毎要求の状態照会と内部cache呼出に伴うrequest/CPU/R2 read増を許容する構成。

これは仕様・構成の承認であり、測定済みの性能/料金値や実機受け入れ合格を意味しない。専用環境での測定・回帰テストは技術残件として継続する。運用記録保持policyの承認も、実削除の実機合格とは区別する。

## 管理者の判断待ちではない技術残件

1. **upload/publication統合**: staging操作IDとdraft job IDの分離、単一PUT前の受付/一度限りの開始、明示的client終了確認、検証token、size/全量checksum/metadata/cover照合、完了/取消receiptとowner解放の基礎処理を追加した。管理API/既存CLIのREST PUTへ接続し、状態喪失後の回復手順、既存publication consumerの新record対応を完成する。未知の検証tokenは時間で奪わない。
2. **consumer invocationの安全な回復**: 全副作用をawaitした通常終了/例外終了からのtoken返却・続行/requeueを独立consumerで実装した。取得応答喪失・runtime強制終了ではブロックを保持する。稼働中invocationを解放せずに終了を確認する手順と、安全な回復を成立させる。時間/HEAD不在だけの奪取を追加しない。
3. **本番配信とpurge**: cache有効named entrypoint向けの内部fetch/stream配信と所有entrypoint内purgeを実装した。まだ本番main moduleへexport/接続しておらず、gatewayをdefault cache無効の入口へ接続し、CLIのdeploy設定と移行capabilityを完成する。GET/HEAD/Range/304・再検証header・失敗時no-storeを実機回帰する。
4. **移行とcapability**: 読み取り専用planに加え、旧書込停止、atomicな移行受付、apply/途中再開、旧cache purge、100% Worker切替、対応機能照会と安全なrollbackを実装する。
5. **再開・物理削除**: 削除開始のstate/feed/purge、owner-gated payload batchと先頭からのverification、最終purge/子tombstone/deleted/完了解放までを独立moduleで実装した。restoreも保存済みsnapshot検証→feed/purge準備→durable証拠→active化を実装した。凍結commit・consumer続行/同job requeueの基礎処理は追加済みだが、本番gate確認、本番Queue/管理APIへの接続と実機確認は残る。未知keyを黙ってprefix削除しない。
6. **接続と受け入れ**: 実行token付きeffect factoryとWorker binding用のfeed書込/内部purge/Queue送信を追加した。本番配信gateとQueue routingへ接続し、管理API・CLIの6操作、確認入力/dry-run、job-status/retry、README/help・復旧手順を完成する。専用Cloudflare環境とLinux x86-64単一バイナリで確認してからReleaseを判断する。

## 今回実装済みだが本番未接続

strictな制御/request/status/progress/commitとallowlist診断、CAS job journal、Show CAS受付、reserved限定abandon、invocation token、完了解放receipt、移行inventory、削除対象ページ、owner-gated payload batch/verification pass、削除開始/最終purge/子tombstone/完了解放、lifecycle対応feed入力、Show/Episode停止・保存済みsnapshot再開状態機械、通常終了consumer/続行/requeue、公開gateway、内部cached entrypoint/transport/purge。既存本番DLQ handlerの固定診断化は接続済みだが、lifecycle操作はまだ本番へ接続しない。個々の自動テスト合格はM6全体の受け入れ合格ではない。

詳細は[M6設計](./m6_content_lifecycle_plan.md)、[実装ログ](./m6_implementation_log.md)、[U1と単一PUT方針](./m6_upload_recovery_options.md)を参照。
