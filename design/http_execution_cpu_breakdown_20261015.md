# 現行HTTP処理の順序とCPU負担

2026-10-15。管理者から現在のHTTP処理・実行順・CPU負担の整理を依頼された。
対象は`feat/publication-queue-submit`の段階Aコード`a294c32`。
[7公開の実機測定](publication_queue_commit_measurement_20261015.md)を、ソースの呼び出し順と対応させた。
新たな配備・公開試験・段階B実装は行っていない。

## 1. 測定値の意味

- CPUはCloudflare Live Tailの`cpuTime`で、**HTTP要求1回のWorker invocation全体**の値。
  ルーティング・認証・入力解析・runtime/owner確認・本処理・結果の解析/JSON応答などを含む。
- 内部の特定関数・R2呼び出し・parse・hashごとのCPUは測れていない。
  「TOML parseに何ms」「gateに何ms」といった数値を推定で配分しない。
- 自作`worker_timing.duration_ms`はI/O待機を含む経過時間。CPU内訳に使わない。
- CLI→Cloudflare R2/Queues RESTもHTTP通信だが、castloopのHTTP Workerは実行しない。
  この通信をcastloop WorkerのCPUとして数えない。CLI自身のMP3解析・SHA-256計算も別。
- 以下の回数は**捕捉した要求数**であり、関連する全要求の捕捉を保証するものではない。
  service/targetは同じログのHTTP route情報から追加集計した。対象確認はShow/Episodeの混合集計。

## 2. 下書き更新: `update-*`の順序

通常の成功経路は以下。Show更新はmetadataとcoverを同じstaging operationで扱い、
初回Episodeはmetadata更新とaudio更新の2つのstaging operationを順番に実行する。

```text
CLI: local draft / 未終了journalを確認
  → HTTP /admin/target: 現在Show/Episode・generation・base revisionを確認
CLI: metadata / MP3解析 / hash / upload manifestを準備し、journalに保存
  → HTTP /admin/staging claim: staging ownerとmanifest/progressを確保
  → HTTP /admin/staging status: ready・同じowner・verification未開始を確認
  → HTTP /admin/staging begin: uploadingへ進め、正確なPUT対象を返す
CLI → Cloudflare R2 REST: payload PUT → 全量GET readback・hash/ETag/size確認
  → HTTP /admin/staging status: uploading・同じownerを確認
  → HTTP /admin/staging settle: PUT終了・追加PUTなし・readback receiptを保持
  → HTTP /admin/staging status: settled・同じreceipt・verification未開始を確認
  → HTTP /admin/staging finish: server検証 → 完了証跡 → staging owner解放
CLI: staged receiptを保存。まだ公開しない
```

順序は`packages/cli/src/local-draft-operation.ts:42`と`packages/cli/src/staging-operation.ts:49`以降。
各mutationのPOST前に要求phaseをjournalへ保存し、結果不明のPOSTを自動再送しない。

## 3. 公開: `publish-*`の順序

```text
CLI: 完了済みstaging journal / local draftを確認
  → HTTP /admin/target: 現在のgeneration・base revision・ownerなしを確認
CLI: publication requestを凍結し、local draftをpublication_preparedにする
  → HTTP /admin/service status: open・Queue commit capability・runtime versionを確認
CLI → Cloudflare Queues REST GET: 同じaccountのQueue ID・既存consumerを照合
CLI: local入力を再検証、claim_requestedを保存
  → HTTP /admin/publication claim: publicationを保持し、Show ownerをCAS取得
  → HTTP /admin/publication status: 同じheld owner・marker/execution/submissionなしを確認
  → HTTP /admin/service status: intentに束縛する現在runtimeを再確認
CLI: intent/MACを生成、local入力を再確認、submit_requestedを保存
CLI → Cloudflare Queues REST POST: 署名済みcommit intentを1回送信
CLI: queued receiptを保存。HTTP commitは呼ばない
Queue: own service/execution取得 → marker作成 → 詳細検証/公開/purge/完了記録
CLI → HTTP /admin/publication status: published/releasedまで繰り返し確認
```

Queue送信成功は公開成功ではない。手動`publish-*`はqueuedを返して終了し、
`job-status`は別コマンドである。RSS公開と今回の測定器は同じstatus endpointを繰り返して待つ。
試験器のservice-statusによるdrain確認も追加のHTTPで、全てがpublishコマンド自身の要求ではない。

順序は`packages/cli/src/m6-local-update.ts:78`、`packages/cli/src/publication-operation.ts:37`、
`packages/cli/src/publication-queue-client.ts:26`以降。
旧HTTP commit APIは互換用に残っているが、現行CLI通常経路では使わず、fallbackもしない。

## 4. HTTP要求別のCPU

| 要求 | 主な本処理 | 観測数 | CPU中央値 / 最大 |
| --- | --- | ---: | ---: |
| `/admin/service` status | service TOML・admission読取、capability/version応答 | 15 | 3 / 6ms |
| `/admin/target` | Show/Episode・予約・current/history確認、再読取で整合確認 | 16 | 13 / 25ms |
| staging claim | manifest保持、Show CAS admission、必要時Episode初期化、ready保存 | 8 | 39.5 / 75ms |
| staging status | manifest/request/progress/status/owner/markerの読み取り照合 | 19 | 11 / 20ms |
| staging begin | owner/phaseを確認、uploading保存、PUT対象応答 | 8 | 18.5 / 33ms |
| staging settle | PUT終了宣言・readback receiptsを照合、settled保存 | 8 | 22.5 / 44ms |
| **staging finish** | **verification取得、payload検証、progress/status保存、再照合・owner解放** | **8** | **72 / 139ms** |
| publication claim | frozen publication/control request保持、Show CAS admission・lifecycle照合 | 7 | 24 / 35ms |
| publication status | 7 job recordsとShow ownerの読み取り・hash/parse・再照合 | 242 | 15 / 52ms |
| HTTP publication commit | 現行CLIからは実行しない | 0 | 該当なし |

