# Cloudflareクリーンアップ候補（2026-10-17）

管理者の依頼による読み取り調査。以下は**調査時点**の資源と廃棄候補であり、現存資源の恒久的な一覧ではない。調査後、管理者が旧環境と試験用サブドメインの廃棄を承認した。[削除の実行記録](archive/cloudflare_test_environment_cleanup_20261017.md)を別途参照する。

## 結論

- 現存するWorkerは21、R2 bucketは19、Queue/DLQは34、SQLite DO namespaceは2。名前だけでなくWorkerのbindingとQueue producer/consumerを照合した。
- 独自ドメインは試験用3件。`otftalk.com`のWorker Routeは0件。
- 最新のSQLite試験環境`sq16r-6ec01dc6`だけを必要に応じて残し、それ以前の試験環境をサービス単位で廃棄する方針が妥当。v0.5.0の存在だけを、旧サービスが停止済み・自動移行済みという根拠にはしない。
- 未完了ownerやblocked処理のある環境は、通常の完了確認による削除とは別扱いにする。復旧やtoken解放をせず、記録を退避してサービス全体を廃棄する方針の明示が必要。
- 存続させるサービスの`system/`・`staging/`を「旧ファイル」として一括削除しない。

## 削除候補の判定

ここでの「候補」は、試験目的を終えた資源の廃棄提案。現在動いていないことや全jobの成功を保証する意味ではない。

### A. 優先して廃棄を検討できるもの

- **M0・M1・M4/5・20260924 smokeの4環境**: 古い初期検証用。現行SQLite環境からのbinding参照はない。M6式のadmission/controlが存在しないため、ownerが見つからないことだけで完了扱いにはせず、実行前に旧試験記録と書き手の停止を確認する。
- **`i13-bc656f35`**: 旧Queue方式の完了済みCPU/公開試験環境。現在のR2記録でも`open / invocations=0 / Show ownerなし / update・url_changeなし`。今後旧版との実機比較が不要なら、一式廃棄の有力候補。まだopenなので、実施前の受付停止と終了確認は必要。

この5サービスはWorker 5・bucket 5・Queue/DLQ 10。旧300MB補助Worker2件も役目は終えているが、共有bucketがあるため次のBのグループとして扱う。

### B. 未完了処理を保全したうえで、環境全体の廃棄判断が必要なもの

以下は今回のR2管理記録またはnative SQLite GETの観測値。時間経過や新リリースだけで完了へ昇格しない。

| 環境 | 現在の残留状態 | 判断 |
| --- | --- | --- |
| domain run1 | paused・invocations 0だがShow `domain-a`がreserved | 未知の公開要求を復旧せず廃棄する方針を確認 |
| domain run3 | paused・invocations 0だが`url_change`あり | 接続/DNSがなくても未完了操作の証拠を退避 |
| M6 `49c82745` / `9fcbd823` / `7fefb49f` | 3環境ともupdating・updateあり | 更新要求を再送せず、未完了更新ごと廃棄する判断 |
| M6 `a3b60278` | bucketにservice TOML 1件のみ。既往記録ではdeployのack未確認 | 作成済みWorkerが現在存在するが、既往要求の成功へ読み替えない |
| M6 `ff3bfd8c` | paused・invocations 1・Show `large`がuploading | 本体＋digest/checksum補助Worker2件＋共有bucketを一組にする |
| RSS run1 | updating・updateあり | 約3.00GB。未完了更新を含む環境廃棄候補 |
| RSS性能run2 | open・invocations 1・Showがprocessing、executionあり | 処理中tokenを強制返却しない |
| RSS性能run3 | open・invocations 1・Showがuploading | 約1.90GB。途中upload/試験の証跡を退避 |
| `i13-a1a3a6d3` | open・invocations 1・Showがreserved | 約2.73GB。旧要求を再送せず廃棄判断 |
| `i13-d46cf12e` | open・invocations 1・Showがprocessing、executionあり | status照会停止後の残留所有権を保全 |
| SQLite初回`sq16-668cbdfa` | open・active blocked・drained false | R2に加えDO永続データ/Alarmも含む廃棄判断 |

