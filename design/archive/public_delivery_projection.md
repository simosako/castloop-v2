# 配信判定の事前生成

> v0.5.x以前のQueue/R2方式の履歴。v0.6.0以降の配信はDOの最新判定を使う。[現行設計](initial_design.md)を参照する。

2026-10-15。管理者が「管理処理で検証・事前生成し、HTTPでは最新の小さな配信判定だけ読む」設計の開発を承認した。
`feat/publication-queue-submit`の開発実装であり、main/v0.4.0 releaseは変更していない。
開発後の別承認で隔離環境への[互換配備・実機測定](public_delivery_projection_measurement_20261015.md)を実施した。
[feed CPU調査](feed_delivery_cpu_investigation_20261015.md)を受けた変更で、feedは改善したが内部音源GETに10ms超過が残り、全HTTPの達成は未確定。

## 採用方式

独立した判定ファイルへの非同期コピーではなく、**正本R2オブジェクトの`customMetadata`へ小さな配信projectionを保存する**。
管理/Queue runnerが従来のstrict schemaで本文を検証し、本文とprojectionを同じ条件付きPUTで保存する。
HTTPはR2 bindingのHEADで最新metadataだけを取得する。TOML/JSON本文や管理用の全schemaは読まない。

これにより「正本は非公開化されたが、別ファイルの配信許可だけ古い」という二重書込の不整合を避ける。
R2 REST PUTにCASやcustom metadata指定があるとは仮定しない。判定付き書込はWorkerのR2 bindingを使う。

| 正本key | `castloop_delivery` | 生成する情報 |
| --- | --- | --- |
| `system/service.toml` | `config-v1` | service ID、DLQ名 |
| `system/lifecycle-service.json` | `service-v1` | service ID、配信可否/互換経路、許可する実行Worker version |
| `system/show-publications/<showId>.json` | `show-v1` | Show ID、公開/未公開/削除、Show/feed generation |
| `system/episode-lifecycle/<showId>/<episodeId>.toml` | `episode-v1` | Show/Episode ID、公開/未公開/削除、Episode generation |

metadataのfieldは`castloop_*`の固定allowlist。タイトル、説明、email、secrets、owner/execution token、任意の例外messageはコピーしない。
本文のschema、既存key、generationやownerの契約は変更しない。

## 管理側の責務

`src/public-delivery-records.ts`の`putPublicDeliveryRecord`で生成・保存する。
正確なETagへの条件付きPUT、またはcreate-only PUTを必須とし、管理側の全文検証は弱めない。

- Serviceのpause/resume、invocation registry、更新・URL変更はservice admissionの既存CASと同時にprojectionを更新する。
  initializing/updating/paused/URL変更中やreadinessなしは配信不可。openでもreadinessの実行versionに束縛する。
- Show登録、staging/verification、publication、catalog/feed世代更新、unpublish/restore/deleteと完了時の全Show control書込へ接続した。
- Episode初期化、publication、unpublish/restore/deleteとShow削除時の子tombstone書込へ接続した。
- URL変更によるService TOML更新も本文と同じPUTでprojectionを生成する。
- 既存のowner/generation/execution確認、開始したIOのawait、purge後の完了、immutable媒体/revision保持は維持する。
  projection用の新しいQueueやtoken移譲・強制返却は追加しない。

raw PUT等でmetadataが消えた場合、新経路は本文parseにfallbackせず503になる。
古い許可をmodule/TTL cacheから復活させない。第三者のCloudflare操作を原子的なservice lockで禁止するものではなく、
他の配備・書込を止める従来のmaintenance運用も必要である。

## HTTP側の責務

`src/public-delivery-state.ts`がprotocol、識別子、配信可否、実行version、安全整数のgeneration、record sizeを最小限確認する。
metadataの欠落・未知protocol・破損・identity/version不一致は503/no-store。予約済みShowや公開済みEpisodeにcontrolがない場合も閉じる。
既知の未公開は404、削除中/削除済みは410とし、失敗時にcached responseへfallbackしない。

通常の初期化/互換更新を完了した`runtime_readiness`サービスでは次の順序になる。

```text
service admission HEAD: 配信可能・実行version
  → Service TOML HEAD: service identity・DLQ binding
  → Show control HEAD: 公開状態・Show/feed generation
  → audioだけEpisode lifecycle HEAD
  → generationに束縛したCachedPublicAssets
  → 保存済み本文をstreamで返す
```

