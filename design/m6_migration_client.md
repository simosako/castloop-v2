# M6: 移行client・deploy開始のdurableローカルjournal

更新日: 2026-10-02

## 実装した範囲

- `MigrationAdminClient`は固定HTTPS originの認証APIでstatus/凍結prepare/一度限りbegin/明示settlementを呼び出す。redirectは拒否し、自動retryをしない。応答は明示的no-storeを要求し、bodyはstreamで65,536 bytesまでに制限し、HTTP失敗本文を診断へコピーしない。statusはstrict schemaとservice/plan/request一致を検査する。
- `castloop migration-status`だけを公開した。workspaceの`castloop.toml`/local admin keyを使うGETで、Cloudflare管理tokenは不要。Workerがbridge/candidateでなければ対応routeはなく、deployを自動実行しない。Release済みv0.1.2 binaryにはこの新しい照会は含まれない。
- `runMigrationCandidateDeployment`と`resumeMigrationCandidateSettlement`に組み合わせる実REST adapter `createMigrationRestEffects`を追加した。CLI書込command・full cutoverへはまだ接続しておらず、実Cloudflare書込も行っていない。

初回bridgeは別のdurable driver/REST adapterへ接続した（`m6_initial_bridge_client.md`）。その後のclient管理操作も下記の未公開methodとして追加したが、移行書込CLI/full cutoverはまだ提供しない。

## Bridge切替後の明示的client操作

`MigrationAdminClient`に`initializeAdmission` / `pauseAdmission` / `claimMigration` / `confirmQuiescence` / `initializeMigrationStep`と、開始前限定の`abortUnstartedMigration` / `resumeLegacyAdmission`を追加した。

- 各操作は初回bridge検査receiptを明示的に受け取り、service/account/Workerを入力時に照合する。POST前にstatus GETで同実行version/bridge UUID tag/legacy modeを確認し、activeなmigration execution tokenがあれば拒否する。receiptやstatus GETはdeployment lease/全cache scope撤去の証拠ではない。
- pause/migration ID、expected generation、timestamp、旧IO終了確認はcallerが凍結して渡す。UUIDや旧IO確認trueを自動生成せず、claim応答喪失で新IDを作ることも、自動retryで次工程へ進むこともしない。CLI用のdurable claim/申告journalはまだ接続していない。
- 入力schemaをserverと共有し、foreign service/bridge、無効ID/上限、quiescenceの別bridge versionをPOST前に拒否する。応答はstrictなresultを要求し、不明field/別result/任意診断を成功証拠へ変換しない。
- 初期化は1回につき1～100 targetの1 POSTで、戻り値は`pending`と`applying/verifying/runtime`だけ。client/server双方で`completed/finished`や付加readinessを認めず、loop/候補deploy/移行完了/受付再開を自動実行しない。
- abort/resumeは別の明示操作で、serverのplan未作成限定契約を維持する。初期化後は拒否し、legacyへの自動rollbackやM6書込再開として利用しない。

ローカル結合でpause→drained claim→明示quiescence→bounded初期化→runtime停止、開始前限定abort/resume、foreign version/tag/token拒否、pause/claim応答喪失時のPOST非再送、偽completion応答拒否を確認した。実機ゲート・unknown token/残存lock復旧・全route切替は別の残件である。

## ローカルrecord

`.castloop/migrations/<bootstrapId>.json`にstrictな凍結requestとphase/期待version/allowlisted deployment証拠だけを保存する。既存`.castloop/state.json`やservice TOMLを上書きしない。`.castloop/`は既存git-ignoreの対象である。

初期recordはexclusive createし、更新はランダムな同directory temp fileへ書込→file fsync→rename→directory fsyncする。modeはdirectory 0700/file 0600。凍結request/既存version/証拠の変更・phase後退を拒否する。本文/Worker source/metadata JSON/secret/任意exceptionは保存せず、source/metadataはhashだけを保持する。

各client invocationは`.json.lock`をexclusive createして、すべてのREST/保存Promiseが終わるまで保持する。別clientや残存lockを時間で無視しない。強制終了後のlock自動削除は提供しない。lockやjournalの保存失敗は書込を止める。

