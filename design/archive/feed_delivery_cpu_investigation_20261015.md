# 公開feed GETのCPU調査

2026-10-15。[案Cの実機測定](async_management_measurement_20261015.md)で残った最大11msを、保存済みログ・CodeGraphの現行ソース・ローカルCPUプロファイルから調査した。
対象ソースは`b3b3481`（実装は配備済み`e60a114`と同じ）。
**今回は調査のみ。実装最適化、新たなCloudflare配備・mutation・資源/権限変更は行っていない。**

この調査後、管理者承認で[配信判定の事前生成](../public_delivery_projection.md)を別の開発変更として実装した。
以下は`b3b3481`時点の調査であり、新経路の実機CPU測定結果ではない。

## 結論と測定範囲

- 今回測定した公開HTTPでは、10ms超過はfeed GETだけ。audio GET/HEAD/Rangeは最大6msだった。
  cover、登録、service管理、一覧、lifecycle、配備等は今回の公開CPU集計対象外であり、サービス全体でfeedだけとは断定しない。
- feed GETでRSSを生成したりEpisodeを列挙したりしていない。生成済みXMLをstreamで返している。
- 改善候補は、**キャッシュ返却の前に毎回実行する共通入口の設定parse・runtime/lifecycle検証・オブジェクト生成**。
  ローカルCPUプロファイルでもこの負担を確認した。ただし個々の11msの直接原因は既存ログから確定できない。
- feedだけに固有の重い処理、無限ループ、本文全量のbuffer化はこの経路では見つからなかった。
  「Episode数が増えたから」「キャッシュmissだから」「cold start/GCだから」という因果は未確定。

## 実機ログの確認

Cloudflare live tailの`cpuTime`はinvocation全体の整数ms。CLI所要時間やアプリtimerではない。

| 公開root feed GET | Episode数 | XML bytes | 3回のCPU | 超過時のwall |
| --- | ---: | ---: | --- | ---: |
| 小容量 | 6 | 4,836 | 11 / 4 / 5 ms | 611 ms（1回目） |
| 通常規模 | 36 | 119,903 | 3 / 4 / 11 ms | 484 ms（3回目） |

6回中2回が10ms超過、中央値4.5ms、最大11ms。小さいfeedにも超過があり、通常規模では3・4msも観測した。
このsampleからEpisode数・XML容量に比例するCPU増加とは判断しない。

別invocationとして観測された内部/cache-ownerのfeed GETは、小容量1ms、通常2ms。
公開rootのCPUと加算して1要求のCPUにはしない。通常3回目には対応する内部GETが見えないが、
内部event不在だけでキャッシュhitを証明したり、missだけを超過原因としたりしない。

公開HTTPの収録eventは`outcome: ok`、例外なし、アプリログなし。CPUの処理別内訳やGC情報はない。
GraphQLも対応期間の最大CPU約11msを補助確認できるが、処理別の帰属は得られない。
wallの611/484msにはR2/RPC等の待機を含み、CPUの11msとは別である。

## 現行ソースの実行順

通常のopen/active feed GETでは、キャッシュが有効でも公開入口で次を実行する。

| 順序 | 処理 | ソース |
| ---: | --- | --- |
| 1 | URL/公開path/method確認 | `src/m6-routes.ts:101` |
| 2 | `system/service.toml` GET、TOML全文parse、ServiceConfigのstrict Zod検証、DLQ binding照合 | `src/m6-runtime-readiness.ts:17`、`src/m6-routes.ts:54` |
| 3 | `system/lifecycle-service.json` GET/strict検証、migration分岐 | `src/m6-routes.ts:64` |
| 4 | 同じservice recordを再GET/strict検証、M6 readiness・実行version・open・URL変更状態確認 | `src/service-admission.ts:17,33,43` |
| 5 | 公開path再確認、`system/show-publications/<showId>.json` GET/strict検証、active/generation取得 | `src/lifecycle-gateway.ts:15`、`src/lifecycle-control.ts:400` |
| 6 | path/props再確認、URL/Headers/Request生成、generationに束縛した`CachedPublicAssets`呼び出し | `src/lifecycle-cache.ts:73` |
| 7 | 外向けCache-Controlの設定・内部cache tagの除去、Response再生成 | `src/lifecycle-gateway.ts:24` |
| 8 | Worker version header追加、もう一度Response再生成 | `src/m6-routes.ts:115` |

**通常経路では入口だけで4回のR2 GET（Service TOML 1、service admission 2、Show control 1）。**
readinessのversion確認はrecordの照合であり、公開入口で毎回`describeRuntime()` RPCを行うわけではない。
不存在・migration・audio等は別分岐なので、この4回を全要求共通の固定回数とは扱わない。

