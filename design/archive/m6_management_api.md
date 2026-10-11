# M6: 管理APIの共通受付・配信gate接続

更新日: 2026-10-02

## 現在の範囲と公開gate

`handleM6StagingAdmin`を独立した内部handlerとして追加した。共通service registry、M6 readiness/実行version/cache owner gate、staging Show CAS owner、一度限りPUT開始、明示的終了申告、stream検証/取消を接続した。

`handleM6PublicationAdmin`も独立した内部handlerとして追加した。service設定/identity、service invocation、副作用前後のruntime gateは`withM6ManagementInvocation`で共通化し、公開manifestの凍結/Show CAS受付とstaging証拠検査後のcommit marker作成へ接続する。

`handleM6LifecycleAdmin`も独立した内部handlerとして追加した。Show/Episodeの停止・再開・削除を同じservice gate/Show CAS受付/凍結commitへ接続し、読み取り専用dry-run/statusと同jobの明示的retryを提供する。HTTP handlerにpayload削除bindingを要求せず、物理削除は所有権を確認するQueue consumerのbounded処理だけで行う。

2026-10-02に3handlerを未公開の`fetchM6ManagementIntegration`へ接続した。`POST /admin/staging|publication|lifecycle`だけを、認証後に`requireCandidateReadiness`（M6 mode・完了readiness・実行version一致）で検査してから各handlerへ渡す。legacy/migrating/未初期化serviceやversion不一致は固定診断409で書込前に拒否し、method不正は405、認証失敗は401である。

続いて新規Show登録用の4番目の内部handlerを`POST /admin/shows`へ接続した。共通gateの後で、永久reservation IDをShow controlのconditional createで取得し、同IDの予約recordを初期化する。partial登録中は共通Show受付を閉じる。`action=status`は非書込で、通常candidateの書込gateは変更しない。詳細は`m6_show_registration.md`。

CLIが期待generation/current/baseを取得するための読み取り専用`POST /admin/target`も内部入口へ接続した。strict target入力、M6 read boundary、current metadata/historyと前後ETag照合を使い、unfinished owner中はbaseを返さない。応答は操作/復旧許可を与えず、operational recordへ本文を保存しない。通常candidateでは閉じたまま。詳細は`m6_target_inspection.md`。

これは結合検証専用の明示的入口であり、`src/m6-worker.ts`は引き続き通常の`fetchM6Candidate`を呼ぶ。現行Worker・bridge・通常candidateのmanagement書込は閉じたまま、R2にmock readinessを入れても開かない。既存の認証GET照会は維持し、legacy管理書込も拒否する。`m6_ready=false`・CLI書込command非公開を維持し、Cloudflare書込/deployや既存環境への適用は行っていない。

## Stagingのwire契約

将来の`POST /admin/staging`で、共通strict schemaの`schema_version=1`、`service_id`、`action`を使う。

| action | 入力 | 結果 |
| --- | --- | --- |
| `claim` | 凍結済み`upload` manifest | `claimed`とshow/operation ID・取得generation |
| `status` | 同じ完全な`upload` manifest | 読み取り専用status/progress/owner/検証稼働/draft commit観測。PUT/復旧許可なし |
| `begin` | `operation` | `started`と許可されたkey/length/checksum。開始は一回限り |
| `settle` | `operation`、明示的`put_requests_settled=true`、`no_more_puts=true`、`readback_receipts` | `settled`。PUT permissionを再発行せず、保存後の証拠変更も拒否 |
| `finish` | `operation`、`outcome=staged/aborted` | 全副作用終了後に同outcomeを返す。settlement前は拒否 |

認証は既存の`X-Castloop-Key`照合を使い、認証/method/schema/対象serviceの検査を副作用より前に行う。bodyを16,384 bytesへ制限し、宣言長・実stream長・UTF-8・JSONを検査する。過大streamのcancelはawaitし、readerを解放する。responseは常にno-storeで、本文や任意exceptionを返さず、失敗にはallowlistの固定診断だけを使う。

操作identityはsnake_caseで、入力manifestのoperation IDとdraft job IDを分離したまま返す。PUT locationsはstagingの許可keyだけに限定し、show ID/UUID/size/重複を検査する。responseを任意prefix書込の許可へ使わない。payload uploadは引き続きCLIの別REST接続で行う構成であり、Worker handlerで媒体を受信/バッファしない。

