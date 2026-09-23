# M0 技術検証実行計画

- 対象: [`initial_design.md`](./initial_design.md) のM0。最優先は **Show/Episodeを通じ、同一Showの未完了公開を原子的に1件だけ受け付ける**こと。
- 方針: 本番に近いCloudflareの検証用リソースで、最小のCLI呼び出し・Worker実験コードを動かす。結果を得る前に受付方式を確定しない。M1/M2の製品機能を完成させる計画ではない。

## 実行順と合格条件

| 順 | 検証 | 合格条件（観測するもの） |
| --- | --- | --- |
| 1 | **実環境・認証**: 専用のprivate R2 bucket、公開用Worker、通知先QueueとDLQを準備。Wrangler OAuthと環境変数のAPI tokenをそれぞれ使い、CLI相当の操作・必要な権限を確認 | 両認証経路から必要な操作が成功し、秘密情報をTOML・ログに残さない。作成済みリソースは識別・後片付けできる |
| 2 | **受付方式の成立性（最優先）**: `publish-show`と`publish-episode`が同じShowの受付枠を使う最小プロトタイプを作る。第一候補としてWorkerのR2 bindingによる単一オブジェクトの条件付き書き込みを試し、CLI→認証付き管理操作への経路も確認する | 別端末相当の並行要求（Show対Episode、Episode対Episode）で**勝者は常に1件**。敗者はcommit markerを作らず競合を返す。同じjobIdの再送・応答喪失後の再試行で二重受付しない。別Showの受付は妨げない。単なる「空き確認→通常PUT」やQueueの1並列設定には依存しない |
| 3 | **停止・解放・古い実行**: 予約直後／marker書き込み前、marker後／consumer処理中、公開反映後／purge前、完了直後の各点で停止させる。古い通知やDLQからの再投入を模擬する | 予約だけ残る場合もcommit・status・受付記録から管理者が現状を特定できる。`reserved`の取消しとconsumer開始が競合しても片方だけ成功し、`processing`以降は完了前に予約を解放できず、そのShowの次の公開をエラーにする。同じjobの再実行で完了・purgeへ収束するか、修復できなければ予約を残して止める。旧jobの通知は別jobの受付後に公開しない。期限だけで自動解放しない。条件付きDELETE等、利用可否を未確認の操作を前提にしない |
| 4 | **通知・失敗処理**: `staging/shows/.../commit.json`と`staging/episodes/.../commit.json`を最後に書く。`staging/` prefix・`commit.json` suffixのR2通知から同じmanaged Queueへ送り、1並列・1件batchのconsumerを使う | TOML/画像/MP3の個別uploadでは起動せず、両commitだけで起動する。重複配送でも同じjobを二重公開しない。一時的失敗は有限回retry後に単一DLQへ入り、恒久的失敗は理由をR2 statusへ残して無駄にretryしない。DLQ到達とstatusが自動同期しない場合の照合・回復手順が説明できる |
| 5 | **公開経路・cache**: 実際の`workers.dev` URLとprivate R2で小さなfeed・画像・MP3を配信。cache warm後にfeed/固定キー画像を更新し、Queue側からtag purgeを試す | GET/HEADと有効Rangeの`206`・無効Rangeの`416`、長さ・内容が一致する。warm時にcache hitを観測でき、purge後はfeed/画像が新内容になる。purge失敗時はjobを完了にせず、再試行で新内容に収束する。Queue handlerから対象entrypointをpurgeできないなら、その結果と成立する別経路を記録する |
| 6 | **音源・CLI**: Wranglerで300,000,000 bytesのMP3をuploadして読み戻し、失敗後の再実行を試す。CLIでMP3妥当性・durationを解析する | 上限サイズの一致（bytes/検証用digest）とdurationが確認でき、超過ファイルはupload前に拒否される。途中失敗後も下書きを壊さず再試行できる。Wranglerのversion、所要時間、失敗内容を記録する |

## 最優先検証の判定方法

- 受付記録はShow単位で所有jobIdを識別する。**条件付き作成が原子的であること、取得済み予約の置換・解放を他jobが奪えないこと**を、実Cloudflare上の並行試行と故障注入で確かめる。R2の条件付きPUTは候補であり、無条件DELETEや時間切れのlock再取得だけで安全と判断しない。
- 予約を保持したまま停止したjobと、既に公開反映したが未完了のjobを区別し、同じjobの再試行またはそのShowの停止に収束するかを確認する。**実行中のconsumerがいる可能性がある`processing`を管理者が解放し、新jobを開始する運用は許可しない。** 完了前の解放を拒否することを検証し、旧通知や旧jobIdの再利用で新jobが上書きされないことを確かめる。
- R2 bindingでこの停止方式を安全に実現できない場合は、**Queue構成を増やす前に**認証付きの管理経路と、原子的状態管理を担う最小の別手段を比較し、必要な変更点を設計レビューへ戻す。安全な停止・再試行経路が未合格ならM1のShow ID予約やM2の公開フローを確定しない。障害時の簡素化案は[`m0_failure_recovery_proposal.md`](./m0_failure_recovery_proposal.md)を参照。

## 記録と完了判定

実験ごとに[`m0_verification_log.md`](./m0_verification_log.md)へ使用したCloudflare account/plan・Wrangler version・Worker設定（秘密情報を除く）、操作・同時実行数、期待値/実測値、jobId・commit・受付記録・status・DLQの突き合わせ、HTTP status/header、失敗時の回復操作を記録する。課題は「再現条件／影響／採る案」を添えて[`initial_design_review_02.md`](./initial_design_review_02.md)の未決定事項へ反映する。

**M0完了:** 1〜6が合格し、特に2〜3の原子的受付・安全な回復経路が実証され、M1/M2で使う方式が文章化されていること。未合格時は代替案と追加検証を記録してM0継続とする。retry回数・保持期間などの運用値は実測結果を踏まえてM2までに確定する。

## 実装時の参照

- [R2 Workers API（条件付きPUT）](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 Event Notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Queues consumer設定・DLQ](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Workers Cachingのpurge scope](https://developers.cloudflare.com/workers/cache/purge/)
