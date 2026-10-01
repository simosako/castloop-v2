# M6: 公開停止・削除 実装ログ

## 2026-10-01: 管理者のv0.1.1テスト環境を読み取り専用で確認

- 管理者が既存環境はテスト用で削除可能、CLI/Workerはv0.1.1、1 Show/2公開Episode、処理中/失敗中jobなしと申告した。[移行前基準](./m6_legacy_test_baseline.md)へ記録した。管理API/R2/Queueの状態を取得したわけではない。
- 公開feed GETは200/item 2件、音源2本のHEADは200でfeed記載サイズと一致、先頭16 bytesのRange GETは206、cover HEADは200だった。NRTの音源cache HITと既存immutable応答を確認した。GUID/date/path/サイズだけを記録し、本文/メールを複製せず、音源全体のchecksum/再生確認は行っていない。
- 公開URLの読み取り以外のCloudflare操作、deploy、R2書込/削除、環境撤去は実施していない。v0.1.1からの安全な移行手順と本番統合は未完成で、既存環境は基準として保持する。

## 2026-10-01: 保存済みShow/Episodeの公開再開を追加

- `runLifecycleRestore`はR2のpublished Show/service snapshotと現在のpublic_base_urlだけを読み、coverとactive/復帰候補Episode音源のHEAD照合→feed再生成→冪等feed generation→purge→durable purge証拠→active化→完了status/owner解放へ進む。stagingやローカルの未公開編集を使わず、GUID/公開日時/revision/音源pathとbytesを変更しない。
- Show再開は子制御recordを変更せず、個別停止/削除/draftをfeedへ復帰させない。空Showも対応する。Episode再開はactive親を必須とし、期待generationと最終jobを照合してCASで1度だけ進める。配信gate callbackは必須で、purge後にgateが失敗してもactive化せず、保存した準備証拠から再試行できる。
- restore progressのvisibility/finishedにはpurge確認を必須にし、準備phaseでのpurge完了や削除phase混入をstrict schemaで拒否する。snapshot欠落/過大/対象不一致、親/対象/generation変化、feed/gate/purge失敗、状態/進捗/status/解放応答喪失を自動テストした。通常終了が確認された実行からのtoken返却/再取得もmockで確認したが、runtime強制終了や取得応答喪失の安全な回復が成立したとは扱わない。
- `bun test`（171件、2924 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64 binary buildとversion/helpに合格。公開binaryは0.1.2のままでlifecycleコマンドを表示しない。本番effect/Queue/API/CLI/移行/配信は未接続、Cloudflare実機の新規操作・運用変更・Releaseは行っていない。

## 2026-10-01: 削除開始と最終確定を接続

- `stepLifecycleDelete`を追加し、配信状態をdeletingへ変更→配信gate確認→active親のEpisode feed更新→generation→初回purge→durable削除進捗へ接続した。Show削除と停止中の親ではfeedを書かない。削除batch後は最終purge→tombstone→finished progress→completed status→同一CASのowner解放/receiptまで進める。
- payload削除と子tombstoneは1回最大100 objectのstepに分けた。Show削除では子Episodeの制御recordだけをページ単位でdeletedにする。既存deleted recordは変更せず、子generationは維持する。親Showの受付generationと不可逆deletedゲートで旧job/ID再利用を拒否し、最大generationの子も削除できる。件数は応答喪失で過少になり得る診断値である。
- strict progressに最終purge証拠とShow子tombstoneのcursor/完了証拠を追加した。削除finishedには全scopeのverification完了、cursorなし、初回/最終purge、必要な子tombstone完了を要求する。不正な子recordは上書きせずownerを保持して停止する。
- Episode/Show、draft/停止対象、最後のEpisodeの空feed、部分DELETE、初回/最終purge失敗、feed/gate失敗、各状態/進捗/完了/解放応答喪失、新owner取得後の旧実行再送を自動テストした。媒体bodyは読まず、必要marker/予約/service/別Showを保持し、診断へ例外本文を保存しない。
- `bun test`（160件、2457 assertions）、`npm run check`、M6実証tsconfigに合格。本番gate callback、Queueの続行とinvocation引継ぎ、API/CLI、移行、実機受け入れは未接続であり、運用環境は変更していない。

