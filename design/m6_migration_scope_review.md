# M6: メンテナンス移行の必要性の再評価

調査日: 2026-10-03

## 前提と結論

管理者から、まだMVP前であり、旧環境のデータを捨てて新バージョンで作り直すことも許容範囲だと説明された。この前提では、**既存データを保存したlegacy→M6変換を、新規M6サービスの完成条件にする必要はない**。一方、正常な配信/cache設定の検証、操作の排他、稼働中IOの扱いは、新規環境にも必要である。

推奨は「新規初期化」「互換性のあるWorker更新」「旧形式データの移行」を分けること。現在の移行機構全体を、将来の更新にも必要だからという理由だけで完成させるのは適切ではない。以下は調査と改修案であり、移行機構の削除・公開gateの解除・Cloudflare環境の撤去を実施したものではない。

## なぜ移行機構が必要になったのか

当初はv0.1.1/v0.1.2の公開snapshot、GUID、音源URL、revision、未公開draftを保持して更新する前提だった。M6には旧版と非互換な次の変更がある。

- 旧Showのreserved/processing/free受付recordを、lifecycle/generation/ownerを持つv2 controlへ変える。旧版にはEpisodeのlifecycle recordがないため初期化も必要になる。
- 旧CLIのREST直PUTや旧consumerが新しい制御を知らずに書かないよう、旧IOの終了と以後の旧書込停止を確認する必要がある。
- 旧default入口のcacheはlifecycle確認より先に応答できる。M6はcache無効gatewayとcache有効named entrypointへ変わり、旧cache/preview/routeを残した切替では停止・削除を迂回し得る。

したがって、**旧データ・旧URL・旧稼働環境を維持する場合**のpause/drain、inventory、凍結plan、CAS変換、bridge、cache撤去、cutover確認は根拠のある処理である。しかし、これら全部が「停止・削除という機能そのもの」の必須処理というわけではない。

## 現在のコードで過度に結び付いている点

| コード | 現状 | 見直す方向 |
| --- | --- | --- |
| `packages/cli/src/index.ts`の`workerSource` / `provision` | 新規`init`も現行のlegacy Workerを配備する | 新規M6初期化を独立した経路にする |
| `src/service-admission.ts`の`initializeServiceAdmission` | admissionをlegacy/openで初期化する | 空の新規サービスからM6を安全に初期化する |
| `packages/shared/src/service-admission.ts`の`readiness` | M6 modeにはmigration ID/plan hash、旧cache purge・旧IO終了などの証拠を必須にする | 通常runtime readinessと旧形式移行の証拠を分離する |
| `src/m6-routes.ts` / `src/lifecycle-delivery-gate.ts` | 配信・管理・consumerのgateが移行由来readinessと実行Worker versionを要求する | 現在versionの稼働検証は維持し、移行を経たこと自体は必須にしない |
| `src/service-admission.ts`の`claimServiceMigration` | `mode !== legacy`を拒否する | 現実装はlegacy→M6専用。一般的なM6→M6更新の機構と扱わない |

特にreadinessがWorker version IDに固定されるため、新versionをdeployするだけでは、schemaを変えない更新でも既存readinessと一致しなくなる。これは未検証versionを拒否する安全条件として意味があるが、**通常更新の検証・readiness更新経路が別途必要**である。現行legacy移行を完成させても、この問題は解決しない。

## MVP前とMVP後で必要な処理

| 状況 | 必要なもの | 不要または後回しにできるもの |
| --- | --- | --- |
| MVP前に別の新規Worker/bucket/Queueで作り直す | private資源・bindingの照合、M6 controlの新規作成、gateway/cache/管理API/consumerの実機検証、正常時・中断時の初期化記録 | 旧Show/Episodeの変換、旧inventoryの凍結plan、legacy bridgeの多段deploy |
| MVP後の互換性のあるWorker更新 | 必要なメンテナンス停止、処理の収束、対象version/configの照合、HTTP/管理/consumer検証、readiness更新と明示再開 | データ形式が変わらないのに全Show/Episodeを列挙・変換すること |
| MVP後の非互換な保存形式変更 | versionを指定した変換、条件付き書込、耐久progress、途中再開、変換前後の整合検証 | まだ要件がない汎用migration framework、無停止移行 |

将来にも残す価値があるのは、service CAS/pause/invocation registry、owner/tokenの安全な扱い、durable deploy journal、REST設定検査、HTTP配信検査といった小さい責務である。legacy形式のinventory/変換と初回bridge protocolは、将来の別schema変更へそのまま適用できる汎用実装ではない。必要な非互換変更が決まった時点で、その変更用の最小migrationを設計する方がよい。

## 作り直しでも省略できない安全条件

- 同じ旧Worker/URL/bucketを空にするだけでは、新規環境とは扱えない。旧cache、preview、Queue message、進行中request/PUTが残り得る。新規resource名・公開URLへ分離する方が単純であり、同じidentityを再利用するなら旧IO収束とcache/route撤去は残る。
- 新しい空bucketでも、設定/配備/管理経路/consumerの検証なしにready=trueへしない。存在しない旧移行についてfake migration IDやplan hash、旧IO終了receiptを生成しない。
- 通常のupload/publication/lifecycleにも必要なShow CAS、owner/generation、checksum/size、実行token、cache-safe delivery、unknown outcomeの保持は削らない。M6の300MB受け入れと単一バイナリの検証も維持する。
- 全資源を破棄することと、M6のShow/Episode削除後にtombstoneを保持する契約は別である。通常運用のID再利用禁止を緩めない。既に配信した外部コピーを回収できるとも説明しない。
- 旧Cloudflare環境の実際の撤去は、正確な対象・実行中処理・依存関係を確認した別作業とする。今回の「作り直し許容」を、即時のresource削除指示として扱わない。

## 推奨する次の改修順

1. runtime readinessからlegacy移行証拠への必須依存を分離する。fresh initializationと既存の移行完了を区別して検証し、現行のfail-closed動作を維持する。
2. 新規M6サービスの初期化を実装・検証する。現在の候補入口/CLI公開gateを、schema変更だけで開けない。
3. schema互換のM6→M6更新手順を、pause/収束→deploy/検査→readiness更新→明示再開の最小経路として設計する。unknown IO/旧versionの継続書込を時間やHEADで終了認定しない。
4. 管理者が2026-10-03に承認した順序に従い、旧形式データ変換の追加対応は本当に必要になった場合だけ行う。既存bridge/API/client/専用testの即時撤去とは扱わず、通常runtimeの安全テストは保持する。

上記1〜3の内部実装と自動テストを追加した。[新規初期化](./m6_fresh_initialization.md)と[通常更新](./m6_compatible_updates.md)を参照。公開CLI/HTTP接続・実runtime検証adapter・専用Cloudflare受け入れは残るため、利用可能なM6初期化/通常更新が完成したという意味ではない。

既存のメンテナンス停止許容方針は、この分離後も活用できる。今必要なのは無停止化や巨大な汎用状態機械ではなく、新規起動と通常更新に必要な検証を適切な層へ置くことである。
