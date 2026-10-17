# HTTP受付に残る固定負担の改善計画

2026-10-14。調査対象はcommit/Push済みの`818c642`。
branchは`fix/issue-13-episode-freeze-diagnostics`。
**次の改修のレビュー用計画であり、この文書の追加では製品コードやCloudflare環境を変更していない。**
既存の[Queue検証集約・実測](http_publication_commit_optimization_plan.md)の続きとして読む。

管理者からHTTP以外の後続実行への移譲を検討するよう追加指示された。
[CLIから直接Queueへ送る案](publication_queue_delegation_options.md)を優先して比較する。
以下は受付契約を変えない場合と、移譲後に残るHTTP/consumer負担の補助案として保持する。

## 結論と推奨順序

詳細検証は既にHTTPから除いた。次はservice admission/runtime確認の責務を整理し、
現在値を確認するためのR2読取と、同じ内容をparseし直す処理を分ける。

1. **serviceの取得・返却に使う検証済みsnapshotを共有する。** 受付契約を変えず、低リスクな変更から進める。
2. **正式HTTP commitだけ、同一Workerのruntime probeをrequest内で再利用する。** 一般のgateやconsumerへ広げない。
3. **毎回現在値を取得しつつ、本文が完全一致するcontrolの再parseを省く。** 特にEpisode lifecycleのTOMLを対象にする。
4. 実装後に測定し、足りなければmanifestの検証済みreceiptやadmissionの非同期化を別途判断する。

事前の大規模測定を必須にしない。既存fixtureの操作数を変更単位ごとに確認し、改修後に実機CPUを比較する。
GET数の削減率をCPU改善率へ換算せず、**10ms達成は現時点では保証しない**。

## 現在の負担

実機のHTTP CPUはShow/初回Episode各16ms、36件Showのmetadata更新23・34ms、最小audio更新15ms。
取得数はcommit5/6、consumer5/6であり、小さい不完全sample。
15msから10msへは約33%、34msから10msへは約71%の削減が必要。
最大値の差がCAS競合、cold/JIT、GC等のどれに由来するかは未確定。
HTTPはカタログ、Episode一覧、音源本文を読まないため、この差をEpisode件数やMP3サイズだけで説明しない。

正式handlerを通した競合なしfixtureの通常新規marker作成は次のとおり。
各値はCPU時間ではなく操作数で、競合・既存marker・例外経路の上限ではない。

| 読取 | Episode GET数 | 主な役割 |
| --- | ---: | --- |
| service TOML | 1 | service identity、strict config検証 |
| service admission | 7 | runtime、token取得、前後gate、token返却 |
| Show control | 3 | 現在owner、generation、lifecycle、予約identity |
| Episode lifecycle | 3 | 現在generationと公開許可 |
| 完成済みShow reservation | 1 | 永続identity |
| 凍結control request | 1 | ownerのrequest hashとの一致 |
| 凍結publication manifest | 1 | 公開対象とmanifest hash |
| commit marker | 1 | 既存要求の完全一致・冪等性 |
| 合計 | **18** | ShowはEpisode lifecycleがなく**15** |

別にservice CAS PUT 2回、marker作成限定PUT 1回、cached runtime RPC 2回がある。
service schemaはGETの7回とCAS保存の2回で通常**9回**完全検証する（sourceからの算出）。
Episodeではservice config/control request/lifecycleに合計5回のTOML parseがある。

操作数確認はGit管理外の`.local-test-data/results/20261014/acceptance-fixed-cost-counts.json`に保存した。
schema getterは直接spyできないため、parse回数を実測したとは扱わない。

### 現在のservice経路

`src/m6-management.ts:24`、`src/service-admission.ts:66`、`src/lifecycle-delivery-gate.ts:32`をたどると、
通常経路は次の順序になる。