## 一度限りdeployと中断時

1. ローカルphase `prepared`とsource/metadata hashを検査する。metadataをJSON snapshotへ複製し、callerの後続変更をupload inputへ混ぜない。
2. serverでprepare後、ローカル`start_requested`をdurable保存してからbegin APIを呼ぶ。
3. 正確なbootstrap ID/開始許可を確認し、ローカル`uploading`を保存してからdeploy adapterを呼ぶ。
4. adapterの全REST書込と設定変更をawaitし、成功versionを保存して`rest_settled`へ進む。
5. 期待versionのdeployment/settingsをGET検査して証拠を保存し、`rest_requests_settled=true`/`no_more_deploys=true`と同じ証拠をserverへ送る。
6. settlement応答成功後だけローカル`settled`を保存する。

`start_requested`/`uploading`からの自動再実行は拒否する。開始応答喪失、PUTの失敗/不明応答、version不正、ローカル保存失敗を「まだPUTしていない」と推測しない。`rest_settled`からの明示再開はinspection GET/同じsettlementだけで、deployを再送しない。settlement応答喪失ならdurableな証拠を再利用できるが、旧snapshotを最終cutover/readiness証明へ昇格しない。

実adapterは全requestの終了をawaitし、裏でPUTを起動したまま成功/例外を返してはならない。別process/旧CLI/out-of-band deployの停止をこのlockやcallbackだけで証明しない。unknown outcomeの外部終了確認・旧version撤去・安全なlock/token復旧と最終readiness確定は残件である。

## 候補REST adapter

1. 対象を同account/serviceの既存workers.devに限定する。Custom DomainがあるWorker、旧preview有効、default cache有効、別version/部分配信、settings再GETでの変化をprepare前に拒否する。初回bridgeのdeployは別の未実装工程であり、legacy Workerへ直接candidateをPUTしない。
2. 認証HTTP statusでmigration owner/runtime初期化完了/空registry/未知execution不在/期待bridge versionを確認する。source/metadata hashに加え、metadataの`workers/tag`をbootstrap UUIDへ固定し、secret/追加bindingは指定bridge versionからstrict inheritする。service TOMLやlocal journalへsecretを保存しない。
3. serverの凍結prepare→一度限りbeginとローカルjournal `uploading`の後だけ、同requestの`deploying` statusを再照合する。metadata/REST bridge設定を再検査し、`PUT .../scripts/<worker>?bindings_inherit=strict`を一回awaitする。API PUTのscript IDをversion IDと誤認しない。
4. candidateの認証no-store statusから実行versionを取得し、別bridge version・bootstrap tag一致・同じ凍結request/ownerを要求する。REST deploymentで単一version 100%を照合してからworkers.dev preview無効化をPOSTし、成功応答をawaitする。その後だけdriverへversionを返す。
5. driverは`rest_settled`をdurable保存してから既存GET inspection/同settlementへ進む。PUT/preview応答喪失・候補不一致では`uploading`を保持し、inspectだけで失われたREST終了を認定したり、PUT/previewを自動再送したりしない。GET inspection失敗は`rest_settled`からGET/同settlementだけを明示再開できる。

candidateはsettlement/配信window/HTTP検査でも実行versionのbootstrap tagを要求する。タグは凍結requestとdeployを結び付ける識別子であり、sourceのremote checksum、外部全hostname/colo、旧cache全scope撤去、通常管理routes完了を証明するものではない。REST preflightはCAS/leaseではなく、out-of-band変更や別端末の停止は外部確認の責任として残る。

## 検証範囲

mock RESTとserver APIのローカル統合で凍結request、hash不一致、開始/PUT/preview/inspection/settlement応答喪失、live PUT中の別client拒否、残存lock非奪取、保存失敗、private file mode、状態照会・redirect/no-store拒否・応答上限・候補tag/version不一致・bridge設定変化を回帰した。Linux binaryのstatus helpも検査した。Cloudflare実deploy/旧IO収束/旧cache全scope/外部HTTP検証/300MB/CPU/料金の合格ではない。