2026-10-04、settlementへCLI全量SHA-256読み戻し証拠（asset/size/hash/ETag/version）を追加した。凍結manifestの順序に一致する成功済みprefixだけを受け付け、staged finishは全payloadの証拠を要求する。Workerの音源検証はHEAD identity照合であり、独立した全量hashではない。metadata/coverのbounded内容検証・owner/generation・未収束token保持は維持する。詳細は[完全性検証契約](./m6_upload_integrity_review.md)。

未公開staging client/durable journalを追加し、exact PUT key/size/hash/order照合、送信前requested保存、一度限りPUT、全PUT終了保存後の明示settlement/検証を接続した。statusは共通read-only runtime/snapshot boundaryから保持manifest/request/progress/statusを照合し、payloadを読まずtokenを登録しない。unknown response/保存失敗では観測から再送/終了認定しない。詳細と実REST source adapter/公開CLI/外部復旧の残件は[`m6_staging_client.md`](./m6_staging_client.md)参照。

## 排他・pause・応答喪失

- `claim/begin`は`m6_admin` invocationとして登録し、pause中は拒否する。
- `settle/finish`は`m6_recovery` invocationとして登録し、既受付の処理をpause中にも収束できる。新規PUT開始・公開・受付再開を兼ねない。
- 副作用前後に同service token/readiness/実行version/cache ownerを照合する。すべてのoperation/stream/最後のgate Promiseがsettleしてからservice tokenを返す。
- 管理HTTP invocationのservice tokenと、別REST PUTを保護するShowの`uploading` ownerは別である。begin HTTP終了後もShow ownerは保持する。時間やHEAD不在だけでownerを解放せず、finishは明示的なclient settlementを要求する。
- settlementはclientの明示申告であり、Workerによる別REST接続終了の直接観測ではない。承認済みREST単一PUT方針と未確認懸念U1を変更しない。
- begin progressのPUT応答喪失はuploadingを保持し、再beginを拒否する。service/verification tokenの取得応答喪失は未知tokenを保持する。自動retry・期限によるtoken奪取を追加しない。
- 正常な検証失敗はsettled/retryingと固定診断を残し、Show ownerを保持する。同ownerの明示的検証/取消を可能にするが、異なるID/generationへ解放しない。
- abortはstaging ownerの安全な終了であり、payload物理削除ではない。payloadは別の明示的cleanup方針へ委ね、ここで期限削除やprefix削除をしない。

## Publicationのwire契約

将来の`POST /admin/publication`は同じ認証/16KB bounded JSON/no-store/固定診断を使い、`schema_version=1`、`service_id`と次のactionを受け付ける。

| action | 入力 | 結果 |
| --- | --- | --- |
| `claim` | 凍結する`publication` request/commit/staged_uploads | `claimed`とshow/job ID・取得generation・manifest hash。新規受付はopenだけ |
| `commit` | `operation`と完全manifestの`manifest_sha256` | `committed`とmarker key/created/hash。既受付publicationはpause中にも収束できる |
| `retry` | 同じ`operation`と完全manifestの`manifest_sha256` | `requeued`とexact marker key/hash。保持jobだけを一回Queue送信 |
| `status` | 同じ完全な`publication` manifest | 非書込status/progress/owner/execution/marker観測。staging検証/復旧許可なし |

manifest schemaをsharedへ移し、既存の`src/publication-admission.ts`のexportも互換re-exportとして保持した。Show/Episode commit schemaと既存RFC3339 timestamp検査もsharedの独立moduleへ移し、既存の検査条件を変えず、CLIがWorker側schemaをimportする必要をなくした。

publication job IDは凍結draft job IDと一致する。commit作成はretained staging manifest/progress/status、検証済みhash/length/current ETag、Episodeのbase revision/history/unchanged audioを照合する。新しいmetadata/audio/公開状態をwire入力から直接配信しない。失敗時はreserved ownerを保持し、同IDのrequestを勝手に変えたり、別jobへ解放したりしない。