## 2026-10-01: lifecycle共通遷移とCAS job journalを追加

- 停止/削除の配信閉鎖と冪等feed generation更新を共通moduleへ分離した。Episodeは凍結requestの期待generationと最終jobを照合してCASで1度だけ進め、Showもowner/tokenを保持したまま状態を変える。
- v2 status/progressの共通journalはowner/要求hash/対象/generationを検証し、初回はIf-None-Match、更新はETag CASで保存する。finished progressとterminal statusの改変・退行を拒否する。terminal statusにはdurable finished/purge証拠と対象の結果状態が必要。
- 既存の公開停止runnerもこの共通処理へ移行した。旧v1記録や破損記録を暗黙に上書きせず、CAS競合・応答喪失・stale tokenを確認した。
- `bun test`（149件、1395 assertions）、`npm run check`、M6実証tsconfigに合格。本番ルートと運用環境は未変更。

## 2026-10-01: 保持policyに従うpayload削除batchと最終再列挙を追加

- `stepLifecyclePayloadDeletion`にdelete owner/実行token、対象deleting、期待generation/最終job、durable progressの対象・action・要求hash・purge成功、呼出側の配信ゲート確認を必須とした。最大100 keyの許可payloadだけをbinding array DELETEで処理し、progressをETag CASで保存する。本番経路からはまだ呼ばない。
- publication markerをstrict schema/対象/ETag/sizeで確認して保持し、予約・制御record・tombstone・request/job記録・service設定・別Show/似たEpisode IDを消さない。markerの本文をprogressへコピーせず、媒体bodyも読み込まない。未知key・不正/個人情報を追加したmarker・payload変更・gate未成立では削除を拒否する。
- 削除pageのcursorをそのまま維持し、全scope走査後は各prefixの先頭からverification passを行う。取りこぼしたpayloadがあれば削除へ戻し、一覧から空を確認した後だけfinalizingへ進む。件数は応答喪失で過少になる可能性がある診断値で、終了条件は一覧の再確認である。
- DELETEの部分成功/応答喪失、progress応答喪失/CAS競合、token喪失、markerだけの複数page、先頭prefixの残存payload、上限/破損progressを自動テストで確認した。failureでもowner/tokenを解放せず、同じ終了確認済み実行のremote progressから収束する。
- このmoduleは最後のpurge、deleted tombstone、terminal status、owner解放を行わない。開始時state/feed/purgeと本番gate callback、Queue継続・invocation引継ぎ、API/CLI、実機受け入れは残件。mockでのgate確認を本番cache配信停止の実証と扱わない。
- `bun test`（142件、1369 assertions）、`npm run check`、M6実証tsconfig、`git diff --check`に合格。運用リソース・Releaseは変更していない。
- Linux x86-64 binaryのbuild、既存version/help、文書リンク/コードフェンス/空白/英語AGENTS.mdも確認した。公開CLIはv0.1.2のままでlifecycle操作を表示しない。

## 2026-10-01: 削除後の最小記録保持policyを承認

- 管理者が説明へのannotationで、小さい必要な管理/操作記録は自動期限削除せず保持し、本文/個人情報/secretを複製せず、音源等のpayloadを物理削除するM6方針を承認した。期限付きの記録整理は後続とする。
- レビュー待ち一覧・M6設計・英語Agent Guideへ承認を反映した。tombstone/凍結request/commit/status/progressの保持とpayload削除を分離し、未完了/回復中jobを時間だけで消さない。
- この承認は運用bucketの削除実行やM6公開ゲートの通過ではない。実装・自動テストを順次進め、運用リソースは変更しない。

## 2026-10-01: 保持するM6診断をallowlist化