残留invocationは現在CPUを消費するprocessが動き続けている証明ではなく、逆に「古いtokenだから安全に無視できる」という証明でもない。通常完了と強制的な環境廃棄を区別する。

### C. 必要なら1環境だけ保持

**`sq16r-6ec01dc6`**は最新の受け入れ・36件再試験が完了したSQLite環境。現在もready/paused/drainedで、約35.48MBと小さい。直後の比較・再現用に保持する第一候補。ただし、今後再利用しない方針ならこれも一式廃棄でき、永続保持を必須とはしない。

## R2の現存容量

REST一覧をcursor終端まで取得。観測集計の完了時刻は**2026-10-17 07:02:38 UTC（16:02:38 JST）**。一覧取得は複数要求からなるため、全bucket同時点の原子的snapshotではない。

合計 **5,253 objects / 11,108,470,104 bytes（約11.11GB、10.35GiB）**。
最新SQLite環境だけを残す場合、廃棄候補は **4,795 objects / 11,072,988,266 bytes（約11.07GB）**。

| bucket | objects | bytes |
| --- | ---: | ---: |
| `castloop-domain-20261010-685cd81c` | 74 | 9,185,709 |
| `castloop-domain-20261011-run3` | 155 | 16,450,302 |
| `castloop-m0-e87da5b3ca` | 256 | 40,920 |
| `castloop-m1-400ccc55` | 100 | 955,730 |
| `castloop-m45-40a9bf` | 17 | 103,843 |
| `castloop-m6-test-49c82745` | 39 | 56,782 |
| `castloop-m6-test-7fefb49f` | 39 | 56,782 |
| `castloop-m6-test-9fcbd823` | 39 | 56,782 |
| `castloop-m6-test-a3b60278` | 1 | 342 |
| `castloop-m6-test-ff3bfd8c` | 96 | 300,075,941 |
| `castloop-rss-20261012-run1` | 750 | 2,997,297,058 |
| `castloop-rss-perf-20261012-r2` | 18 | 2,180,754 |
| `castloop-rss-perf-20261012-r3` | 481 | 1,899,792,963 |
| `castloop-smoke-20260924` | 17 | 346,885 |
| `castloop-sq16-668cbdfa` | 108 | 15,231,712 |
| `castloop-sq16r-6ec01dc6` | 458 | 35,481,838 |
| `castloop-test-i13-a1a3a6d3` | 768 | 2,731,675,332 |
| `castloop-test-i13-bc656f35` | 1,764 | 3,093,736,285 |
| `castloop-test-i13-d46cf12e` | 73 | 5,744,144 |

| prefix | objects | bytes | 扱い |
| --- | ---: | ---: | --- |
| `public/` | 906 | 5,368,486,885 | 公開音源・metadata等。試験サービス廃棄時に対象 |
| `staging/` | 989 | 5,738,319,732 | 大容量整理の主対象だが、未完了draftを含む。存続サービスで一括削除しない |
| `system/` | 3,168 | 1,625,091 | 小さい管理記録。未完了原因や所有権を含むため退避優先 |
| `m0/` | 190 | 38,396 | 初期検証専用 |

## Workerとbucketの対応

各行は現在のbindingによる対応。Queue方式の17サービスにはmain QueueとDLQが各1個あり、mainの名前はWorkerと同じ。補助Worker2個には独立したbucket/Queueがない。

