# M6: 保存形式を変えない通常更新

更新日: 2026-10-04

## 範囲

M6稼働済みサービスのWorkerだけを更新する内部経路を追加した。Show/Episodeのschema変換、音源・revision・公開snapshotのinventory、legacy bridgeは実行しない。新規初期化・通常更新・必要時の旧形式変換を独立した責務として扱う。

通常更新で使うコードはM6保存形式を維持する検証済みbuildに限定する。source hashから任意のコードの保存形式互換性を自動証明する仕組みではない。Custom Domain/route変更はこの経路へ含めず、旧版の汎用変換frameworkも作らない。

## 最小の安全な経路

1. 明示pause後にdraining consumer/recoveryを完了する。新規管理操作は既存のservice境界で拒否される。
2. 凍結要求のpause ID・service generation・旧Worker version・config hashを照合する。live service token、unfinished Show owner（uploading/reserved/processing）、未完了Show登録があれば更新しない。
3. Showの小さいcontrol recordだけを検査し、service ETagへのCASで`updating`を獲得する。このCASにより、検査中に起きたconsumer/token変更も拒否する。以降は管理/consumer/recovery/通常配信を閉じる。
4. 準備時とupload直前に、Versions APIの最新uploadが旧Worker versionと一致することを確認する。durable journalの`deploy_requested`を保存してから、一度だけVersion Upload APIへPOSTする。凍結metadataは継承元UUIDと保持設定を含む意図全体であり、実multipartにはversion単位のmetadataだけを送り、APIが受理するinherit `version_id: "latest"`へ変換する。script単位のtags/logpush/tail consumer/placement/observabilityは変更しない。
5. POST応答のversion ID・連番・script ETagを検証し、allowlist receiptだけを即座にjournalへfsync保存する。新versionの連番が旧versionの直後であること、最新二件がacknowledged versionと旧versionそのものであること、そのIDのimmutable version GETのscript ETag、旧deployment/凍結設定が維持されていることを確認してから、そのacknowledged versionだけを100%にするDeployment APIへ一度POSTする。途中の別upload/secret変更・未知の最新version・連番欠落では配備しない。Deployment POSTのIDを保存し、そのIDとGETの100% version・保持設定を照合する。POSTのstrategy/versionsが省略されていてもID自体は必須で、省略値を応答へ捏造しない。応答にversionsがあれば照合する。最新versionを見つけたことだけで自分のuploadとは扱わない。REST検査とは別にruntimeの配信・管理・consumerを検証する。
6. new targetをserver admissionへ固定し、検証前後のdeployment/settings/configを照合してreadinessをCAS更新する。完了はpausedのまま。再開は別の明示操作とする。

admissionの旧`readiness`（legacy移行監査）は変更せず、新versionの稼働判定は`runtime_readiness`へ置く。停止/削除等の通常content制御も変更しない。requestは`system/service-updates/<operationId>/request.json`へ保持し、操作IDを別内容で再利用しない。

## 責務の共通化

- `src/m6-runtime-readiness.ts`: 初期化/更新共通のconfig・version・REST snapshot・runtime receipt検証。状態遷移は持たない。
- `src/m6-service-update.ts`: paused→updating→pausedの更新固有CASと未完了owner確認。初期化やlegacy変換は呼ばない。
- `packages/cli/src/m6-service-update.ts`: begin/deploy/completeの要求前journal保存と非再送。一つの巨大な汎用状態機械へ統合しない。
- journalのファイル保存/lockとWorker payload hashは既存機能と共有する。
- `packages/cli/src/m6-update-rest.ts`: server owner確認と実REST uploadを結ぶ。資源作成やpayload書込はしない。

## 失敗と制約

時間/HEAD不在だけでtokenやShow ownerを解放しない。upload/deployment/HTTP応答喪失ではrequestedを保持し、再送・旧readinessへのrollback・自動resumeは行わない。server上の同一targetに対する読み取り専用再検証と、clientによる不明な書込要求の再送は区別する。既存runtime-check記録に属するoperation IDは受付前に拒否し、初期化ID再利用による配備後の記録衝突を防ぐ。

現段階のShow-control検査は一回100件のbounded listであり、truncatedなら配備前に拒否する。runtime budgetを超える大規模サービスの更新手順は未対応で、この上限をサービス全体の公開仕様として決定したものではない。実機のruntime制約に適合することも公開前の受け入れ対象である。

service境界は、このprotocolを無視した第三者のCloudflare操作を禁止できない。メンテナンス中は別deploy/upload/version削除/secret変更を行わない運用を前提とし、REST snapshot・version履歴・upload ETagの不一致では閉じた状態を保持する。最新versionの前後照合はCloudflare上の原子的lockやUUID指定inheritの保証ではない。任意の将来の非互換コードや外部deployerを安全にrollbackする一般機構ではない。

## 検証と残件

content/Show control/公開音源/revision/staging/job記録の非変更、live owner拒否、遅いconsumerとのCAS競合、別update競合、targetの固定、旧監査証拠保持、journal/要求喪失、RESTの入力凍結/secret inherit/ETag照合を自動テストした。共通runtime検証の異常系は既存初期化テストを利用し、同じ安全条件の重複テストを増やしていない。

認証付き`/admin/update/begin`と初期化共通のsetup検証、試験専用standaloneの`update-service OPERATION_UUID`を接続した。明示pause/drainが必要で、自動resumeやlegacy変換はしない。通常`deploy`や公開CLI/HTTP入口には未接続で、M6 ready=falseと公開書込gateを維持する。

`update-service-verify OPERATION_UUID`は、保存済みのupload/deployment receiptが両方揃った`deploy_requested`だけをGET-only RESTで再検証し、その後に未実行のruntime completionへ進む。upload/deployment/subdomainは再送せず、旧version previewも既に無効であることを検査するだけで書き換えない。acknowledged `deployed`からのcompletion続行も可能である。応答喪失でreceiptが欠けた要求、completion応答喪失、残存lockは昇格せず、今回の続行経路の対象外である。

実機の最初の更新試験`castloop-m6-test-49c82745`では、Script PUT APIがinherit bindingの特定version UUIDを拒否した（HTTP 400/code 10057、`latest`のみ対応）。別名`castloop-m6-test-9fcbd823`でもVersion Upload APIが同じUUID指定を拒否した。公開API referenceのUUID対応記述だけを根拠にせず、上記の最新upload/直後の連番/履歴照合を伴うVersion Upload/Deployment APIへ修正した。両環境はserver `updating`/local `deploy_requested`と凍結要求を保持し、再送・GETからの採用・rollback・resume・削除はしていない。workspaceはそれぞれ`/tmp/opencode/<Worker名>`。拒否応答を受けたことだけで復旧済みとは扱わない。

`castloop-m6-test-7fefb49f`ではVersion/Deployment POSTまで進んだが、Deployment応答のstrategy/versions省略で停止した。改善前のjournalには中間receiptがないため、GETから自分の要求と推定して続行しない。修正後binaryの`update-service-verify`もこの要求（`38dc81dc-1ac5-42c1-ae78-320f405ec56e`）を拒否した。資源とupdating/requestedはそのまま保持している。

修正後の専用Cloudflare受け入れとunknown outcomeの外部回復、M6全体のlifecycle/cache/300MB受け入れは継続する。旧形式変換の追加開発は、必要になった場合だけ行う。