- M6 v2 statusのreasonをphase別の定型文・`reason_code`へ限定し、不一致pairや自由な例外messageをstrict schemaで拒否する。公開停止runnerはretrying記録へ例外本文をコピーせず、phaseと安全な定型診断を保存する。
- gatewayの永続ログも任意の例外messageを出力せず、対象IDと固定codeで障害を記録する。例外へタイトル/説明文/メール/secretを注入したテストで、R2 job記録とgatewayログに含まれないことを確認する。
- 旧v1 status parserは互換性のため維持する。既存R2記録を一括書換/削除したわけではなく、旧publication経路のv2統合は引き続き残件である。
- `bun test`（131件、956 assertions）、`npm run check`、M6実証tsconfig、`git diff --check`に合格。運用リソースは変更していない。

## 2026-10-01: レビューannotationを反映

- 管理者が公開時の利用条件を承認した。停止404/削除410/空feed 200、外部cache再検証、削除ID再利用禁止、進行中jobへ割り込まない仕様と、状態照会/内部cache構成に伴う性能・料金増の許容を承認済みとして設計・レビュー待ち一覧へ反映した。具体的な測定値や実機合格は承認に含めず、技術検証を継続する。
- tombstoneを「削除済みIDの小さい管理記録」と説明し、payloadのバックアップではないこと、ID再利用防止/410/旧job拒否の役割と、操作履歴の保持期間とは別の判断であることを明記した。
- M6では小さい必要記録を自動期限削除せず保持し、本文/個人情報/secretを複製しないという簡潔な保持方針をレビュー用の未承認提案として整理した。既存recordの書換・削除・保持期限の適用はしていない。
- 今回は文書のみを更新し、runtime・Cloudflareリソース・Releaseは変更していない。

## 2026-10-01: 公開gateway処理とレビュー待ち一覧を追加

- `serveLifecyclePublicRequest`を追加し、許可pathについて毎要求のstate読取、検証済みgeneration props、停止404/削除410/障害503、HEAD bodyなし、内部TTLと外部再検証headerの分離を実装した。Range/条件付きheaderは公開可否の確認後だけ内部transportへ渡す。
- warm cache相当のmock、別host/query、全revision、GET/HEAD/206/304、状態破損/R2障害/内部transport障害の自動テストを追加した。停止時はcached transportを呼ばず、障害時にもfallbackしない。内部HTTP/CDN cache用headerは外部応答から除去する。
- gatewayはまだ本番default入口へ接続しておらず、deploy metadataによるcache無効化や内部entrypointの実装をこの関数だけで保証しない。専用実機の既存実証と今回のmock結果を区別する。
- 確認が必要な監査記録policy/公開利用条件と、判断待ちではないupload統合・実行回復・配信/移行・restore/delete・CLI/実機の残件を[レビュー待ち一覧](./m6_review_queue.md)へまとめた。運用への配備、物理削除、サポート問い合わせ、Releaseは行っていない。
- 最終回帰は`bun test`（128件、911 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64 buildと既存`--version`/`--help`、文書リンク/コードフェンス/空白/英語AGENTS.md、`git diff --check`に合格。既存CLIはv0.1.2のままでlifecycleコマンドをまだ表示しない。今回の新moduleの検証はローカル自動テストであり、Cloudflare実機の新しい合格記録は追加していない。

## 2026-10-01: Show/Episode公開停止の状態機械を追加

- `runLifecycleUnpublish`は既に取得済みの実行tokenを照合し、状態停止→親がactiveならfeed入力更新→feed generation→purge→durable完了→owner解放を実行する。Show停止では子状態と保存済みcontentを変更せず、停止中の親の子操作ではfeedを書かない。
- Episodeは期待generation/最終jobの照合とETag CASで停止する。同jobの状態書込再送を冪等にし、feed generationも`last_feed_job_id`で二重加算を防ぐ。purge phaseまで完了したfeedはpurge retryで書き直さない。
- feed/purge失敗で停止を戻さず、retrying statusとowner/tokenを保持する。状態、feed generation、完了progress/status、解放の各応答喪失から収束する自動テストを追加した。完了後の同token再送で副作用を繰り返さない。
- feed書込とcache所有entrypointのpurgeは必ずawaitする注入effectであり、現在のテストはその契約をmockで確認している。本番feed/内部Cache/Queue/API/CLIへの接続・実機確認は未完了。failed invocationから次のinvocationへ安全に引き継ぐ実行終了確認も未実装で、tokenの時間切れ解放はない。
- `npm run check`、M6実証tsconfig、`bun test`（121件、818 assertions）、`git diff --check`に合格。公開停止コマンドはまだ提供せず、運用サービスは変更していない。

