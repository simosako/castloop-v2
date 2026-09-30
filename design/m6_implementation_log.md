# M6: 公開停止・削除 実装ログ

## 2026-09-30: 次マイルストーンの設定と設計案

管理者の依頼により、Episode/Showの公開停止・削除を次のマイルストーンM6とした。[設計案](./m6_content_lifecycle_plan.md)を作成し、全体設計・README・Agent Guideと独自ドメイン計画に開発順を反映した。

### 設計案作成時の状態

- 基準版は公開済みv0.1.2。公開停止・削除・再開は未実装。
- 今回は文書更新だけで、CLI/Worker/schemaは変更していない。Cloudflareリソース・公開コンテンツも変更していない。
- 物理削除と公開停止の分離、明示的restore、HTTP status、IDの再利用禁止、保持記録、client cache変更、進行中jobへ割り込まない方針は設計案であり、詳細承認はこれから行う。
- 独自ドメインの承認済み方針・基礎コードは保持するが、完成・CLI公開はM6の後続に回す。

### 調査で確認した設計ゲート

1. Workers CacheはWorker実行前にHITを返す。停止判定を必ず実行するgatewayとcached inner entrypointを同じWorkerに設ける案。REST deploy、内部purgeのscope、Rangeと料金は専用環境での実証が必要。
2. Showの状態と受付を同じR2 keyのCASで管理し、publicationだけでなくREST staging uploadとの競合も防ぐ必要がある。別keyの停止markerを読むだけでは不十分。
3. 削除は複数objectにまたがるため、状態機械・耐久progress・分割consumer・最終再列挙を要する。停止/削除開始後の失敗で自動再公開しない。
4. 旧CLIによる直接uploadや旧Workerへのdowngradeは公開ゲートを迂回し得る。移行時の停止・更新・収束と保証範囲を明記する必要がある。

### 次の作業

設計レビュー・承認後、M6.0のcache/API・排他・回復の技術実証を行う。コマンドを先行公開せず、各実測と判断をこのログへ追記する。

## 2026-09-30: 入力TOMLフラグとR2制御recordの比較を追加

レビューで、公開状態を入力metadataから分離する方針への賛同と、`publish = false`などのフラグ方式とのメリット・デメリット整理を依頼された。設計案の第5節に比較を追記した。

- 保存形式ではなく、希望状態と実状態、metadataと制御情報の責務の違いとして整理した。
- TOMLフラグ方式の編集・Gitレビュー・一括管理の利点と、適用契機・古い下書き・物理削除後の記録への対策を明記した。
- R2制御record方式の明示操作・排他・途中状態・tombstoneの利点と、状態照会・schema・復旧・readコストの増加を明記した。どちらの方式でも配信ゲートとcache対策は必要とした。
- 将来の宣言的applyとの併用は別途検討とし、M6の実装範囲は増やしていない。この賛同はM6の削除仕様・その他の承認事項全体の承認とは扱わない。

## 2026-09-30: R2制御record方式の決定と基礎実装の開始

管理者が比較を確認し、もとのR2制御record方式を決定、資料更新と実装開始を指示した。公開状態を入力metadataから分離する方式を決定事項として反映した。cache/API・移行・回復の実機ゲートを通過したとは扱わない。

### 実装した基礎

- `packages/shared/src/lifecycle.ts`: strictなShow制御record、Episode状態、凍結requestと状態ごとの操作許可。入力metadata schemaは変更せず、公開フラグは追加していない。
- `src/lifecycle-control.ts`: R2 bindingからのサイズ制限付きread、keyとrecordのID一致確認、requestの不変保存、Show keyのETag CASでの原子的受付、owner/request/generationを照合したprocessing開始。stagingにはuploading ownerを割り当て、consumer処理へ移さない。
- R2を毎要求で読む公開可否判定。Showの親ゲートを先に確認し、Episodeの個別状態は書き換えない。未知の対象は非公開、既知の対象のrecord欠落・破損・読取失敗は例外としてfail closedする。
- 同一requestの再送とCAS応答喪失を回復できるようにし、別要求・古いgeneration・既存job IDによるclaimを拒否する。legacy admissionを自動上書きせず、processingの強制解放も実装していない。

### 確認結果・未接続の範囲

- `npm run check`と`bun test`に合格（56件）。新規24件でschema、同時claim、再送/各段階の応答喪失、staging排他、request不一致、停止対象の暗黙再公開拒否、親子の公開判定、R2読取失敗を確認した。
- Linux x86-64バイナリのビルドと`git diff --check`にも合格。新schemaの追加で既存CLI/Worker bundleのビルドを壊していないことを確認した。
- 新しいモジュールは既存CLI/管理API/Queue consumer/公開入口には未接続。公開可否判定関数のテストはwarm Workers Cacheを遮断できたという実測ではない。
- 公開停止・削除・再開のコマンド、job status v2、停止/削除consumer、終了時の受付解放、移行はまだない。v0.1.2 Releaseの内容とCloudflareリソースは変更していない。
- processing開始の同job再実行は許すが、この関数だけで同jobの複数consumer invocationを排他できるとは扱わない。既存concurrency 1と旧invocationが書けないことを確認した回復経路を維持し、受付解放・次操作との安全性は後続consumer実装で検証する。