```text
service TOML GET/parse
service GET: runtimeを確認
service GET → CAS: invocationを取得
前段gate: service GET → describeRuntime RPC → service GET
受付callback: 凍結要求/owner/markerを照合 → marker PUT
後段gate: service GET → describeRuntime RPC → service GET
service GET → CAS: invocationを返却
```

現在のsnapshotを捨て、直後の層で同じrecordを再取得する構造がある。
一方、RPCやmarker PUTの後の確認は必要で、呼び出し回数だけを根拠に削除しない。

## P1. service snapshotの受け渡し

### P1a: 初期runtime確認と取得を統合、返却の初回GETを省く

- publication commit専用の取得経路で、取得CASのために読んだsnapshotに対し、
  `verifiedM6Snapshot`相当のmode/state/readiness/実行version検証も行う。
  同じrecordを別途runtime確認のためだけにGETしない。
- 競合して取得CASをやり直す場合は、各新snapshotで同じruntime条件を検証する。
  現行の`m6_recovery`を使い、pausedで既知jobをdrainできる方針を維持する。
- 後段gateが最後に検証した現在snapshotを返し、自分のtokenを取り除くCASの初回に使う。
  ETag条件は必須。競合したら現在値を読み直し、他のinvocationやpause状態を消さない。
- callbackやgateの例外では、既存の安全な返却経路へfallbackする。
  全開始済みI/Oがsettleしていない経路から返却しない。

通常のservice GETは**7→5**、Episode全体は**18→16**が候補になる。
外部入口や`compareAndSetServiceAdmission`のboolean契約は変更せず、publication用のprivate helper/contextに限定する。

### P1b: 取得CASの検証済み結果を前段gateへ渡す

現在の`write`はR2 PUT結果をbooleanにして捨てる。
privateなCAS helperで、保存したstrict検証済みvalue/sourceと、成功応答のETag等を返せれば、
前段RPC前のservice確認をこの結果で行える。

- **CAS成功が確認できた後のsnapshot**だけを使う。保存前のsnapshotやclient申告を代用しない。
- bucket/service/token/kind/Worker versionに束縛する。応答喪失ではsnapshotを作らず、tokenを保持する。
- 前段RPCの後は現在serviceをGETし、同じtokenとreadinessを必ず再確認する。
  RPC中のtoken消失/readiness変更を、古い取得結果で許可しない。
- fresh recordがschema不正なら停止し、取得時のrecordへfallbackして許可しない。

P1aと合わせてservice GETは**5→4**、Episode全体は**16→15**が候補になる。
成功時は「取得結果 → RPC → fresh service確認」の順となり、RPC後の安全境界は残る。

## P2. 同一Workerのruntime probeをrequest内で再利用

`src/worker.ts:15`は`ctx.exports.CachedPublicAssets`を渡す。
`CachedPublicAssets.describeRuntime`は、実行version、entrypoint、purge APIの存在を返す。
R2のservice状態・設定・cache purge成功を検証する関数ではない。

この性質を根拠に、最初の厳密なprobeを同じHTTP commitの後段gateで再利用できるか検証する。

- 正式entrypointで作成したprivateな同一loopbackの証明がある場合だけ使用する。
  `describeRuntime`というmethodがあるだけでは採用しない。
- version/entrypoint/purge APIを検証した結果を、実行version、binding object、service token、callback scopeへ束縛する。
  request終了後、別bucket、別binding、別version、別invocationでは無効。
- 後段では**現在serviceをGET**し、mode/state/readiness全体と自分のtokenを検証する。
  cached probeと現在readinessが完全に対応していることを確認し、Worker IDだけの一致にはしない。
- 後段RPCを行わない場合は、そのRPCを挟むためだけの追加GETも不要にできる。
  後段の現在値確認と、token返却CAS自体は残す。
- 一般の`createM6DeliveryGate`、独立したservice binding、DIされたbinding、consumer、
  Lifecycle、fresh initialization/compatible updateのruntime probeは現行の完全確認を維持する。
  同一versionへの束縛を保証できない場合はRPC 2回を残す。