## 2026-10-01: lifecycleを反映したfeed入力の読取を追加

- 実行tokenを照合してcurrent metadataとEpisode lifecycleをページ列挙し、activeだけをfeed入力へ採用する共通処理を追加した。Episode停止/削除の対象はstate書込前でも除外し、明示的restoreの対象自身だけを復帰候補とする。Show再開でも他の停止/削除/draft Episodeは戻さない。
- Show停止中の子操作およびShow全体の停止/削除はfeedを書かない。初回Show公開・空feed・metadata-only Episode revisionの旧音源再利用も扱う。候補revisionはpublication ownerと照合する。
- 既知Episodeのstate欠落、active/restore対象metadataの欠落、媒体の欠落/size変化、不正音源path、inventory変化、実行token喪失、件数/metadata予算超過はfail closed。媒体はHEADだけで存在・sizeを確認し、300MB bodyを読み込まない。これは内容checksum再検証ではない。
- `npm run check`、`bun test`（113件、750 assertions）に合格。本番publication/feed書込はまだこの入力処理へ接続しておらず、運用bucketは変更していない。

## 2026-10-01: 読み取り専用の削除対象ページを追加

- Episodeの3 prefix、Showの4 prefix＋Show snapshot単一keyを固定した削除inventoryを追加した。payloadとpublication commit markerを区別し、未知keyをblockerとして返す。対象ID・revision/job UUID・一覧metadata・cursorの進行を検証する。
- list/headだけを使い、300MB媒体のbody読取・削除・状態変更は行わない。Show予約・制御record・Episode tombstone・lifecycle marker・job監査は対象外。末尾`/`を維持し、似たShow/Episode IDの混入を拒否する。
- inventoryは`authorizesDeletion=false`を返す。1ページ完了は削除完了でも受付取得でもない。実削除にはowner/実行token・配信停止・purge・耐久progress・先頭からの最終再列挙が必要で、削除consumerはまだ未接続。
- 残すpublication markerの内容・保持期間の最終確認は未完了であり、今回は保存・削除のpolicyを新たに確定していない。
- `npm run check`、`bun test`（105件、708 assertions）、`git diff --check`に合格。Cloudflareリソースは変更していない。

## 2026-10-01: version別status・耐久progress・完了解放を追加

- 旧v1 publication statusを保持し、strictなv2 statusとv1 progressを追加した。action・phase・owner generation・要求hash・対象・結果状態を検証し、`published`とlifecycleの`completed`を分離する。既存publicationの書込はv1型へ限定し、挙動を変更していない。
- 実行tokenを保持した`finishShowOperation`は、耐久terminal status/progress、purge成功、owner/request/generation、対象の結果状態を照合して同じShow keyのCASで解放する。完了receiptを同時保存し、解放応答喪失の再送でも次のownerを変更しない。
- 欠落/破損/旧status、retrying、hash不一致、未完phase、purge未確認、対象状態の不一致ではowner/tokenを保持する。generationの上限でShow/feed/Episodeを受付拒否する。
- `npm run check`、M6実証tsconfig、`bun test`（100件、642 assertions）に合格。status/progressを書き進めるconsumer、upload終了処理、API/CLIへの接続は後続。実機・運用リソースは変更していない。

## 2026-10-01: 同job内のconsumer実行排他を追加

