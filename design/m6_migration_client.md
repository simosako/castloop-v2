# M6: 移行client・deploy開始のdurableローカルjournal

更新日: 2026-10-01

## 実装した範囲

- `MigrationAdminClient`は固定HTTPS originの認証APIでstatus/凍結prepare/一度限りbegin/明示settlementを呼び出す。redirectは拒否し、自動retryをしない。応答bodyはstreamで65,536 bytesまでに制限し、HTTP失敗本文を診断へコピーしない。statusはstrict schemaとservice/plan/request一致を検査する。
- `castloop migration-status`だけを公開した。workspaceの`castloop.toml`/local admin keyを使うGETで、Cloudflare管理tokenは不要。Workerがbridge/candidateでなければ対応routeはなく、deployを自動実行しない。Release済みv0.1.2 binaryにはこの新しい照会は含まれない。
- `runMigrationCandidateDeployment`と`resumeMigrationCandidateSettlement`は未公開のclient helperで、実Cloudflare deploy adapter/CLI書込commandへはまだ接続していない。

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

## 検証範囲

mock RESTとserver APIのローカル統合で凍結request、hash不一致、開始/PUT/inspection/settlement応答喪失、live PUT中の別client拒否、残存lock非奪取、保存失敗、private file mode、状態照会・redirect拒否・応答上限を回帰した。Linux binaryのstatus helpも検査した。Cloudflare実deploy/旧IO収束/旧cache全scope/外部HTTP検証/300MB/CPU/料金の合格ではない。