active feedの入口は従来の**4 GET＋全文parse/全schema検証 → 3 HEAD＋小さいmetadata検証**。
audioはEpisodeのHEADが1回加わる。cache miss側の公開asset HEAD/GETは別で、GETの全呼出しがゼロになるという意味ではない。
未知/不存在/migration等の分岐では回数が異なる。

default gatewayのcache無効、内部cacheのgeneration、外向け`must-revalidate`、内部cache tagの除去、
GET/HEAD/Range/conditionalとWorker version headerは変更しない。RSS XMLは従来どおり公開runnerで生成済みのものを返す。

## 新規初期化・互換更新と旧移行の境界

- 新規初期化では、凍結config/実行version/runtime検証後、同じconfig ETagに束縛してService TOMLのprojectionを準備する。
  CLIの既存REST uploadに未確認headerを追加しない。初期化はpausedで完了し、明示resumeを要求する。
- 互換更新では、従来どおりpause/drain・空invocation・settled Show ownerを確認してupdatingへCASする。
  runtime検証後、exact target/ownerを照合しつつ既存Show/Episode controlを検証し、同じ本文の条件付きPUTで不足projectionを準備する。
  最後に検証済みconfig ETagを照合し、Service TOMLを準備してから新readinessをpausedで保存する。
- payload、公開feed、media、revision、staging/job記録をinventoryして書き換える機能ではない。
  control本文・generation・lifecycleは維持するが、metadata-only PUTでもR2のupload version/ETagが不変とは仮定しない。
  実際のPUT結果を使い、ETagを内容hashとして再計算しない。
- 準備中のread/validation/CAS/owner不一致やIO失敗はupdatingのままで、旧readinessへrollbackしたり自動resumeしたりしない。
  部分的なprojectionは単独では配信許可にならない。正式setup executionの未知IO・残存lockを無視した再実行は認めない。
  通常終了した自分のIOの失敗と未知結果は区別し、経過時間やHEADだけでtokenを返さない。
- Show事前検査の既存100件上限は維持する。projection準備は100件/page、各prefix最大100,000 recordで停止する内部budgetを持つ。
  runtime limit内に入る大規模更新や、再開用の汎用変換frameworkを提供したという意味ではない。

**旧移行中のdelivery window、および移行監査`readiness`だけを持つM6サービスは、明示された互換経路として従来の全文検証を維持する。**
service metadataの`migration`/`legacy`からだけこの経路へ入り、通常経路のmetadata欠落を救済するfallbackにはしない。
旧移行の凍結inventory/source ETagやcontrol本文をprojection準備のために変更しない。
正式な互換更新でprojection準備と新`runtime_readiness`を完了すると新経路へ切り替わる。
旧監査証拠から稼働判定をローカルで昇格したり、今回の開発承認を既存サービスのlegacy変換実行の許可と解釈したりしない。

## 検証と残る制約

- 通常feedの反復GETで3 HEADのみ、control本文GETやruntime probeなしを確認する。
- Show/Episodeの状態変更・世代更新、pause/version/DLQ/identity不一致、欠落/未知/破損metadata、CAS失敗、予約/orphan検出を回帰確認する。
- 既存controlのpagination/idempotent準備、本文保持、source/owner競合、準備IOのawait、失敗後にupdatingを保持し明示resumeなしに開かないことを確認する。
- 既存の正式CLI/Workerの公開・六lifecycle・cache/range・初期化/互換更新・旧移行試験も維持する。

実装後のローカル結果は`bun test` **1,132 pass / 0 fail（125 files）**、`npm run check`成功、
`npm run build:cli -- linux-x64`と生成バイナリの`--help`起動確認成功。
新しいprojection生成/読取の専用15テストも単独で成功した。

これらはローカルの自動テストであり、Cloudflare実機CPU/キャッシュ挙動の再測定とは区別する。
残る管理HTTP、起動/GC、Queue処理のCPUやservice全体のFree適合、Issue #13の恒久解消は証明しない。
開発後の別承認による実機結果は[測定記録](public_delivery_projection_measurement_20261015.md)を参照する。
追加配備・他endpointの最適化・権限/課金変更には、その結果だけで進まない。

## 参照

- [R2 Workers API: HEAD、customMetadata、conditional PUT](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [新規初期化](m6_fresh_initialization.md)、[互換更新](m6_compatible_updates.md)、[案Cの実機測定](async_management_measurement_20261015.md)