- Show ownerへprocessing専用の`execution_id`を追加し、取得・照合・解放をShow制御keyのETag CASで実装した。reserved→processingとtoken取得を一度に行い、同jobの重複配送16件でも1 invocationだけを実行可能にする。
- 終了したinvocationはtokenだけを解放し、Showのprocessing ownerを保持する。誤ったjob/generation/token、前invocationからの遅延解放、凍結requestの改変、uploadingでの実行を拒否する。
- 取得応答喪失はtokenを保持してfail closedとし、解放応答喪失は再照会で冪等に回復する。時間切れでtokenを奪う仕組みは追加していない。すべての副作用が終了した後だけ解放することが呼出側の契約である。
- 本番consumerは未接続。runtime強制終了時の安全なtoken回復は未実装であり、M6の残ゲートとして保持する。これはREST単一PUTの未解決懸念U1とは別の問題である。
- 自動テストは91件・561 assertionsに合格。Cloudflareリソース・運用サービスは変更していない。

**現在のupload方針（2026-10-01）**: 管理者判断により現行REST単一PUTを維持し、クライアント切断後に遅れてobjectが作成・更新されないと仮定する。確認済み仕様ではなく[未解決懸念U1](./m6_upload_recovery_options.md)として保持し、M6公開をブロックしない。以下の過去ログにある条件付きPUT/分割uploadの公開ゲート判断は、末尾の決定で更新された。既存実測はそのまま保持する。

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

## 2026-10-01: 読み取り専用の既存サービス移行plan

CAS実証と限定abandonを`0523af1`でcommit/pushした後、upload protocolの未解決事項と独立した移行準備を進めた。

- `src/lifecycle-migration.ts`に`planLifecycleMigration`を追加。受け取れるbucket操作はlist/getだけで、R2の更新/削除・owner解放・legacy record変換は実行しない。CLI/管理APIにもまだ接続しない。
- 予約・公開snapshot・current Episode・revision history・draft keyをページ終端まで列挙し、source ETag/sizeと初期状態案を返す。既存公開をactive、未公開の予約/draftをdraftへ分類し、metadata-only改訂で古い音源revisionを再利用するpathも検証する。
- legacy reserved/processing、未完了commit、失われたfree-ownerのpublished status、予約/metadata/controlのID不一致、feed/cover/media/history欠落、破損record、orphan media、未完了deletion、deleted stateの残存payloadをblockerにする。すでにv2のrecordは状態/generationをそのまま保持し、部分初期化やlifecycle stagingは自動補完せず要調査とする。
- メタデータread時にlistのETag/sizeとの一致を確認し、変化・R2障害・不正なpaginationはplan生成自体を中止する。読取recordは1MB、inventoryは既定10,000 objectsの上限を設け、超過はbatch設計を要求する。上限を理由に一部だけを合格扱いしない。
- `inventory_compatible=true`でも、旧CLI停止・継続HTTP PUTの収束・atomic migration受付・移行完了を意味しない。常に`requires_quiescence=true`を返す。一覧全体のtransaction snapshotやpayload SHA-256実測ではない。適用時の再照合・耐久progress・旧cache purge・capability切替は未実装。
- Cloudflareの運用サービスでは実行していない。単体テストで不変性、1,000件超/短いページ、既存停止状態の保持、部分初期化拒否、source変化/障害、上限/不正cursorを確認する。
- `npm run check`、専用実証tsconfig、`bun test`（77件、485 assertions）、`git diff --check`に合格。

## 2026-10-01: 公開snapshot・path/cache identityの共通処理

読み取り専用migration planを`76447f2`でcommit/pushし、未接続の公開ゲート基礎を続けた。