**表の「本処理」だけでこのCPUを使ったという意味ではない。共通の前後処理を含む。**
Queue側の公開invocation CPU204〜533msはこの表と別の実行予算であり、HTTPの10ms判定に混ぜない。

## 5. mutation HTTPの共通前後処理

staging claim/begin/settle/finishとpublication claimは、主に以下の共通wrapperを通る。

```text
1. route/method確認、管理鍵認証、bounded JSON読取、strict request parse
2. service TOML読取・parse、実行versionとM6 readiness確認
3. service invocation tokenをCAS取得
4. 前段gate: service/token読取 → CachedPublicAssets.describeRuntime RPC → 再読取
5. 各endpointの本処理: 現在owner/generation、凍結要求、必要な検証・記録更新
6. 後段gate: 同じservice/token・cache ownerを再確認
7. 全開始済みIOがsettleした通常経路で自分のservice tokenだけCAS返却
8. response schema検証済み結果をJSON応答
```

本処理のresponse schema検証はcallback内で行う箇所もある。
外側wrapperだけでも、正常・無競合なら概ね**service admission GET 7回、service CAS PUT 2回、runtime RPC 2回、service TOML GET 1回**。
これはソースから数えた呼び出し数で、競合時の上限やCPU内訳ではない。本処理のR2 IOも別に加わる。
R2待機そのものはCPUではないが、その前後のJSON/TOML/Zod処理、hash、比較、serializationはCPUを使う。

`src/m6-management.ts:24`、`src/service-admission.ts:66`、`src/lifecycle-delivery-gate.ts:32`参照。
pub/staging statusとtargetはread-only wrapperを使い、service tokenをCAS取得しない。
それでもservice/config/cache ownerの前後確認、objectのparse/hash、ETag/size再照合を実行する。

## 6. staging finishで行う詳細検証

`src/staging-verification.ts:193`の成功経路は以下。

1. 既に完了済みなら同じmanifest/outcomeの証拠を照合して戻る。
2. 現在ownerとclient_settledを確認し、専用verification tokenをShow controlへCAS設定。
3. 同じverificationに束縛したscoped envを作り、processing status/verifying progressを保存。
4. payloadごとにowner/progressを照合し、HEADのsize/ETag/versionとCLIの全量readback receiptを比較。
5. metadata/coverはGETしてSHA-256を検証。TOMLをparse・validateし、ID/GUID/published_at/cover拡張子等を確認。
   **MP3全量のhashはCLI側であり、このHTTPでMP3を全量GET/hashしない。**
6. verified/finished progressとcompleted statusを保存。
7. 完了証跡・payload HEAD・現在verificationを再確認し、最後にownerをCAS解放。
8. 外側の後段gateとservice token返却。

今回、Show metadata+coverのfinishは139ms（小容量）/126ms（36件Show）、
Episodeの単一metadata/audio payloadのfinishは61〜75msだった。
検証対象の数と反復するowner/progress/manifest確認が負担候補だが、個別CPUの割合は未測定。
たとえば「139msのうちSHA-256が100ms」とは言えない。
staging finishのHTTP invocation wall中央値は約13.2秒であり、CPU中央値72msとは別。

## 7. statusが繰り返す処理と累積負担

`src/publication-inspection.ts:9`は、Show controlを前後で読み、
publication/request/status/progress/DLQ/marker/submissionの7 recordsをGETしてparse/hash/identityを確認し、
同じ7 recordsをHEADしてETag/sizeの変化を検知する。さらにread-only wrapperのruntime/config前後確認を行う。

無競合・対象records通常経路のソース上の構造は、wrapper込みで概ね
**GET 12回、HEAD 8回、runtime RPC 2回、CAS PUTなし**。
guardを通過しない経路などでは回数が異なる。
公開中に変化したsnapshotは`publication_status_changed`とし、変更POSTではなく読み取りだけを再試行する。

今回、集計対象のHTTP CPU合計は観測331要求で**6,171ms**。
うちpublication status 242要求が**4,101ms（約66.5%）**、staging finish 8要求が676msだった。
これは捕捉したHTTP invocationのCPUを加算した値で、未捕捉要求・別RPC invocation・Queue・CLI・Cloudflare REST基盤の全コストを含まない。
**10ms上限は要求ごと**なので、status回数を減らすだけで15ms/要求が10ms以下になるわけではない。

## 8. 判断と未計測範囲

- 1要求の最大負担はstaging finish、次にstaging claim。移譲候補として優先度が高い。
- 繰り返し込みの観測CPU負担はpublication statusが最大。整合証拠を維持したCLI→R2 REST読取が候補。
- 段階Bでpublication claimをQueueへ移しても、stagingやstatus、targetのHTTPは残る。
- 共通guardの削除や時間/HEAD不在によるtoken解放でCPUを下げない。各IO境界の安全条件を維持する。
- create-show登録、一覧、lifecycle、deploy/domain、公開GET/HEAD/RangeなどのCPUはこの表の測定対象外。
  **この整理だけで、サービスに残る全HTTPがFreeに適合するとは判定できない。**
- 内部関数別CPU、JSON/TOML/schema/hashの個別割合、cold start等の寄与は未確定。
  本報告は既存の実測と呼び出し構造の整理であり、新たなプロファイリングを行っていない。

Git管理外の追加集計: `.local-test-data/results/20261015/queue-commit-1973a731/http-route-cpu-breakdown.json`。
同じディレクトリの原本tailと測定時のhash/versionに対応する。素材・原本・journalはGitへ追加しない。