P1と合わせた通常経路の候補は次のとおり。

```text
service TOML GET/parse
service GET: runtime/取得条件 → CAS: token取得、検証済み保存結果
describeRuntime RPC → service GET: token/readiness再確認
受付callback → marker PUT
service GET: token/readinessと同一loopback証明を再確認
そのsnapshotでCAS: token返却（競合時はfresh GETへfallback）
```

service GET **4→3**、RPC **2→1**、Episode GET **15→14**、Show GET **12→11**が候補。
service schema検証はGET3＋CAS2の5回になり得るが、保存するrecordのstrict検証は省かない。
consumerのtoken取得がmarker PUT直後に始まるため、返却CAS競合は正常でも起こり得る。
これらの数値を実機全要求の固定上限とは扱わない。

## P3. 現在値の取得と再parseを分離する

P1/P2の結果を見て、Episode lifecycle、Show controlのrequest-localな検証済み読取を追加する。
**現在のR2 GETを省くTTL cacheではない。**

- 毎回fresh GETし、サイズ上限、ETag/versionと本文を確認する。
- 同じkey/bucket/ETag/version/sizeで本文が検証済みsourceと完全一致する場合だけ、そのstrict parse結果を再利用する。
  「同じgeneration」「同じjob ID」だけの一致では使わない。
- 本文が変化したら完全なschema/TOML検証へ戻る。parse失敗時に古い値を返さない。
- 現在のowner/job/generation/action/lifecycle/予約identityの判断は各境界で引き続き行う。
- parse結果を改変できないprivateなcallback contextに置く。global cacheや汎用R2 read cacheを作らない。
- 別のHTTP要求・Queue配送へ持ち越さず、本文読取/cancelをawaitしてから終了する。

正常なEpisodeではlifecycle TOML parse **3→1**、TOML全体 **5→3**が候補。
Show controlのJSON/schema再検証も3回から1回へ減らせる可能性がある。
R2 GET数は減らず、変更・競合経路では省けない。service recordは自分やconsumerのCASで変化するため、
まずP1/P2を優先し、serviceの再parse cacheまで一括導入しない。

## 後順位・不採用の候補

| 候補 | 判断 |
| --- | --- |
| 3回のShow/Episode読取を単純に1回へ減らす | 不採用。初期contextのhash await、marker GET、marker PUT直前の確認が分かれている |
| immutable入力/hashを先に読み、後で現在ownerを検証する専用builder | P3後の候補。private proof constructorの組み直しと既存marker/processing経路の分離が必要。まず本文一致再利用を優先 |
| claim時にfull manifest hashをserver receiptへ束縛 | 必要なら別改修。ownerの現行hashはcontrol requestだけでありclient hashは証明にならない。永続schema/CAS/応答喪失の扱いが増える |
| service TOML GET/parseをなくす | 今回は残す。identity/厳密config確認を削除せず、immutable Worker binding等の別の証明が必要 |
| RPC/別Workerへ移せばCPU制限から外れる | 根拠にしない。Worker分割だけで予算の改善は保証できず、Standard課金では双方のCPUが合算される |
| 管理鍵比較やstrict schemaを簡略化する | 不採用。router/handlerの重複認証は小さな候補だが、主対策として入口の認証を弱めない |
| R2読取の並列化だけ | wallを短縮できてもparse/CPUを減らすとは限らない。全開始済みI/Oのsettlementも必要 |
| CAS試行上限64を小さくする | 今回は変えない。返却失敗を増やすと残留tokenを作り、CPUだけの改善にならない |
| markerを出した後、token返却をQueueへ丸投げ | 不採用。旧HTTPのIO終了をQueueは証明できない。自動引継ぎ/解除はしない |

軽いintentだけをHTTPで保存し、claim/admissionもQueueへ移す案は、P1〜P3でも10msに届かない場合の別設計。
即時owner確保、編集禁止、pause/更新、競合失敗、未知応答の意味が変わるため、自動的に着手しない。
Paid採用、DO/D1/Workflows導入、取消し/強制解放も本計画の実装対象にしない。

