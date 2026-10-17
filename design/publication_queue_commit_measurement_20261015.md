# Queue commit段階Aの実機測定

2026-10-15。[段階Aの実装契約](publication_queue_commit_stage_a.md)と[移譲案](publication_queue_delegation_options.md)の実装後測定。
管理者のcommit・Push・実機測定の指示に基づく。測定したコードは`a294c326a0457edae64ed8e7b43533753e0a07b8`。

## 結果

- **全7公開がpublished/releasedで完了。** 凍結Queue submissionもcompleted、最終serviceはopen・invocations空。
- 小容量Show更新、初回Episode、音源だけの更新に成功してから、既存36 EpisodeのShow更新とmetadata-only更新3回を実施した。
- **アプリHTTP commitの観測は0件。** 全7件で、同じQueue invocation内の`publication.queue_commit`と公開consumerの成功終了を取得した。
- この試験ではIssue #13のFreezeを再現しなかった。恒久解消やサービス全体のWorkers Free適合の証明ではない。
- 課金・権限変更、強制token返却、資源削除は行っていない。未終了ownerを持つ別の試験環境は変更していない。

## 測定環境と範囲

前回正常完了した隔離サービス`i13-bc656f35`だけを再利用した。
全Showのownerなし・service invocations空を確認し、正式バイナリのpause→互換deploy→readiness確認→明示resumeで更新した。
実行Worker versionは`635e4665-8e4b-43c0-a626-24814ff0b0a1`、開発バイナリSHA-256は
`c72c547356eb86b8b3f40d7b3dc4f1d144a783deb825e0f89e4536c7044d68f2`。
package versionは0.4.0のままだが、v0.4.0配布バイナリではない。

既存約1.5GB・36 Episodeの音源を再アップロードしていない。新規MP3 uploadは小さいclip2回の**161,002 bytes**だけ。
stagingとimmutable公開音源を両方保持するため、新しい音源payload保存は合計約322,004 bytesとなる。
通常規模metadata更新の前後でGUID・published_at・音源URL・byte length・SHA-256が変わらないことも、保持したbase revisionとcurrent metadataから確認した。
小容量音源のGET/HEAD/Range・全量hash、feed件数（小容量5、通常36）を検証した。

## Queue CPU・所要時間

CPUはlive tailの**invocation全体**の整数ms。commit単独のCPUとして切り出していない。
wallは`publication.consumer`のphase時間で、invocation開始前のconfig確認などは含めない。
R2待機時間やCLIのstaging・状態照会時間をCPUと混同しない。

| 公開 | 件数 | Queue CPU中央値 / 最大 | consumer wall中央値 / 最大 |
| --- | ---: | ---: | ---: |
| 小容量Show更新 | 1 | 283 / 283ms | 95.084 / 95.084秒 |
| 初回Episode | 1 | 295 / 295ms | 66.873 / 66.873秒 |
| 音源だけの更新 | 1 | 204 / 204ms | 64.936 / 64.936秒 |
| 36 EpisodeのShow更新 | 1 | 533 / 533ms | 103.827 / 103.827秒 |
| 通常Showのmetadata-only更新 | 3 | 184 / 317ms | 62.455 / 64.955秒 |

`publication.queue_commit`のmarker作成phase wallは2.800〜4.753秒だった。このphaseに対応するCPU値も公開処理全体の値であり、commitだけのCPUではない。
CLIのpublishコマンドは取得できた6件で7.895〜10.436秒。metadata-onlyの中央値は8.964秒。
staging開始から公開・drain確認までのmetadata-only中央値は110.371秒、最大121.184秒だった。
初回EpisodeのCLI・全体wallは途中の測定器停止で記録が残らず、推定で補完していない。Queue CPU/consumer wallは原本tailから取得できている。

Queuesの公式文書はconsumer CPUの既定上限30秒、wall上限15分と説明している。
今回の最大0.533秒CPU・103.827秒phase wallはそれらより十分小さいが、未知のaccount実効上限や将来件数の余裕を保証しない。

## 残るHTTP CPU

以下も**invocation全体**のCPU。各staging operationのjob identityを公開jobと混同せず、timing IDで重複を除いた。

| HTTP処理 | 観測数 | CPU中央値 / 最大 |
| --- | ---: | ---: |
| publication claim | 7 | 24 / 35ms |
| publication status | 242 | 15 / 52ms |
| staging claim | 8 | 39.5 / 75ms |
| staging begin | 8 | 18.5 / 33ms |
| staging settle | 8 | 22.5 / 44ms |
| staging finish | 8 | 72 / 139ms |
| staging status | 19 | 11 / 20ms |

**commitはHTTPから外れたが、FreeのHTTP 10ms目標はまだ未達。** claimだけのQueue移譲でも全体の問題は解消しない。
Worker settingsは`usage_model: standard`、明示limitsなし、logs/traces有効だった。subscriptionの読取は権限範囲で確認できず、契約・実効CPU上限をCPU観測値から逆算していない。
成功したHTTP要求の一時的な超過を、Freeの安定運用の余裕として扱わない。

## 一次停止と続行

一次測定は初回Episodeのpublished/released・submission completedまで進んだ後、service-statusに別の`m6_consumer` tokenがあったため測定器が停止した。
主Queue invocation自身のtoken返却終了はtailに記録されており、その後の読取ではregistryが空になっていた。
native markerの重複通知が開始する契約と整合するが、停止時のtokenと特定の重複messageの直接対応までは取得していない。
これは「完了直後は必ずregistry空」とした測定器の不適切な即時判定で、公開のFreezeではなかった。

測定器を同じruntimeのread-only drain待ちに修正した。時間切れなら保持して停止するだけで、tokenを強制返却しない。
既存receipt・同一バイナリ/Worker version・現在のpublished/releasedを照合し、完了済み2公開やdeployは再送せず、残り5件を続行した。
処理は独立process groupのtmuxで実行し、OpenCode側はpidfdの終了通知を待つだけとした。
状態照会の`publication_status_changed`には読み取りだけを再試行し、変更要求は再送していない。

## 観測の限界と証跡

7/7の主Queue invocation・7/7のclaimを取得。観測tailのruntime例外0、GraphQL標本357 groupsのerror groups 0だった。
GraphQLの最大sample intervalは10で、全例外不存在や未捕捉の重複consumer終了を証明するものではない。
[前回のHTTP受付測定](http_publication_commit_optimization_plan.md)のcommit CPU15〜34msは、この経路ではHTTP invocation自体がなくなった。
前回metadata consumer中央値240msに対して今回は184msだったが、対にした統制試験ではなく、CPU改善率や全体所要時間短縮を断定しない。

原本・queued/completed receipt・owner照合・tail health・GraphQL・binary/hashはGit管理外に保存した。

- 一次測定: `.local-test-data/results/20261015/queue-commit-70a6af48/`
- 続行・集計: `.local-test-data/results/20261015/queue-commit-1973a731/`
- 集計: `metrics-summary.json`、`graphql-summary.json`、`normal-immutable-audio-verified.json`

## 次の判断材料

commitの非HTTP化は確認できた。Free適合に向けた次の候補は、未承認の段階B（claim移譲）の契約具体化、
statusの認証付きR2 REST読取、staging finishのconsumer所有の検証実行への移譲である。
ステージング側でもunknown PUT・verification owner・IO終了の条件を維持し、HTTP tokenをQueueへ引き継いで解放させない。
今回はこれらの実装・権限追加・Paid移行を行っていない。

公式仕様: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)、
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。