### 次の作業

1. M6.0の同一Worker内uncached gateway/cached entrypoint、REST deploy、purge scope、Rangeの技術実証。
2. 既存Showの明示的移行とcapability、publication/stagingの受付・終了処理を新recordへ接続する設計・実装。
3. 配信ゲートと回復の条件を揃えた後、Episode/Showのlifecycle consumer・CLIへ進む。

## 2026-09-30: M6.0 キャッシュ構成の実機実証

管理者の指示で、運用サービスとは別のWorker/private R2をREST APIから作成し、同じWorker内のuncached gateway＋cached named entrypointを実証した。認証情報は環境変数のみ、Wrangler・Node.js CLI・R2 S3 credentials・独自ドメインは使っていない。開発時の実行/bundleはBun。Queue/DNS/既存サービス/Releaseは変更していない。

### 専用実装と証拠

- [`experiments/m6/cache-worker.ts`](../experiments/m6/cache-worker.ts): `readPublicVisibility`で実際のR2制御recordを確認し、`CachedMedia`をloopback fetchで呼ぶ試験Worker。gateway/inner別UUID、generation props、内側purge RPC、遅延response fixtureを持つ。入力metadataや公開consumerは試験対象にしていない。
- [`experiments/m6/verify-cache.ts`](../experiments/m6/verify-cache.ts): 毎回新規resourceを作成し、試験・証拠保存・cleanupを実行。型は[専用tsconfig](../experiments/m6/tsconfig.json)で既存platform typesに対して確認する。
- 最終実行は`castloop-m6-cache-7b5a047d`、compatibility date `2026-09-30`、usage model `standard`、完了時刻 `2026-09-30T14:15:32.022Z`。10チェック合格。公開/隔離path等の50応答はNRTで観測した。
- [保存したJSON結果](../experiments/m6/cache-results-20260930.json)にuploadのexports、settings、個々のHTTP status/bytes/ID/cache状態/colo/経過時間、cleanup結果を保持する。raw記録は`/tmp/opencode/castloop-m6-cache-7b5a047d/`。secret入りmanifestはGitに入れない。

### 実測結果

| 項目 | 結果 |
| --- | --- |
| REST module deploy | `cache_options.enabled=true`、`cross_version_cache=false`、`exports.default.cache.enabled=false`、`exports.CachedMedia.cache.enabled=true`を受理。upload応答にもentrypoint別設定が返る |
| gatewayの毎要求実行 | feed MISS→HITでinner UUIDは固定、gateway UUIDは毎回異なる。外側はno-store、内側は300秒cache |
| GET/HEAD/Range | cold Rangeは206/MISS、後続は206/HIT。`bytes=0-9`、`250-259`、suffix、416のContent-Range/bytesが一致。cold/warm HEADはbodyなし/正しいlength、cold HEAD後のGETも全量一致 |
| warm cacheでの停止 | Episodeの404/410、Showのfeed/cover/MP3 404/410。GET/HEAD/Range、query/If-None-Matchの停止回避なし。停止試験ではpurgeしない |
| purge scope | gatewayからのtag purgeはsuccessでもinnerの旧bodyが残る。inner RPCからのtag purge後は新body/新inner UUID。tagなし音源のpath-prefix purgeも有効、cover cacheは変わらない |
| fail closed | warm cacheのままShow recordを壊すと503。cached bodyを返さない |
| 遅延旧response | 判定・開始済みresponseは停止後に200完了し得る（保証対象外）。その後の要求は404のまま。再開generation 2では別inner UUIDでMISS→HITとなり旧cacheを再利用しない |
| 非公開path | system/staging、内部class名の外部pathは404。未認証fixture管理は401 |

65,536 bytesの人工payloadで配信/cachingを検証した。拡張子とContent-Typeだけfeed/cover/MP3に合わせたfixtureで、RSS構文・画像decode・MP3解析/再生は確認していない。停止fixtureはID再利用やdeleted→activeも許す検証専用操作であり、本番lifecycle APIには流用しない。prototypeのShow再readも本番の状態/generation snapshot API設計を代替しない。

### 後片付け

初回`castloop-m6-cache-a21e0c3b`も主要8チェック合格したが、Worker DELETEが500/code10013を返した。再試行でWorker/bucketを削除済み。runnerに有限retryと不在確認を追加し、最終実行はテストpayload・Worker・bucketを自動削除、不在確認まで成功した。作成した2組の検証resourceは残していない。

### 料金・保証範囲・残るゲート