| 区分 | Worker | R2 bucket |
| --- | --- | --- |
| 初期試験 | `castloop-m0-e87da5b3ca` | `castloop-m0-e87da5b3ca` |
| 初期試験 | `castloop-m1-smoke-44d9fca6` | `castloop-m1-400ccc55` |
| 初期試験 | `castloop-m45-40a9bf-2e2e241f` | `castloop-m45-40a9bf` |
| 初期試験 | `castloop-smoke-20260924-2afc5f48` | `castloop-smoke-20260924` |
| 未完了初期化 | `castloop-m6-test-a3b60278` | `castloop-m6-test-a3b60278` |
| 未完了更新 | `castloop-m6-test-49c82745` | `castloop-m6-test-49c82745` |
| 未完了更新 | `castloop-m6-test-9fcbd823` | `castloop-m6-test-9fcbd823` |
| 未完了更新 | `castloop-m6-test-7fefb49f` | `castloop-m6-test-7fefb49f` |
| 旧300MB試験 | `castloop-m6-test-ff3bfd8c` | `castloop-m6-test-ff3bfd8c` |
| 300MB補助 | `castloop-m6-test-digest-e975e1b4` | 上記`ff3bfd8c`と共有 |
| 300MB補助 | `castloop-m6-test-checksum-913cb489` | 上記`ff3bfd8c`と共有 |
| domain run1 | `castloop-domtest-685cd81c-7ce82b9c` | `castloop-domain-20261010-685cd81c` |
| domain run3 | `castloop-domtest-1011-r3-67afcecc` | `castloop-domain-20261011-run3` |
| RSS run1 | `castloop-rsstest-1012-r1-acb1fbca` | `castloop-rss-20261012-run1` |
| RSS性能run2 | `castloop-rssperf-1012-r2-0f9dbe46` | `castloop-rss-perf-20261012-r2` |
| RSS性能run3 | `castloop-rssperf-1012-r3-78d71785` | `castloop-rss-perf-20261012-r3` |
| Issue #13旧試験 | `castloop-i13-a1a3a6d3-cd201a50` | `castloop-test-i13-a1a3a6d3` |
| Issue #13完了環境 | `castloop-i13-bc656f35-466ebe5f` | `castloop-test-i13-bc656f35` |
| Issue #13旧比較 | `castloop-i13-d46cf12e-ad22b0c3` | `castloop-test-i13-d46cf12e` |
| SQLite初回・blocked | `castloop-sq16-668cbdfa-f7da9954` | `castloop-sq16-668cbdfa` |
| SQLite最新・保持候補 | `castloop-sq16r-6ec01dc6-f65ca2ec` | `castloop-sq16r-6ec01dc6` |

`ff3bfd8c`以外に、複数の現存Workerが同じbucketをbindingする例は今回の一覧にはなかった。アカウント外の利用者や外部配信依存がないことまで証明するものではない。

## 独自ドメインとDNS

次の3件は現在もCustom Domain接続がenabledであり、対応するCloudflare管理のAAAA recordがある。すべて旧RSS試験環境に対応するため、当該サービス廃棄時の削除候補。

| hostname | 接続先 |
| --- | --- |
| `castloop-rss-r1.otftalk.com` | RSS run1 |
| `castloop-rss-perf-r2.otftalk.com` | RSS性能run2 |
| `castloop-rss-perf-r3.otftalk.com` | RSS性能run3 |

- DNSの3 recordはいずれも`origin_worker_id`付き・`read_only=true`。通常DNS recordだけを直接消すのではなく、Custom Domain接続から整理してDNSの不在を検証する。
- 過去のdomain試験用hostnameは現在のCustom Domain/DNS一覧にはない。ただし、これはrun1/run3の未完了操作が完了した証拠ではない。
- **保持対象**: `otftalk.com` Zoneとapex A、`www` CNAME、Google確認用CNAME、MX 3件、SPF/DKIM TXT。これら8 DNS recordは試験用3件と切り離す。
- 証明書一覧APIはMCP・既存のローカルtokenとも403で未確認。権限の変更は行っていない。公式文書ではCustom Domain削除時に関連Advanced Certificateは自動削除されないため、以前に接続を削除したhostnameも含め、Dashboardで証明書の残骸と共有hostnameを別途確認する。

## SQLiteの現在値

既存workspaceの鍵を外部出力せず、管理GETだけで照会した。

