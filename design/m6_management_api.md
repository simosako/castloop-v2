# M6: 管理APIの共通受付・配信gate接続

更新日: 2026-10-02

## 現在の範囲と公開gate

`handleM6StagingAdmin`を独立した内部handlerとして追加した。共通service registry、M6 readiness/実行version/cache owner gate、staging Show CAS owner、一度限りPUT開始、明示的終了申告、stream検証/取消を接続した。

`handleM6PublicationAdmin`も独立した内部handlerとして追加した。service設定/identity、service invocation、副作用前後のruntime gateは`withM6ManagementInvocation`で共通化し、公開manifestの凍結/Show CAS受付とstaging証拠検査後のcommit marker作成へ接続する。

現行Worker、bridge、candidateのfetch入口には接続していない。candidateは引き続きread-onlyで、R2にmock readinessを入れても通常書込を開けず、`m6_ready=false`を維持する。CLI書込操作も公開しない。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。

## Stagingのwire契約

将来の`POST /admin/staging`で、共通strict schemaの`schema_version=1`、`service_id`、`action`を使う。

| action | 入力 | 結果 |
| --- | --- | --- |
| `claim` | 凍結済み`upload` manifest | `claimed`とshow/operation ID・取得generation |
| `begin` | `operation` | `started`と許可されたkey/length/checksum。開始は一回限り |
| `settle` | `operation`、明示的`put_requests_settled=true`、`no_more_puts=true` | `settled`。PUT permissionを再発行しない |
| `finish` | `operation`、`outcome=staged/aborted` | 全副作用終了後に同outcomeを返す。settlement前は拒否 |

認証は既存の`X-Castloop-Key`照合を使い、認証/method/schema/対象serviceの検査を副作用より前に行う。bodyを16,384 bytesへ制限し、宣言長・実stream長・UTF-8・JSONを検査する。過大streamのcancelはawaitし、readerを解放する。responseは常にno-storeで、本文や任意exceptionを返さず、失敗にはallowlistの固定診断だけを使う。

操作identityはsnake_caseで、入力manifestのoperation IDとdraft job IDを分離したまま返す。PUT locationsはstagingの許可keyだけに限定し、show ID/UUID/size/重複を検査する。responseを任意prefix書込の許可へ使わない。payload uploadは引き続きCLIの別REST接続で行う構成であり、Worker handlerで媒体を受信/バッファしない。

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
| `claim` | 凍結する`publication` request/commit/staged_uploads | `claimed`とshow/job ID・取得generation。新規受付はopenだけ |
| `commit` | `operation` | `committed`とmarker key/created。既受付publicationはpause中にも収束できる |

manifest schemaをsharedへ移し、既存の`src/publication-admission.ts`のexportも互換re-exportとして保持した。Show/Episode commit schemaと既存RFC3339 timestamp検査もsharedの独立moduleへ移し、既存の検査条件を変えず、CLIがWorker側schemaをimportする必要をなくした。

publication job IDは凍結draft job IDと一致する。commit作成はretained staging manifest/progress/status、検証済みhash/length/current ETag、Episodeのbase revision/history/unchanged audioを照合する。新しいmetadata/audio/公開状態をwire入力から直接配信しない。失敗時はreserved ownerを保持し、同IDのrequestを勝手に変えたり、別jobへ解放したりしない。

claim/commitはfeed/cover/音源/current metadataを公開しない。commit markerを最後にR2へ作成し、そのnotificationが同じ管理Queueへ渡る既存構成を使う。HTTP handlerから追加Queue送信やconsumer実行をしない。明示的な同marker照合ではcreated=falseを返し、markerを再PUTしてnotificationを増やさない。Queue配送はat-least-onceであり、created=falseを配送/consumer終了の証拠として扱わない。

commit応答喪失や最後のruntime gate失敗でも、既存marker/ownerは保持する。service token取得応答喪失はregistryを保持する。自動retry/新job作成は行わず、CLI側のdurable outcome照会と安全な明示復旧を別途完成する。

## 検証と残件

ローカルhandler結合でShow/Episode metadata/audio、pause/drain、一回限りbegin、settlement前finish拒否、stream検証中のregistry/Show token保持、checksum失敗、foreign owner/generation、未知token・begin応答喪失、body/response上限、read-only candidateを回帰した。これはCloudflare実機/300MB/CPU・料金/切断挙動の合格ではない。

publicationは新しいstaging内部API→publication内部API→実M6 Queue adapterをローカル結合し、Show/Episode初回公開、metadata-only/audio-only改訂、immutable media/history保持とpurge終了後のpublished化を回帰した。live commit検証中のpause/registry保持、検証後payload変更、missing proof/status、base revision変更、foreign job/generation、commit応答喪失/最後のgate失敗、未知service token、同marker非再PUT、read-only candidateも検査した。R2 notification実配送やCloudflare実routingの合格ではない。

公開入口/CLI clientへの接続、upload/publication progress照会とdurable復旧journal、lifecycle管理boundary、full cutover/paused移行完了/明示受付再開、unknown outcomeの外部復旧、専用環境受け入れは残件である。
