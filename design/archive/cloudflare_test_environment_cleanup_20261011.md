# Cloudflare試験環境の削除記録（2026-10-11）

記録日: 2026-10-11。v0.3.0の受け入れ完了後に実施した試験サービス一式の廃棄について、対象・確認手順・実行結果を保存します。Show／Episodeの通常削除とは別で、Worker・R2・Queue・DLQを削除しました。castloopにはサービス一式の削除コマンドはありません。

以下の環境名・削除済み／保留の状態は記録日時点のものです。新たな削除の対象一覧や実行許可ではありません。保留環境を後日廃棄する場合は、その時点の実行記録・所有者・資源の参照関係を確認してください。

**試験目的が終わり、処理の通常終了を確認できた環境は削除候補です。結果不明の要求や残留所有者がある環境は、この手順では削除しません。** 第1節は削除前の対象一覧です。候補5環境は2026-10-11に現在の状態を照合して削除済みです。実行結果は第5節に記載します。

## 1. 対象を選ぶ

### 独自ドメイン試験の削除候補

| 環境 | Worker／main Queue | R2 bucket | DLQ |
| --- | --- | --- | --- |
| run2 | `castloop-domtest-1011-r2-a42a0a3e` | `castloop-domain-20261011-run2` | `castloop-domtest-1011-r2-dlq-a42a0a3e` |
| run4 | `castloop-domtest-1011-r4-48dcc965` | `castloop-domain-20261011-run4` | `castloop-domtest-1011-r4-dlq-48dcc965` |

- run2は配信停止の不具合で試験を中断しましたが、公開／lifecycle処理は完了し、最後の確認で未完了所有者はありません。独自ドメインは追加していません。
- run4は全手順に合格し、最終paused・invocations空・未完了domain操作なしです。試験hostname `castloop-test-r4.otftalk.com`の接続とDNSは削除済みです。

### 過去のM6試験の削除候補

次のWorkerも、最後の記録では処理が通常終了し、pausedで保持されています。bucket・Queue・DLQ名は各workspaceの`castloop.toml`とWorkerのBindingsで照合してください。

- `castloop-m6-test-9c80a9b8`: 新規初期化・小さい音源の受け入れ。
- `castloop-m6-test-7c97f1a0`: 300 MB・改訂・削除の受け入れ。
- `castloop-m6-test-d5fd9895-4fe3e736`: 正式CLIの受け入れ。bucketは`castloop-m6-test-formal-d5fd9895`。

### この手順では保留する環境

| 環境／Worker | 保留理由 |
| --- | --- |
| run1: `castloop-domtest-685cd81c-7ce82b9c` | 公開要求の結果不明、local lockとShow所有者が残存 |
| run3: `castloop-domtest-1011-r3-67afcecc` | domain removeの完了receiptなし、pendingとconnection tokenが残存 |
| `castloop-m6-test-ff3bfd8c` | 旧300 MB検証の未収束owner／tokenを保持 |
| `castloop-m6-test-a3b60278` | 初期化deployのacknowledgement未確認 |
| `castloop-m6-test-49c82745`、`castloop-m6-test-9fcbd823`、`castloop-m6-test-7fefb49f` | 通常更新がrequested／updatingのまま、必要な完了receiptなし |

これらは旧IOの終了と記録保持を別途確認してから廃棄可否を判断します。時間経過、空のinvocations、DNS／接続不在、新CLIへの交換だけでは、残留要求の完了証明になりません。lockやtokenを手動で消して削除候補へ昇格しないでください。

## 2. 削除前の確認と保存

1. 対象accountとworkspaceを確認し、`castloop.toml`のservice ID・Worker・bucket・Queue・DLQを照合します。同名prefixで一括選択せず、1サービスずつ扱います。他サービスが同じ資源を参照していれば停止してください。
2. 元のLinux環境でcastloop・試験script・upload／deployが実行中でないことを確認します。新しい試験や自動deployも止めます。
3. 対応CLIで`service-status`を照会します。既にpausedならそのpause IDを保持し、別IDで停止し直しません。openなら新しいUUIDで`service-pause UUID`を実行します。
4. paused・invocations空に加え、各Showの`target-show SHOW_ID`で`unfinished_show_operation = false`を確認します。独自ドメイン試験では`domain list`の未完了local操作・url_change・設定不一致がないことも確認します。初期化／更新の未完了記録やlocal lockがあれば削除を保留します。
5. workspaceの`castloop.toml`と`.castloop/`、R2の管理記録・commit marker・status／progress、試験結果を非公開の保存先へ退避します。素材を残したい場合は公開音源・画像も保存します。管理鍵やexecution tokenを含む原本はGit／Issueへ公開しません。

run2の旧WorkerにはIssue #6が残っているため、pausedでも公開GETが200になることがあります。この環境を廃棄するためだけに再deployする必要はありません。公開503の有無だけで処理終了を判断せず、所有者・実行記録を確認します。

