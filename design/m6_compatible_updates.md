# M6: 保存形式を変えない通常更新

更新日: 2026-10-15

## 範囲

M6稼働済みサービスのWorkerだけを更新する経路を、v0.2.0以降の正式`deploy`へ接続済み。Show/Episodeのschema変換、音源・revision・公開snapshotのinventory、legacy bridgeは実行しない。新規初期化・通常更新・必要時の旧形式変換を独立した責務として扱う。操作は[README](../README.md#compatible-worker-updates)を参照する。

通常更新で使うコードはM6保存形式を維持する検証済みbuildに限定する。source hashから任意のコードの保存形式互換性を自動証明する仕組みではない。Custom Domain/route変更はこの経路へ含めず、旧版の汎用変換frameworkも作らない。

## 最小の安全な経路

1. 明示pause後にdraining consumer/recoveryを完了する。新規管理操作は既存のservice境界で拒否される。
2. 凍結要求のpause ID・service generation・旧Worker version・config hashを照合する。live service token、unfinished Show owner（uploading/reserved/processing）、未完了Show登録があれば更新しない。
3. Showの小さいcontrol recordだけを検査し、service ETagへのCASで`updating`を獲得する。このCASにより、検査中に起きたconsumer/token変更も拒否する。以降は管理/consumer/recovery/通常配信を閉じる。
4. 準備時とupload直前に、Versions APIの最新uploadが旧Worker versionと一致することを確認する。durable journalの`deploy_requested`を保存してから、一度だけVersion Upload APIへPOSTする。凍結metadataは継承元UUIDと保持設定を含む意図全体であり、実multipartにはversion単位のmetadataだけを送り、APIが受理するinherit `version_id: "latest"`へ変換する。script単位のtags/logpush/tail consumer/placement/observabilityは変更しない。
5. POST応答のversion ID・連番・script ETagを検証し、allowlist receipt、upload前の旧deployment ID、activation未開始checkpointを新形式journalへ一緒にfsync保存する。新versionの連番が旧versionの直後であること、最新二件がacknowledged versionと旧versionそのものであること、そのIDのimmutable version GETのscript ETag、旧deployment/凍結設定が維持されていることを前後二回確認する。server ownerの再照合後、activation開始checkpointをfsync保存してから、そのacknowledged versionだけを100%にするDeployment APIへ一度POSTする。途中の別upload/secret変更・未知の最新version・連番欠落では配備しない。Deployment POSTのIDを保存し、そのIDとGETの100% version・保持設定を照合する。POSTのstrategy/versionsが省略されていてもID自体は必須で、省略値を応答へ捏造しない。応答にversionsがあれば照合する。最新versionを見つけたことだけで自分のuploadとは扱わない。REST検査とは別にruntimeの配信・管理・consumerを検証する。
6. new targetをserver admissionへ固定し、検証前後のdeployment/settings/configを照合してreadinessをCAS更新する。開発版では、その前にexact owner/updating/空registryを照合しながら既存Show/Episode controlとService TOMLの[配信用metadata](public_delivery_projection.md)を準備する。本文・generationは変更しないが、metadata-only PUTのupload version/ETag不変は仮定しない。準備失敗でもupdatingを保持する。完了はpausedのまま。再開は別の明示操作とする。

admissionの旧`readiness`（legacy移行監査）は変更せず、新versionの稼働判定は`runtime_readiness`へ置く。停止/削除等の通常content制御も変更しない。requestは`system/service-updates/<operationId>/request.json`へ保持し、操作IDを別内容で再利用しない。

## 責務の共通化

- `src/m6-runtime-readiness.ts`: 初期化/更新共通のconfig・version・REST snapshot・runtime receipt検証。状態遷移は持たない。
- `src/m6-service-update.ts`: paused→updating→pausedの更新固有CASと未完了owner確認。初期化やlegacy変換は呼ばない。
- `packages/cli/src/m6-service-update.ts`: begin/deploy/completeの要求前journal保存と非再送。一つの巨大な汎用状態機械へ統合しない。
- journalのファイル保存/lockとWorker payload hashは既存機能と共有する。
- `packages/cli/src/m6-update-rest.ts`: server owner確認と実REST uploadを結ぶ。資源作成やpayload書込はしない。

## 失敗と制約

時間/HEAD不在だけでtokenやShow ownerを解放しない。upload/deployment/HTTP応答喪失ではrequestedを保持し、再送・旧readinessへのrollback・自動resumeは行わない。server上の同一targetに対する読み取り専用再検証と、clientによる不明な書込要求の再送は区別する。既存runtime-check記録に属するoperation IDは受付前に拒否し、初期化ID再利用による配備後の記録衝突を防ぐ。

### Issue #11: upload受付後・activation前の中断

開発版の新規journalは`schema_version: 2`。`phase: deploy_requested`に次のcheckpointを持つ。metadataやsource本文、secretは保持せず、既存凍結要求のhashとupload receiptを使う。

- `activation_checkpoint: { previous_deployment_id, state: "not_started" }`: upload受付と同じatomic local journal replacementで保存する。以後のGET/検証失敗は、この状態を保持する。
- `state: "requested"`: Deployment POSTより前にfsync保存する。保存失敗時にはPOSTしない。保存成功後にPOSTの応答が不明、受付receiptの保存に失敗、またはPOST前にプロセスが停止しても、未開始へ戻さず再送を拒否する。
- `deployment_receipt`: acknowledged Deployment POSTの応答だけから保存する。receipt後のGET失敗には従来の`update-service-verify`を使う。completion応答喪失には`update-service-reconcile`を使う。

`update-service-continue OPERATION_UUID`は同一journalのexclusive lockを取り、schema-v2・upload receipt・未開始checkpoint・deployment receiptなしの場合だけ続行する。Version POST、beginの再送、新しいsourceのbuildはしない。config hash・同一凍結request・旧readiness・pause ID・CAS獲得直後のgeneration・空invocation・未固定targetのserver ownerを照合し、RESTの前後snapshotで凍結settings、元deployment ID、最新二versionのID/連番、immutable upload versionのscript ETagを検証する。activation直前にも同じserver ownerを照合する。既存の`updating` CASが排他的な更新ownerであり、GETを新しいCASやCloudflareの原子的lockの代用とはしない。別ownerの採用や解放は行わない。activation・runtime completionに成功してもpausedで終了する。

schema-v1は読み取りと両receiptに基づく既存verify/completion照合だけを維持する。**Issue #11に記載された旧形式upload-only journalは、この修正でも復旧しない。** 旧形式の同じdurable状態は未開始と応答不明を区別できず、現在旧deploymentが見えることも未知IOの不存在を証明しない。checkpointの推測・自動昇格・journal編集・手動activation・強制解除は禁止。旧形式の`prepared`も新protocolでは開始しない（serviceがpaused/drainedで旧操作未開始と確認済みの場合のみ別operation IDを使う）。新形式でも不明upload、requestedでdeployment receiptなし、残存lockは閉じたまま保持する。

Cloudflare GETの一般retry・timeout変更は含めない。caught GET失敗後の明示続行に限定し、POST再送、時間による解除、万能な外部復旧は追加しない。mock限定テストで正式command runnerからの続行、再uploadなし、server CAS owner/paused完了、REST drift、checkpoint/receipt保存失敗、activation応答喪失、旧journalと残存lockの拒否を検証する。実Cloudflare環境の復旧・release受け入れとは区別する。

現段階のShow-control検査は一回100件のbounded listであり、truncatedなら配備前に拒否する。runtime budgetを超える大規模サービスの更新手順は未対応で、この上限をサービス全体の公開仕様として決定したものではない。実機のruntime制約に適合することも公開前の受け入れ対象である。

service境界は、このprotocolを無視した第三者のCloudflare操作を禁止できない。メンテナンス中は別deploy/upload/version削除/secret変更を行わない運用を前提とし、REST snapshot・version履歴・upload ETagの不一致では閉じた状態を保持する。最新versionの前後照合はCloudflare上の原子的lockやUUID指定inheritの保証ではない。任意の将来の非互換コードや外部deployerを安全にrollbackする一般機構ではない。

## 検証履歴（2026-10-04）

以下の未接続・残件は当時の進捗。正式`deploy`は配備・runtime検証後もpausedで完了し、v0.3.0では一致するCustom Domain接続を保持する。[独自ドメイン設計](custom_domain_plan.md)と[実機記録](archive/m6_standalone_acceptance.md)を参照する。unknown IOや残存lockの強制解放は提供しない。

content/Show control/公開音源/revision/staging/job記録の非変更、live owner拒否、遅いconsumerとのCAS競合、別update競合、targetの固定、旧監査証拠保持、journal/要求喪失、RESTの入力凍結/secret inherit/ETag照合を自動テストした。共通runtime検証の異常系は既存初期化テストを利用し、同じ安全条件の重複テストを増やしていない。

認証付き`/admin/update/begin`と初期化共通のsetup検証、試験専用standaloneの`update-service OPERATION_UUID`を接続した。明示pause/drainが必要で、自動resumeやlegacy変換はしない。通常`deploy`や公開CLI/HTTP入口には未接続で、M6 ready=falseと公開書込gateを維持する。

`update-service-verify OPERATION_UUID`は、保存済みのupload/deployment receiptが両方揃った`deploy_requested`だけをGET-only RESTで再検証し、その後に未実行のruntime completionへ進む。upload/deployment/subdomainは再送せず、旧version previewも既に無効であることを検査するだけで書き換えない。acknowledged `deployed`からのcompletion続行も可能である。completion応答だけが失われた場合には、別の`update-service-reconcile`で初期化共通の永続完了証拠を非書込照合する。receiptが欠けた要求や残存lockは昇格しない。[完了応答喪失の照合](./m6_completion_recovery.md)参照。

実機の最初の更新試験`castloop-m6-test-49c82745`では、Script PUT APIがinherit bindingの特定version UUIDを拒否した（HTTP 400/code 10057、`latest`のみ対応）。別名`castloop-m6-test-9fcbd823`でもVersion Upload APIが同じUUID指定を拒否した。公開API referenceのUUID対応記述だけを根拠にせず、上記の最新upload/直後の連番/履歴照合を伴うVersion Upload/Deployment APIへ修正した。両環境はserver `updating`/local `deploy_requested`と凍結要求を保持し、再送・GETからの採用・rollback・resume・削除はしていない。workspaceはそれぞれ`/tmp/opencode/<Worker名>`。拒否応答を受けたことだけで復旧済みとは扱わない。

`castloop-m6-test-7fefb49f`ではVersion/Deployment POSTまで進んだが、Deployment応答のstrategy/versions省略で停止した。改善前のjournalには中間receiptがないため、GETから自分の要求と推定して続行しない。修正後binaryの`update-service-verify`もこの要求（`38dc81dc-1ac5-42c1-ae78-320f405ec56e`）を拒否した。資源とupdating/requestedはそのまま保持している。

修正後の`castloop-m6-test-ff3bfd8c`（`/tmp/opencode/castloop-m6-test-ff3bfd8c`）でstandalone通常更新が合格した。operation `4a778ece-9d99-4993-b076-cf132ce99c40`、旧version `5fed1fdd-a4b9-49e3-ba07-7562bb1e94a4`から新version `1e29cc26-676a-430f-95a8-1040b84c6f9c`、deployment `3b5232b1-2d7d-4240-99a3-ec3bba31cc7e`を確認した。service/Show/Episode controls、metadata/revision/feed/cover/audioの既知10 objectはbytes/hash/ETagとも非変更、GUID/revision/URLも維持された。実HTTP/Queue/cache起動検証後にpausedで完了し、明示再開後のnew version配信と媒体checksum/再検証header、明示再pause・空invocation registryを確認した。記録はworkspaceの`compatible-update-acceptance.json`。

これは小さいfixtureの通常更新受け入れであり、unknown outcomeの外部回復やM6全体のlifecycle/cache HIT/300MB受け入れ、正式releaseとは区別する。これらは④で継続する。旧形式変換の追加開発は、必要になった場合だけ行う。
