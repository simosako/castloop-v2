# SQLite Worker更新の検証続行

Issue [#11](https://github.com/simosako/castloop-v2/issues/11)の最新コメントと、
[#33の棚卸し](https://github.com/simosako/castloop-v2/issues/33)で確認した現行SQLite経路を対象とする未リリースの修正。
元のQueue/R2障害のGET timeout原因を確定・再現したという意味ではない。

## 問題と範囲

v0.5.1のSQLite更新は、Worker script PUT成功後のdeployments GETまで完了して初めてreceiptを保存していた。
このGETが失敗すると`deploy_requested`/receiptなしで止まり、PUT応答不明と区別できなかった。
配備receipt保存後のsettings GET失敗では`deployed`に止まるが、既存の明示続行は`verified`しか受け付けなかった。
どちらも準備済みDOのmaintenance/readiness gateを保持する安全な停止だが、既知の配備から読取検証を続ける入口がなかった。

修正対象は同一config/schema/namespaceのcode-only更新と、その正式CLI `update-service-verify`。
fresh init、旧Queue更新、公開jobのretry/release、未知prepare/PUT/activationの復旧には広げない。
自動配備や既存journalの編集・昇格は行わない。

## PUT成功を読み取りから分離する

新規SQLite更新journalはローカルformat `schema_version=2`とする。
これはservice TOMLのschema version 2や、旧Queue更新journalのversion 2とは独立した形式番号。

Cloudflareの[script PUT](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)はscript contentのETagを返す。
ここでversion/deployment UUIDが返ると仮定せず、成功応答を全量検証・cleanupした後、GETを始める前に
`upload_receipt.script_etag`と`deploy_acknowledged`を既存のfsync/atomic replaceで保存する。
応答喪失・不正本文・checkpoint保存失敗では先へ進まず、GETに見える現在値だけから成功へ昇格しない。

ETagは同じcodeの別配備を一意に表すUUIDではない。そのため新規更新で送信するsourceの末尾に
`// castloop SQLite update operation: UPDATE_UUID`という動作を変えないコメントを付ける。
operation IDは凍結済みのUUIDであり、入力値や秘密情報は含めない。
`worker_source_sha256`はこのコメントを含む**実際の送信source**のhash。
同じCLIの組み込みcodeを再度更新する場合も別operationのsource/ETagと混同しないための識別子であり、CASや外部操作のロックではない。
config・metadataの内容/hash、Workerの公開動作・DO schemaは変更しない。source本文や秘密鍵をjournalへ保存しない。

## 続行できるphase

| phase | 保存済み証拠 | `update-service-verify` |
| --- | --- | --- |
| `prepared`/`prepare_requested`/`maintenance` | 配備成功は未確認 | 拒否 |
| `deploy_requested` | PUTの成功が永続保存されていない | 拒否。現在値から採用しない |
| `deploy_acknowledged` | PUT成功のETag（format 2のみ） | GETで対応する配備を特定し、検証を続行 |
| `deployed` | version/deployment IDとETag | 同じreceiptを再検証 |
| `verified` | REST照合済みreceipt | 同じreceiptとnative runtimeを再検証 |
| `activation_requested`/`ready` | activation要求開始済み | 拒否。完了済みならread-only reconcileのみ |

format 2では`deploy_acknowledged`以降にupload receiptを必須とし、`deployed`以降の配備receiptのETagと一致させる。
旧versionや旧deployment IDを新receiptとして受け付けず、phaseと証拠が矛盾したjournalは解析時に拒否する。

続行は次の順で実行する。

1. 既存の排他journal lockを取得し、operation/service ID、凍結source/config/metadata hashを確認する。不一致は通信前に拒否する。
2. `deploy_acknowledged`では単一100%配備をGETし、そのversionのID/ETagをPUT成功応答へ照合して、旧runtimeと異なるreceiptを保存する。
3. 固定したreceiptについて既存のREST inspectionを行う。配備前後の安定性、settings、version、binding/cache、DO namespaceの所属と元namespace、workers.dev/preview設定を省略しない。
4. `verified`を保存し、サーバー側の正確なprepared要求、旧version/new version、paused/drainedを照合する。旧native versionだけは既存の有限GET待機を許し、新versionへ到達するまでactivationしない。
5. RESTをもう一度照合し、**送信前に**`activation_requested`を保存して、初回activation/probeだけを送る。新versionのAlarm/R2/cache/purge成功・setup完了を確認し、pausedで終える。

ここまでの読取が再び失敗しても、PUT/準備/activationを再送せずcheckpointを保持する。
通常の`deploy`再実行は開始済み更新を続行しない。明示の`update-service-verify`を必要とする。
Cloudflare REST GETの自動retry追加やtimeout延長はこの修正に含めない。
activation開始後は、応答がなくても旧deploymentが見えても`verify`で再送しない。
`update-service-reconcile`は既に完了した正確なsetupをGETで確認する機能のまま。

## 旧journalの扱い

- format番号のない旧SQLite `deployed`/`verified`は、元のsource hash、metadata hash、既知receiptを保ったまま検証できる。sourceコメントを後付けしたりformat 2へ書き換えたりしない。
- 旧SQLite `deploy_requested`にはPUT成功の証拠がない。後のGETや経過時間で`deploy_acknowledged`へ昇格しない。
- 元の#11のQueue/R2 upload-only journalは、activation未開始と応答不明を区別できない。既存のQueue対策でも本修正でも復旧対象外。
- 残存client lock、未知IO、owner/generation、blocked probeを強制解除しない。現在値のGETは過去のすべてのIOの終了証明ではない。

## ローカル検証と限界

`packages/cli/src/sqlite-update-recovery.test.ts`は、外部fetchを使わない既存の模擬Cloudflare/SQLite fixtureで次を確認する。

- 修正前にdeployments/settings GET停止後の正式verifyが拒否された2経路。
- PUT成功checkpointが最初のGETより前に読めること、deployments/version/settings GET失敗後の正式commandによる続行、繰り返す検証失敗の保持。
- 続行時の変更要求が初回activation POSTだけであり、PUT、準備、R2 uploadを繰り返さないこと。
- 同じ組み込みcodeの複数更新のsource hash/ETag分離、変更入力・ETag/version/配備/namespace/settings/maintenance不一致、inspection中の配備変化の拒否。
- PUT応答のtransport/本文喪失、activation受付前後の中断で再送しないこと。完了したactivationだけをGET-only reconcileできること。
- 旧SQLite `deployed`の無変換続行、旧receipt-free journalの拒否、format/phase/receipt不整合の拒否。

既存の互換更新・初期化・コンテンツ保持・readinessテストも維持する。
fixtureのETagは送信sourceのhashとして模擬する。実Cloudflareの応答形、ETag処理、native rollout/Alarm/output gateをこの試験だけで実証したとは扱わない。
実環境の配備・resume・公開・資源変更、旧環境の再構築や元journalの復旧は行っていない。
