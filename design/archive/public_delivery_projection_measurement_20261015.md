# 配信判定事前生成の実機測定

2026-10-15。管理者がcommit・Pushと性能測定を承認し、前回と同じ隔離環境へ互換配備した。
**公開feedのCPU中央値は両規模とも5→2msへ改善。完全収録した新版60 GETの最大は4msだった。**
ただし別invocationの内部音源GETで11msを観測し、全HTTPの10ms達成・service全体のFree適合は未確定。

## ソースと配備

- ソース: `db87bb48b1a17488e09c00ca19b627ac9a0f6d98`、`feat/publication-queue-submit`。測定前にcommit/Push済み。
- Linux開発バイナリSHA-256: `ab6b3de292db3328c08af96d5c3e7edab1796425cd8452325549349e8aa64b62`。
  package表示0.4.0はreleaseとの区別に使わず、SHAと配備versionで識別する。
- 対象はサービス`i13-bc656f35`、Worker `castloop-i13-bc656f35-466ebe5f`、private bucket `castloop-test-i13-bc656f35`だけ。
- 旧Worker `26e3452e-3f35-4b57-a1c6-ee84fbd67d55`→新Worker **`3d7d8433-3c4b-44a8-8276-e85e5f0a1e42`**。
- pause ID `0a07ce55-4f11-4626-ab2c-2d2ff6102e46`、update operation `fa29c98f-9dba-403f-aeac-e4e5c5612a48`、
  deployment `9da66d4c-0ae5-4215-a062-08adc46c199a`。
- service/config hashは`5cd98b024d66675a2d2d753500c16bc2237ab2fc6ca0f8d6358c7dfc3a55093b`のまま。
- 正式CLIでpause/drain再確認→deploy/readiness→paused完了→明示resumeを一度だけ実行した。
  deploy command wallは72.235秒。配備やresumeの再送はない。
- ローカルは1,132テスト成功、TypeScriptチェック、Linux build/`--help`起動確認成功。

資源の作り直し/削除、owner/token強制返却、権限・課金・CPU limit変更はない。main/tag/releaseも変更しない。
Worker設定は前後とも`usage_model: standard`、`limits: null`で、observability設定も一致。
この値をFree/Paidの判定や実効CPU上限の証明には使わない。

## 実行範囲と観測停止

当初は旧版のfeed各20 GET→互換配備→新版各30 GET/媒体確認→metadata-only公開各1件→公開後の再測定を計画した。
実際には以下の範囲を実行した。

1. 既存version、open状態、service registry、2 Showの現在owner、exact Queue/consumer設定をread-only確認。
2. 旧版の小容量6件/通常36件feedを各20 GET、全40件のCPUを収録。
3. 上記の互換配備・明示resumeが成功。
4. 新版の小容量feed 14 GETはすべて成功したが、CPU eventは13件しか得られず停止。
   socket/registryはhealthy、truncationやruntime exceptionはなかった。欠落理由は未確定で、低CPUやcache hitとは推定しない。
5. 配備を繰り返さず、新version/open/現在ownerなしを再確認し、独立したread-only補完測定へ切り替えた。
   小容量→通常のfeed各30 GETと、HEAD/304/cover/audio確認13要求、**合計73要求すべて成功、CPUも73/73件収録**。

**metadata-only公開2件と公開後の再測定は実行していない。** 観測停止後はcontent mutationを追加せず、feed HTTP比較を優先した。
新規MP3 PUT・content publicationはともに0。既存の6件/36件Show、feed、音源をそのまま再利用した。
今回の実機試験を公開処理全体やIssue #13の再受け入れとは扱わない。

### URL query識別子の補正

配備前の別attempt `delivery-50a5ba29`も、read-only baselineで停止した。
小容量feed 20 GETは成功したが、Cloudflare tailがqueryのUUIDを`REDACTED`へ置換し、要求とCPU eventを照合できなかった。
そのattemptの正式CLI commandはservice-status/list-shows/target-showだけで、pause/配備/公開は実行していない。

追加のread-only診断で、`X-Castloop-Probe`のUUIDとCF-Rayは取得でき、6要求/6 root eventを照合できた。
以降は専用ヘッダーを使い、内部cacheには転送しない。製品ソースの変更ではなくGit管理外のdriverの修正である。
初回は20要求に15 root eventしか収録されなかったため、そのCPUを主比較へ混ぜない。

主attemptでは各要求のCPU eventを待ち、さらに300ms間隔を置いたが、上記の配備後1件が未取得だった。
補完測定は1秒間隔で読み取り、末尾のtail到着も待った。
完全収録した73件と先行attemptの不完全な14件を分け、欠落を隠して100%収録としない。
保存済みWorkers Logs APIへの照会は403で取得できず、tokenの権限は増やしていない。