キャッシュ側の実処理が走る場合、`serveCachedLifecycleAsset`は公開assetのR2 HEAD、条件付きGET、stream Responseを実行する。
XMLのparse/render、Episode metadataの列挙、`arrayBuffer()`での全量読取はない。
feedのShow control読取にもEpisode数分のループはない。

入口はcache無効、`CachedPublicAssets`だけcache有効という分離が
`packages/shared/src/m6-worker-deployment.ts:32`にある。
そのためassetがcacheにあっても、最新の公開可否確認は省略されない。これは非公開化・削除後の配信を防ぐための仕様である。

## ローカルCPUプロファイル

新たな依存を追加せず、Bun 1.4.2の組み込み`--cpu-prof`/`--cpu-prof-md`を使用した。
実際の`fetchM6ManagementIntegration`を呼び、service設定・記録のparseを通した。
R2/cache bindingはメモリ内stub、Show controlは合成値、キャッシュ応答本文は空とし、ネットワーク・PUT・purge・enqueueは実行しない。
構造確認でも上記4 GETと1 cache loopback、RSS本文の読取なしを確認した。

入口だけのCPU samplingはwarm-up後20,000回×3。ローカルprocess CPU中央値は約122µs/回だった。
主なsampleには次が含まれる。

- TOML parserのinclusive比率約19%。
- Zodのstrict object検証、URL検証等。
- native JSON parse、Response、URL、Request、Headersの生成。

別のcomponent試験（各3回の中央値）では、Service TOML＋全Zod検証31.6µs、
service JSON＋全検証6.1µs、Show JSON＋全検証8.2µsだった。
ServiceConfigは配信に使わないaccount/Queue/URL等の検証も含む。

**これらはローカルBunでの相対的な候補確認であり、Cloudflareの処理別CPUではない。**
V8ではなくBunの実行系であり、実R2/RPC/cache、body streaming、isolate起動を再現していない。
sample比率にはstubや試験driverも含む。inclusive比率は重複するので加算しない。
別試験のcomponent時間を入口CPUから差し引いて実機の削減量としたり、11msへの換算に使ったりしない。
GCやcold startが実機の超過を起こした証拠にもならない。

## 改善候補と優先順

1. **公開入口の毎回のService TOML全文parseを避ける。**
   小さい変更なら、毎回のR2確認は維持し、正確なbucket/key/ETagに束縛したparse済み設定の限定的な再利用を検討する。
   設計変更なら、配備/readinessで証明済みのservice identity等を使い、管理用の全ServiceConfigを公開hot pathから外す。
   bindingを追加するだけで設定整合性確認を省略せず、config変更・互換配備・旧version・不正設定のfail-closed契約を先に定める。
2. **service admissionの2回読取・全検証を整理する。**
   migration分岐とnormal runtime確認でsnapshotを共有できるか検討する。
   現状は別時点の再読取でもあるため、単純削除ではなくpause/update/migrationとの競合をレビューし、
   最新状態、readiness/version、URL変更中の拒否を維持する。R2待機短縮とCPU削減は分けて測る。
3. **公開pathのparseとResponse/header加工を集約する。**
   正規化済みasset contextを下位へ渡し、入口側2回のResponse再生成を整理する。
   信頼境界でのpath/props検証、generation cache key、GET/HEAD/Range/conditional、version header、
   内部cache tagの除去と外向け`must-revalidate`は保持する。
4. **起動/GCやpublic・管理・Queueのmodule共有は、実機profileが必要になった場合に検討する。**
   現時点では超過原因とする証拠がなく、最初から別Worker化はしない。
   物理分離するなら現行のpublic/cache-owner version照合・readiness・配備契約を再設計する必要がある。

公開可否recordのTTL cache、外側default exportのcache有効化、R2のpublic化、安全確認の削除は採用しない。
非公開化・削除・maintenance後に古い公開応答を返す方法で10msを達成しない。

実機の2件を原因まで特定するには、追加承認後のCPU profiling、
または同一条件の反復GETとbounded診断ログ（処理経路・読取回数・phase wall等）が必要。
アプリtimerはwallであり、Workersの`performance.now()`も純粋な計算のCPU測定器にはならない。
診断ログ自体のCPU負担も測り、metadata本文・secrets・任意のexception文字列は記録しない。

## 証跡と参照

Git管理外に以下を保存した。raw evidence・fixture・profiler出力はGit/GitHubに追加しない。

- 実機: `.local-test-data/results/20261015/management-95caf675/`内のpublic delivery tail/checksとGraphQL。
- 調査script: `.local-test-data/investigate-feed-local.ts`。
- component試験: `.local-test-data/results/20261015/feed-investigation-b3b3481/`。
- 入口のみのprofile: `.local-test-data/results/20261015/feed-investigation-full-b3b3481/`。
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/)、[CPUとwall](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)、[Workers performance API](https://developers.cloudflare.com/workers/runtime-apis/performance/)。