## 3. Dashboardで削除する

対象accountで、次の順に操作します。資源の削除・Queueメッセージの破棄・R2の空化は取り消せません。

1. **R2 → 対象bucket → Settings → Event notifications**で、対象Queueへ送る通知ruleを削除します。
2. **Queues → 対象main Queue**でconsumer接続を外します。DLQにもconsumerがあれば、対象試験専用であることを確認して外します。接続を外しても既に実行中のconsumerが終了した証明にはならないため、Workerを削除する前に第2節の実行記録・所有者を再確認し、最終管理記録を保存します。
3. **Workers & Pages → 対象Worker → Settings → Domains & Routes**で、試験専用Custom Domain／Routeが残っていれば、その接続だけ削除します。run2・run4には不要です。`otftalk.com`のZoneやNS、他用途のDNS recordは削除しません。
4. 同Workerの**Settings → Delete**からWorkerを削除します。確認画面のWorker名が第1節の対象と一致することを確認します。
5. **Queues**で対象main Queueを削除し、続いて対象DLQを削除します。残っている試験メッセージも破棄する前提です。参照が残っていて拒否された場合は、その参照先を確認し、他サービスのbindingや設定を変更しないでください。
6. **R2 → 対象bucket → Settings → Empty Bucket → Empty**で全objectを削除します。background処理ならDashboardで完了を確認します。その後、**Delete Bucket → Delete**でbucketを削除します。空にしただけではbucketは残ります。

本手順はサービス全体の廃棄なので、各Show／Episodeのlifecycle deleteや、R2の期限付きcleanup ruleを追加する必要はありません。通常運用の永久管理記録は、第2節の非公開退避先に保持します。

## 4. 削除後の確認

- 対象Worker、bucket、main Queue、DLQが一覧に残っていないことを確認します。
- 試験専用Custom Domain／Route／DNSが残っていないことを確認します。Custom Domain用証明書が残る場合は、他hostnameとの共有を確認してから別途整理します。
- 他のサービス・Zone・共有API tokenは変更しません。ローカルworkspaceと退避した管理記録、GitHubの証跡branchは保持します。

## 5. 2026-10-11の削除結果

管理者の承認により、第1節のrun2・run4・M6試験3環境を削除しました。

| 環境 | Worker | 削除したR2 object数 |
| --- | --- | ---: |
| run2 | `castloop-domtest-1011-r2-a42a0a3e` | 116 |
| run4 | `castloop-domtest-1011-r4-48dcc965` | 155 |
| 新規M6初期化 | `castloop-m6-test-9c80a9b8` | 58 |
| M6音源・改訂・削除 | `castloop-m6-test-7c97f1a0` | 85 |
| M6正式CLI | `castloop-m6-test-d5fd9895-4fe3e736` | 63 |

- 削除前にR2の全477 objectを退避し、size・ETag・SHA-256を照合しました。手元のM6 workspaceとrun2／run4のGitHub証跡も保存しました。別Linux環境のworkspace原本は取得・削除していません。
- R2のservice admission・全Show control・reservation・job statusを既存schemaで検証しました。5環境とも既存pause IDを保持したpaused状態で、invocations・Show owner・未完了service操作はありませんでした。全job statusは`published`／`completed`でした。
- 通知とmain Queue／DLQのconsumerを解除した後、R2の全objectとWorker versionが退避時から変わっていないことを再確認しました。Worker・main Queue・DLQを削除し、R2空化jobの`COMPLETED`と全object削除を確認してbucketを削除しました。
- 最終照会でWorker 5件・bucket 5件・Queue／DLQ 10件の不在を確認しました。他のWorker設定・Queue・bucketの情報、Custom Domain接続・Routeは削除前と同一です。Zone・DNS・共有API tokenは変更していません。保留環境はそのままです。
- バックアップ原本は管理者の非公開領域に保持しています。管理鍵を含むためGit／Issueへ追加しないでください。具体的な保存先は非公開の運用記録で管理します。

## 参照

- [run2結果](https://github.com/simosako/castloop-v2/blob/a584a3bd2ec02752cf6997c299695648b71eb928/design/acceptance/custom-domains/20261011/run2/result.md)／[run4結果](https://github.com/simosako/castloop-v2/blob/7e57cac5b22435c54d68d0a6edc9a28e2285ff71/design/acceptance/custom-domains/20261011-run4/run4/result.md)
- [M6新規初期化の記録](../m6_fresh_initialization.md)／[通常更新の記録](../m6_compatible_updates.md)／[M6受け入れ結果](m6_standalone_acceptance.md)
- [Cloudflare: R2 bucketの削除](https://developers.cloudflare.com/r2/buckets/delete-buckets/)／[R2通知](https://developers.cloudflare.com/r2/buckets/event-notifications/)／[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