## 安全性を確認した根拠と、変えない条件

- `src/m6-service-update.ts:19`はpaused・registry空・正確なruntime/generationを要求し、
  `readSettledShowControls`で未終了Show ownerを拒否してからETag CASする。
- `src/service-url-change.ts:75`も同じpause/drain条件、config/owner照合とCASでURL変更を確保する。
- `serviceAdmissionSchema`はupdating/migrating/url_changeとlive invocationsの共存を拒否する。
  完了済みの取得CASと保持tokenを、正式更新を防ぐ根拠にできる。
- `pauseServiceAdmission`は既存invocationを保持する。pauseで既知commitを中断・解放する方式にしない。
- `lifecycle-delivery-gate.test.ts`のRPC待機中のtoken消失/readiness変更の拒否と、paused drainを維持する。
  generic gateのテストを通すためだけに「request内なら不変」と仮定しない。

これらは正式な更新経路の契約であり、管理者による直接REST改変や未知のdeployを安全と認定するものではない。
現在値不正・version変更・所有権不一致ではfail closed。
unknown IO、elapsed time、HEAD不在、DLQ履歴はtoken解放の根拠にしない。
marker/receiptの`accepted`契約、consumer詳細検証、failed owner保持、凍結draftと未知POSTの再送禁止は変更しない。

## 実装と測定の単位

1. P1a/P1bを小さな変更単位で実装。必要なprivate CAS結果/context以外は一般化しない。
2. P2の同一loopback証明を正式入口に接続し、generic fallbackとの差をテストする。
3. 改修後、同じfixtureと実機metadata更新で比較する。P3は不足が残る場合に別変更として測る。

追加回帰は次に絞り、既存1,057テストと300 MB/Lifecycle/互換更新の受け入れを再利用する。

- 取得CAS競合・応答喪失で、snapshotを捏造せずtokenを保持する。
- RPC中のtoken/readiness変更、同一versionでもdeployment/config proofが変わった場合は拒否する。
- callback成功後/例外後の返却CAS競合で、他のconsumer/admin tokenやpause stateを消さない。
- marker PUT応答喪失と後段gate失敗で、未知受付を再送・自動昇格しない。
- private proofの別bucket/binding/version/invocation、callback後の使用を拒否する。
- control本文/ETag/versionの変化、同一generationの不正owner、strict field追加で古いparse結果を使わない。
- generic/consumer gateは従来のruntime確認を維持し、purge確認前に公開完了にしない。

`bun test`、`npm run check`、単一CLI buildを実行する。
実機は完了済み隔離serviceの正式更新だけとし、小さい音源と既存36件Showのmetadata更新を使う。
大容量MP3をCPU比較だけのために再uploadせず、残留owner/tokenがある旧serviceに触れない。

判定はinvocation全体のCPU p50/P95/最大、取得数、R2/RPC操作数、CAS競合数、wall、機能成功を分ける。
CAS競合数は必要ならjob IDと固定名の小さな集計ログへ追加し、token/本文/任意例外は出さない。
timerのwallをCPU内訳にせず、R2往復が何msのCPUに相当するかは実測から判断する。
tail healthとは別に各jobのcommit/consumer終了のcoverageを数え、欠落を補完しない。
tmux実行を継続するが、CLI command名とservice/Show cwdは既存helpに照合してから開始する。

目標はHTTP CPUのP95 7〜8ms程度と観測最大10ms未満。
commitだけでなくclaim/status/stagingも確認し、Free適合や将来のCPU最大を少数sampleから保証しない。
未達の場合は残るCPUのprofileに戻り、現行安全条件の省略で数値だけを合わせない。

## 公式仕様の参照（2026-10-14）

- [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [ctx.exports: 同一Workerのloopback](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)
- [Version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
- [Service bindingsとawaitによるlifetime](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Service bindingsのCPU課金](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings)