| 項目 | 初回`sq16-668cbdfa` | 最新`sq16r-6ec01dc6` |
| --- | --- | --- |
| Worker version | `ab97ab6b-776e-4ed5-9cb7-6ce7678e1760` | `8ace6fc5-aa21-49f5-ac88-f9d3c50ef82e` |
| state | open | paused |
| publication ready | true | true |
| active | blocked | null |
| queued | 0 | 0 |
| drained | false | true |
| namespace | `d22285ad685b4504830949500a5ac9fb` | `ea16615b38a94698805758bf18bb0458` |

両namespaceとも永続データを持つDOが一覧に存在する。最新はsetup ready・runtime update completedも確認した。R2だけ消してもSQLite制御記録は片付かないため、SQLite環境を廃棄する場合はDO namespace・Alarm・永続データも対象に含め、方法と不可逆性を実行前に確認する。今回は削除用Workerへの交換やDOの削除処理を実装・実行していない。

## 調査範囲・証跡

- Cloudflare REST/MCPのGET、R2 object一覧と小さい管理記録のGET、既存ローカルworkspaceと試験文書の読み取り。
- R2の音源・画像本文を一括ダウンロードしていない。object一覧のsizeは論理容量であり、請求額やDO容量ではない。
- R2のservice admissionとShow controlは取得できたものをallowlist集計したが、全job status/progress・全local journalをschema検証して正常終了を認定した調査ではない。最初の全status読取を含む集計はローカル120秒制限で中断したため、最終集計はobject一覧・admission・Show controlに範囲を絞った。途中にもCloudflare変更はない。
- この実行環境のprocess一覧では、過去のcastloop試験runner/upload/deploy processは見つからなかった。別ホスト・CI・Cloudflare側の全IO終了までは証明しない。
- 非公開の今回の調査結果は`/tmp/opencode/castloop-cleanup-audit-20261017/`。inventoryはkey/size/ETag等とallowlist集計であり、完全な復旧backupではない。既存の`.local-test-data/`、過去の退避先、journal、原素材は削除していない。
- [2026-10-11の削除記録](archive/cloudflare_test_environment_cleanup_20261011.md)の削除済み5環境は今回の現存一覧にない。保留だった7環境は現在もある。

## 推奨する廃棄の単位と順序

最新SQLite環境を1つ残す場合、整理の最大候補は**Worker 20・bucket 18・Queue/DLQ 34・DO namespace 1・Custom Domain 3**。未完了環境を含むため、この数をそのまま安全に削除できる確定数とはしない。最新環境も今後使わないなら廃棄対象にできるが、動作比較用に必須と決まっているわけでもない。

実施の承認では、対象名・未完了処理の廃棄可否・素材と記録の保存範囲を確定する。その後、サービスごとに次の順序を具体化する。

1. 実行中のローカル/別ホスト/CIのupload・deploy・試験を止め、新規受付と再起動を防止する。必要な設定・journal・管理記録を非公開退避する。
2. Queue方式ではR2通知、Queue/DLQ consumer、外部producerを整理する。未完了ownerのtokenを消して「正常終了」に見せない。
3. 試験用Custom Domain接続を削除し、対応DNSと証明書の残留を確認する。他用途のDNSや共有証明書を削除しない。
4. 旧書き込みの終了/遮断を確認し、Worker・専用Queue/DLQを廃棄する。SQLiteはDOデータ/Alarmの扱いを確認してから行う。失敗/未知応答なら削除要求を無条件に再送しない。
5. **書き手を残したままbucketを空にしない。** 対象bucketのpayloadと管理記録を、承認した退避方針に従って削除し、空化完了とbucket不在を照合する。
6. 他環境に変更がないことと、対象のWorker/bucket/Queue/DO/Domain/DNSの不在を最終確認する。

これは通常のShow/Episode削除やv0.5.0へのmigrationではなく、試験サービス全体の廃棄。旧サービスを新CLIに差し替えたり、検証試験を再開したりする必要はない。

### 公式資料

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Durable Object storageの削除](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#remove-a-durable-objects-storage)
- [Durable Object classの削除](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class)