claim/commitはfeed/cover/音源/current metadataを公開しない。commit markerを最後にR2へ作成し、そのnotificationが同じ管理Queueへ渡る既存構成を使う。HTTP handlerから追加Queue送信やconsumer実行をしない。明示的な同marker照合ではcreated=falseを返し、markerを再PUTしてnotificationを増やさない。Queue配送はat-least-onceであり、created=falseを配送/consumer終了の証拠として扱わない。

commit応答喪失や最後のruntime gate失敗でも、既存marker/ownerは保持する。service token取得応答喪失はregistryを保持する。自動retry/新job作成は行わず、CLI側のdurable outcome照会と安全な明示復旧を別途完成する。

未公開publication client/durable journalも接続した。commit前に完全manifest hashを保持manifestへ照合し、同jobでも変更された入力から古いstaged copyを黙って公開しない。claim/commitは別の明示操作で、各POST前にrequestedを保存する。状態照会は保持manifest/request/marker/status/progressだけを読み、staging/payload検証やtoken返却を行わない。unknown response/receipt保存失敗では後の観測からphaseを進めたり再送したりしない。retryも保持owner/marker/hash/tokenを検査し、private journalへ通番/requested保存後に一回だけ送信する。marker/status/progressは変更せず、Queue応答喪失でも自動再送しない。詳細とローカル編集/外部復旧の残件は[`m6_publication_client.md`](./m6_publication_client.md)参照。

## Lifecycleのwire契約

将来の`POST /admin/lifecycle`も同じ認証/16KB bounded JSON/no-store/固定診断を使う。`request`は対象・job ID・action・期待generation・timestampを含むstrictな凍結入力で、actionは`unpublish/restore/delete`だけとする。

| action | 入力 | 結果 |
| --- | --- | --- |
| `dry-run` | request、deleteだけ任意のscope/cursor/最大100 objects | `preview`。書込・予約・実行許可なし |
| `status` | request | `status`。保持request/marker/status/progressとownerの読み取り専用照会 |
| `claim` | requestとconfirmation | `claimed`。新規受付はopenだけ、公開状態は変更しない |
| `commit` | 同じrequestとconfirmation | `committed`とmarker key/created。既受付jobはpause中にも収束可能 |
| `retry` | 同じrequestとconfirmation | `requeued`と既存marker key。同jobだけを一回awaitしてQueue送信 |

confirmationは`operator_confirmed=true`とrequest全体のSHA-256を要求する。deleteには`irreversible_delete_acknowledged=true`と`retained_records_acknowledged=true`も必要で、対象・action・ID・generation・timestampの変更は拒否する。これは認証された管理者の明示申告であり、dry-runの予約証拠や実行capabilityではない。claim/commitは改めて現在の状態・所有権・凍結requestを検査する。

### 読み取り専用previewと状態照会

`withM6ManagementRead`はservice identity、M6 readiness、実行version/cache ownerを前後に検査し、service設定/registry snapshotが変化したら拒否する。新しいservice tokenを登録せず、pause中や保持中tokenがある場合にも観測だけを行う。registry/tokenの観測から旧処理終了を推測しない。

previewはShow/Episode状態・期待generation・未完了owner・使用済job等を検査し、固定blockerを返す。削除対象は一回に一つのbounded pageの件数/bytesとopaque cursorだけを返し、未知key名や本文を返さない。`snapshot_only=true`、`authorizes_operation=false`、`payloads_verified=false`とし、削除pageも`authorizes_deletion=false`である。全scopeのinventory合格やrestore音源の完全性を証明しない。restore時のpayload検査はconsumerが実施する。

statusは保持requestのhash/対象/action/generationとmarker/status/progressを照合し、読取前後のShow control/record ETagを確認する。ownerはheld/released/unclaimed/supersededを区別し、後のrestore等で現状態が変わっても過去jobは履歴として照会できる。`execution_active`は観測値だけで、常に`authorizes_retry=false`を返す。任意exception/secretを含む不正statusや旧形式statusは採用しない。

### 同jobの明示retryと応答喪失

commit/retryは`m6_recovery`として登録し、pause中でも同じ保持owner/requestを再確認する。retryは保持markerを上書きせず、job/status/progressを初期化せず、別jobを作らない。Show execution tokenが保持されている場合は送信を拒否し、時間で解放しない。完了済み/foreign/古いjobも送信しない。