- 公式[Workers Cache料金](https://developers.cloudflare.com/workers/cache/#pricing)と[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)を確認。cached loopbackもrequest課金対象なので、active配信はgateway＋innerの2 request相当を基本に試算する。inner HITでもgateway CPUとR2状態readは必要。castloop本番の実請求やCPUを測ったわけではない。
- 今回はStandardであり、Freeの100,000 request/日・10ms CPU制限内で動作することは未実証。[purge rate limit](https://developers.cloudflare.com/workers/cache/purge/#rate-limits)はWorkers Cacheではプランに関係なくFree-tier。rate-limit時のconsumer retryを後続実装に含める。
- 同一NRTの少量試験。複数colo・hostname・負荷・300MB音源・旧default cacheからの本番移行は未検証。tagなしinner cacheのprefix purge確認は旧default entrypointの移行/purge合格ではない。
- 外向けheaderは試験ではno-store。設計の`max-age=0, must-revalidate`、activeのconditional 304、Episode generationやfeed generationの本番cache keyは接続時に回帰確認する。
- **cache/REST/Range構成ゲートは実証済み、M6.0全体とM6公開ゲートは未完了。** 次はR2 CASの実機競合、staging uploadの中断/収束と安全な解放、限定reserved abandon、既存サービス移行/capabilityを進める。CLI/consumer/公開入口へ新構成を接続してから、本番相当の回帰試験を行う。

### ローカル回帰

`npm run check`、専用tsconfigの型チェック、`bun test`（56件）、文書リンク/コードフェンス/空白確認、`git diff --check`に合格。Cloudflare REST GETでも今回作成した2組のWorker/bucketが404であることを再確認した。

## 2026-09-30: CAS競合・限定reserved abandon・REST条件付きuploadの実測

キャッシュ実証を`16b900f`でcommit/pushした後、管理者の継続開発指示に従って次の安全性ゲートを進めた。

### 実装

- Show v2 schemaへstrictな`last_abandoned_operation` receiptを追加。取消対象job・受付後generation・request hashを保存し、現ownerや現generationと同一のreceiptは拒否する。
- `abandonReservedShowOperation`: frozen request・owner・generationを確認し、**reservedに限り**同じShow keyのCASでowner除去/generation更新/receipt保存。processingとuploading、legacy/missing/mismatched recordは解放しない。CAS後の応答喪失はreceiptで回復できる。
- 取消前にprocessingへ進んだconsumerと競合した場合はabandonが失敗する。逆に取消CASが勝った場合、古いbegin CASは失敗する。各jobの凍結requestも保持し、同じjob IDを新しいgenerationへ書き換えて再claimできない。
- これは新v2経路の未接続基礎関数。既存v1 admissionや旧consumerには適用せず、HTTP管理からのprocessing解放やCLIのabandonコマンドは追加していない。

### 実機結果

最終環境`castloop-m6-admission-89e9794f-07f`、Standard、完了`2026-09-30T14:43:23.015Z`。[専用runner](../experiments/m6/verify-admission.ts)の5チェック合格。[JSON証拠](../experiments/m6/admission-results-20260930.json)を保存する。

1. publish/stage/unpublish/deleteの16同時claimは1件だけ成功、15件拒否。
2. 同一requestの6同時claimは冪等、generationは1だけ進む。processingはabandon不可。
3. abandon成功後の503を注入し、同じ要求の再実行で取消を確認。旧begin、旧claim、同jobのgeneration書換claimは拒否。別jobの次受付は成功。
4. beginとabandonの実R2競合を8回実行し、各回で1つだけ成功。
5. uploading ownerはdeleteを拒否し、abandonでも解放されない。

### uploadゲートの不成立

R2 REST object PUTへ既存ETagと一致しない`If-Match`を付けたが、**HTTP 200で既存bodyが上書きされた**。`barrier`（7 bytes）→`wrong`（5 bytes）、ETagも変わった。bindingのonlyIf/CASが成立しても、CLIが使うREST object PUTのfenceにはできない。試験fixtureだけの上書きで、運用コンテンツには触れていない。

この結果を受け、条件付きREST PUTのsafe cancellationは不採用。uploadingを時間切れ/HEAD不在だけで解放しない。未解決のままdeleteを先行公開しない。現行直PUTの明確な収束証拠、またはサーバー管理の分割upload sessionなど、別の安全なプロトコルを検討する必要がある。管理端末の追加依存・別productを無断で増やさない。

### 試験環境と回帰

- 初回配備直後に一部要求が500/HTMLの`Script not found`となるケースを観測。runnerは非JSON応答もstatus/titleで記録し、同一要求の有限retry、全同時要求のsettle後cleanupを追加した。これはCASの二重成功とは別のfront-end反映問題。
- 最終実行はpayload/Worker/bucketのcleanupと不在確認に成功。途中失敗の3組も専用resourceだけを清掃済み。Queue・DNS・既存サービス・Releaseは変更していない。
- `npm run check`、専用tsconfig、`bun test`に合格（62件、428 assertions）。単体テストでも応答喪失、取消/開始競合、staging拒否、receipt更新後の旧job拒否を追加した。
- 次は破壊的操作と独立した、既存サービス移行の読み取り専用inventory/planを実装する。upload収束ゲートと本番consumer/CLI接続は引き続き未完了。