- `readPublicVisibilitySnapshot`は公開可否とShow/feed/Episode generation、対象IDを同じ状態readから返す。Show assetはShow 1 read、音源はShow/Episode 2 reads。公開判定後に別のShow readでcache generationを拾い直す必要をなくした。従来の`readPublicVisibility`はsnapshotのvisibilityだけを返す互換wrapperとして維持する。
- 親子の2 keyをtransaction snapshotで読むわけではない。停止前に開始済み要求の転送保証も変えていない。非公開snapshotからはpublic cache tokenを返さず、空Episode IDをShow lookup扱いしない。
- `src/public-assets.ts`: v0.1.2と同じ公開path/ID/UUID/媒体keyを解析するpure helperを追加。Show/Episode対象が一致するpublic snapshotだけからcache propsを作り、feed/cover tagを維持しつつshow/episode階層tagを追加。Episodeタグはslug結合が曖昧にならない区切りにする。
- migration planのenclosure path検証も同じparserを使用。既存`src/index.ts`やconsumer/CLIへはまだ接続せず、v0.1.2の公開応答/headerは変更していない。cache実証fixtureや既存JSON証拠を新snapshotの本番回帰結果と扱わない。
- 新たな8テストでread回数、snapshot世代/対象照合、非公開/不正generationのcache key拒否、private/encoded/不正ID path拒否、tag衝突防止を確認。`npm run check`、専用実証tsconfig、`bun test`（85件、532 assertions）に合格。
- [upload方式の選択肢](./m6_upload_recovery_options.md)を追加。既存REST直PUTを条件付きwriteで取消できないことが現在の主要ゲート。同じWorkerを介する分割sessionを推奨候補として整理したが、方式変更は未承認・未実装。CLI/公開入口の接続とdelete公開は引き続き保留する。
- Linux x86-64 build、既存version/init help、文書リンク/コードフェンス/空白、英語AGENTS.md、`git diff --check`にも合格。今回のCAS試験で作成した4組のWorker/bucketすべてがREST GETで404であることを最終確認した。

## 2026-10-01: 単一PUTの維持と未解決懸念U1の扱いを決定

管理者のレビューで、abort済みのREST単一PUTが保存を続けるという説明の根拠を再調査した。公開資料・公開事例・binding側の公開実装から、対象REST経路でクライアント切断後にmetadata commitが完了することや、その取消保証を確認できなかった。R2のデータ保存→metadata commit→object可視化→200送信という説明、PUT/DELETEのlast-writer規則、Workers/S3のIncompleteBody/ClientDisconnectは、その挙動の証明ではない。部分ファイルをDELETEする前提ではなく、未確認の遅延確定リスクとして説明すべきだった。

管理者はCloudflareサポートへの問い合わせを行わないと指示し、続けて以下のM6方針を決定した。

- **現行Cloudflare REST APIの単一object PUTを維持**する。Worker経由の分割upload sessionやS3 credentialsは導入しない。
- **クライアント切断後にそのPUTが遅れてobjectを作成・更新することはない**と仮定する。これはCloudflareの確認済み仕様でも新たな実機合格でもない。
- 仮定が誤っているなら削除完了後にstaging payloadが残る可能性があるという点を、[未解決懸念U1](./m6_upload_recovery_options.md)として記録する。この懸念の解消・困難なローカル再現・分割uploadへの変更をM6公開条件にはしない。反例や明確な公開仕様が得られた場合は再検討する。
- REST PUTが不一致`If-Match`でも上書きしたという既存実測は変更しない。条件付きREST PUT fenceは使わず、この試験を切断後の保存継続の証拠とも扱わない。
- 同じShowの原子的受付、通常PUTの完了/size/内容照合、明示的publish、300,000,000 bytes上限、移行時の旧CLI停止は維持する。単なる経過時間やHEAD不在を理由に、まだ継続中のPUT/Worker/consumerを解放する方針ではない。切断後のowner/generationを照合した回復・解放は上記仮定の下で後続実装へ接続する。
- 変更は設計・実装ログ・README・Agent Guide・試験の解釈に限定する。CLI/Worker/テストコード、保存済み実測JSON、Cloudflareリソース、Releaseは変更していない。M6全体の公開ゲートを通過したとは扱わない。
- `npm run check`、`bun test`（85件、532 assertions）、文書リンク/コードフェンス/空白・英語AGENTS.md確認、`git diff --check`に合格。これらは文書更新の回帰確認であり、U1の仮定を実証したものではない。