Queue.sendは一回awaitする。応答喪失ではmarker/ownerを保持し、自動再送や成功認定をしない。`requeued`は送信応答でありconsumer完了・一回限り配送を意味しない。commitの通常配送はR2 notificationを使い、HTTP commitから追加送信しない。

### 内部CLI client

未公開`LifecycleAdminClient`は固定HTTPS service originと管理keyを使い、各actionを明示的に一回送信する。リダイレクトを拒否し、自動retry・ID/generation/timestamp生成・confirmation生成をしない。送信前にservice/action/strict入力/request hash/削除確認を照合し、応答はno-store/JSON/64KB/strict UTF-8を要求する。異常streamのcancelをawaitする。

responseのservice/result/全operation identity/hash、preview requestとscope/page上限を凍結入力へ照合する。serverの任意本文やtransport exceptionを診断へコピーせず、不明応答では状態照会を案内して止まる。ローカルでclient→内部API→Queueの6操作と応答喪失非再送を回帰した。公開CLI commandには接続していない。

lifecycle専用のdurable journalも内部clientへ接続した。claim/commit/retryは送信前にrequestedをprivate/fsync/rename付きrecordへ保存し、受信・保存済みreceiptからだけ進める。unknown responseやreceipt保存失敗ではrequestedを保持し、後のmarker/status観測から再送/成功扱いしない。非期限lockを奪わず、offline/remote照会も非書込である。詳細と未完成の安全な外部復旧gateは[`m6_lifecycle_client.md`](./m6_lifecycle_client.md)参照。

## 検証と残件

ローカルhandler結合でShow/Episode metadata/audio、pause/drain、一回限りbegin、settlement前finish拒否、stream検証中のregistry/Show token保持、checksum失敗、foreign owner/generation、未知token・begin応答喪失、body/response上限、read-only candidateを回帰した。これはCloudflare実機/300MB/CPU・料金/切断挙動の合格ではない。

publicationは新しいstaging内部API→publication内部API→実M6 Queue adapterをローカル結合し、Show/Episode初回公開、metadata-only/audio-only改訂、immutable media/history保持とpurge終了後のpublished化を回帰した。live commit検証中のpause/registry保持、検証後payload変更、missing proof/status、base revision変更、foreign job/generation、commit応答喪失/最後のgate失敗、未知service token、同marker非再PUT、read-only candidateも検査した。R2 notification実配送やCloudflare実routingの合格ではない。

lifecycleは6操作を内部API→M6 Queue adapterへローカル結合し、停止404・再開200・削除410、媒体/履歴の保持とbounded削除、兄弟Episode分離、運用記録保持を回帰した。preview非書込/非予約、完全request確認、削除の二つの明示確認、paused drain、live consumer中retry拒否、purge失敗から同job retry、Queue応答喪失非再送、過去status、不正/過大/途中変更record、candidate書込拒否も確認した。全504テスト/8550 assertionsと型・bundle・binary検査の合格はCloudflare実機の合格ではない。

公開入口/CLI commandとローカルdraft stateへの接続、実Cloudflare REST/300MB、full cutover/paused移行完了/明示受付再開、unknown outcomeの外部復旧、専用環境受け入れは残件である。

## 未公開fetch結合入口への接続（2026-10-02）

内部管理APIの結合testを、handler直呼び出しから`fetchM6ManagementIntegration`経由へ拡張した。通常candidateと共通の認証・公開path・GET診断処理を使い、management dispatchだけを明示的に有効にする。staging受付→一度限り開始→明示settlement→検証、publicationのmanifest固定claim/commit→M6 Queue consumerによるpublished化、lifecycleの確認付きclaim/commit→同job retry→unpublished化まで、認証/readiness gateを通るrouteで回帰した。

結合入口でもlegacy mode・migrating中・admission欠損・実行version不一致では固定診断409で書込前に拒否する。legacy管理書込は拒否し、既存GET診断は維持する。通常candidateはreadinessの有無にかかわらずmanagement書込を拒否する回帰を保持する。結合testのmock readinessは移行完了や実機deploy・`m6_ready`・CLI公開の合格ではない。