## CPU結果

Cloudflare live tailの`cpuTime`は**invocation全体の整数ms**。アプリtimerやCLI wallではない。
外側gatewayと内部/cache-ownerは別々に扱い、CPUを加算しない。p95はnearest-rank。

### feed GETの主比較

| 公開root feed GET | 旧版 n | 旧CPU 中央値/p95/最大 | 新版 n | 新CPU 中央値/p95/最大 | 10ms超過 旧→新 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 小容量・6 Episode、4,836 bytes | 20 | 5 / 19 / 21 ms | 30 | 2 / 3 / 4 ms | 2/20 → 0/30 |
| 通常・36 Episode、119,903 bytes | 20 | 5 / 6 / 6 ms | 30 | 2 / 3 / 3 ms | 0/20 → 0/30 |

旧40件・新60件はそれぞれ全要求とCPU eventを照合した。responseのCF-Rayは全件NRT。
配備前後で各Showの本文bytes/hashが同じことも確認した。
先行する配備直後の小容量13 CPU sampleは3～7msで、別に1件未取得がある。
**その13件も含む収録済み新版feedの最大は7ms**であり、欠落した1件まで10ms以下と断定しない。

invocation wall中央値は小容量469→314ms、通常511→318.5msだった。
これは公開GET単体のwallで、staging/publicationの総所要時間ではない。今回、新しい公開処理の速度は測定していない。
同じcoloでもisolate/JIT/ネットワーク等を統制したpaired実験ではなく、初回の高CPUをcold startと断定しない。

### 公開assetsと内部invocation

補完測定の追加13要求は、feed GET/HEAD/条件付き304を各Show、cover GETを各Show、
音源HEAD/Rangeを各Show、小容量音源全量GETを1回。
root CPUはすべて最大4ms以下で、200/206/304、HEADの本文なし、Rangeのoffset/length、
小容量MP3の全量checksum、外向け`must-revalidate`を確認した。管理者側では大きい音源を全量download/uploadしていない。
内部Cache/R2 fetchの転送量は計測しておらず、HEADに伴う内部GETの全量読取までゼロとする意味ではない。

一方、**小容量音源の内部/cache-owner GETでCPU 11ms、wall 291ms**を観測した（05:53:45 UTC）。
GraphQLの同秒NRT・同version・1 requestのgroupもCPU最大11.77msで整合する。
外側の音源HEADは3msだったが、内部CPUと合算せず、内部の超過も隠さない。
この1件から、MP3サイズ・cold start・GC等が原因とは確定しない。

GraphQLは補助証跡。feed補完窓では小容量32 groups/32 requests、CPU最大4.86ms、
通常30 groups/30 requests、最大3.41ms。assets窓は17 groups/17 requests、最大11.77ms。
各窓の最大sample intervalは1、error groupは0だった。
内部invocationや秒単位の集計を含むため、個別要求の復元や完全収録の代用にはしない。

## 終了状態と制限

- 収録tailでruntime error/exception/truncationはなし。CPU 11msの内部GETもoutcomeはok。
- 最終read-only snapshotは新version/open、`invocations: []`、2 Showとも現在ownerなし、generation 1254。
  snapshotや成功応答からglobal Queue backlogなし、未知IOなし、他環境の回復権限は推定しない。
- 試験tmux、Bun runner、pidfd監視は終了。背景の試験processは残していない。
- 制御情報の事前生成とfeed入口の改善は、この範囲の実機で確認できた。
  **内部音源GETの10ms超過、管理HTTPの未測定範囲、先行attemptの欠落1件があり、全サービスのFree適合は宣言しない。**
- 公開操作は0なので、Issue #13の公開freezeの恒久解消や、新コードでのpublication実機回帰完了も主張しない。
  今回の承認だけで別endpointの最適化・別Worker化・強制token返却・権限/課金変更には進まない。

## 証跡

- 主attempt: `.local-test-data/results/20261015/delivery-b89c6ec2/`。
  補完は`readonly/`、集計は`observed-metrics-summary.json`、GraphQLは各窓の`*-graphql*.json`。
- 配備前の停止/診断: `.local-test-data/results/20261015/delivery-50a5ba29/`。
- raw tail、CLI stdout/stderr、frozen binary/driver、response hashes、health、GraphQL、hash manifestはGit管理外。
  API token・管理鍵・元metadata/媒体をGit/GitHubに追加しない。
- [配信判定の事前生成](../public_delivery_projection.md)、[案C測定](async_management_measurement_20261015.md)。
