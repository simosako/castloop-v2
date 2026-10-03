# M6: 保存形式を変えない通常更新

更新日: 2026-10-03

## 範囲

M6稼働済みサービスのWorkerだけを更新する内部経路を追加した。Show/Episodeのschema変換、音源・revision・公開snapshotのinventory、legacy bridgeは実行しない。新規初期化・通常更新・必要時の旧形式変換を独立した責務として扱う。

通常更新で使うコードはM6保存形式を維持する検証済みbuildに限定する。source hashから任意のコードの保存形式互換性を自動証明する仕組みではない。Custom Domain/route変更はこの経路へ含めず、旧版の汎用変換frameworkも作らない。

## 最小の安全な経路

1. 明示pause後にdraining consumer/recoveryを完了する。新規管理操作は既存のservice境界で拒否される。
2. 凍結要求のpause ID・service generation・旧Worker version・config hashを照合する。live service token、unfinished Show owner（uploading/reserved/processing）、未完了Show登録があれば更新しない。
3. Showの小さいcontrol recordだけを検査し、service ETagへのCASで`updating`を獲得する。このCASにより、検査中に起きたconsumer/token変更も拒否する。以降は管理/consumer/recovery/通常配信を閉じる。
4. durable journalの`deploy_requested`を保存してから、一度だけWorkerをPUTする。秘密値は既存の特定versionからinheritし、compatibility dateや既存のtags等を保持する。
5. PUT応答のscript ETagと対象versionのscript ETagを照合する。最新versionを見つけたことだけで自分のuploadとは扱わない。REST検査とは別にruntimeの配信・管理・consumerを検証する。
6. new targetをserver admissionへ固定し、検証前後のdeployment/settings/configを照合してreadinessをCAS更新する。完了はpausedのまま。再開は別の明示操作とする。

admissionの旧`readiness`（legacy移行監査）は変更せず、新versionの稼働判定は`runtime_readiness`へ置く。停止/削除等の通常content制御も変更しない。requestは`system/service-updates/<operationId>/request.json`へ保持し、操作IDを別内容で再利用しない。

## 責務の共通化

- `src/m6-runtime-readiness.ts`: 初期化/更新共通のconfig・version・REST snapshot・runtime receipt検証。状態遷移は持たない。
- `src/m6-service-update.ts`: paused→updating→pausedの更新固有CASと未完了owner確認。初期化やlegacy変換は呼ばない。
- `packages/cli/src/m6-service-update.ts`: begin/deploy/completeの要求前journal保存と非再送。一つの巨大な汎用状態機械へ統合しない。
- journalのファイル保存/lockとWorker payload hashは既存機能と共有する。
- `packages/cli/src/m6-update-rest.ts`: server owner確認と実REST uploadを結ぶ。資源作成やpayload書込はしない。

## 失敗と制約

時間/HEAD不在だけでtokenやShow ownerを解放しない。PUTやHTTP応答喪失ではrequestedを保持し、再送・旧readinessへのrollback・自動resumeは行わない。server上の同一targetに対する読み取り専用再検証と、clientによる不明な書込要求の再送は区別する。

現段階のShow-control検査は一回100件のbounded listであり、truncatedなら配備前に拒否する。runtime budgetを超える大規模サービスの更新手順は未対応で、この上限をサービス全体の公開仕様として決定したものではない。実機のruntime制約に適合することも公開前の受け入れ対象である。

service境界は、このprotocolを無視した第三者のCloudflare deployを禁止できない。メンテナンス中は別deployを行わない運用を前提とし、REST snapshotやupload ETagの不一致では閉じた状態を保持する。任意の将来の非互換コードや外部deployerを安全にrollbackする一般機構ではない。

## 検証と残件

content/Show control/公開音源/revision/staging/job記録の非変更、live owner拒否、遅いconsumerとのCAS競合、別update競合、targetの固定、旧監査証拠保持、journal/要求喪失、RESTの入力凍結/secret inherit/ETag照合を自動テストした。共通runtime検証の異常系は既存初期化テストを利用し、同じ安全条件の重複テストを増やしていない。

これは内部実装であり、通常`deploy`や公開CLI/HTTP入口には未接続である。新規初期化と同様、実runtime検証adapter・専用Cloudflare受け入れ・unknown outcomeの外部回復は残る。M6 ready=falseと公開書込gateを維持し、実機合格/正式リリースとは区別する。旧形式変換の追加開発は、必要になった場合だけ行う。
