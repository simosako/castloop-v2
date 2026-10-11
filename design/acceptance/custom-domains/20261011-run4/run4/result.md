# run4 独自ドメイン実機受け入れ試験結果

**結果: 完了・合格。Issue #7修正を新規環境で確認。最終状態はpaused。**

## 対象

- 実施日: 2026-10-11
- commit: `da6b6ea8309a87508dc7e7d0b4b70d84bba040d8`
- CLI: `bin/castloop-linux-x64-da6b6ea`（version 0.2.1）
- SHA-256: `d65ebe33be503fa25a93ac7d07dfd4f2561e21e6430ab4f4688ba33eb5ac5b8c`
- account: 既存試験と同一。ID/Zone IDはローカル`preflight-zone.json`参照。
- Zone: `otftalk.com`、active/full
- hostname: `castloop-test-r4.otftalk.com`（試験終了時に削除済み）
- service: `domtest-1011-r4`
- Worker/Queue: `castloop-domtest-1011-r4-48dcc965`
- DLQ: `castloop-domtest-1011-r4-dlq-48dcc965`
- bucket: `castloop-domain-20261011-run4`
- workspace: `workspaces/domain-20261011-run4`
- 管理/public復帰URL: `https://castloop-domtest-1011-r4-48dcc965.simosako.workers.dev`
- 手順: 同commitの`custom_domain_live_acceptance.md`をこのディレクトリへ保存。

## 操作とversion

| 操作 | operation ID | pause ID |
| --- | --- | --- |
| init | 初期化記録参照 | fd9d865c-ae8b-4cd1-80b9-247e9d2f3938 |
| add | 38096aee-6439-4799-8ca1-6ee7060eb454 | 61bbe9ac-1738-4c45-917c-7ad774bc04e3 |
| deploy | c1c648d5-5439-4bce-af11-5fceb6718ed3 | 12bbd7a7-a3d6-4cfa-8d7b-41be6aa488b1 |
| remove | 0dac870e-2a03-4bb5-9251-c82291a0eeab | 9135d3de-cd68-435f-a23b-41a69290a6fb |
| 最終pause | — | a99ced58-4d97-4ecb-b593-5faa0ab87fe5 |

初期Worker version: `41df0f31-4968-4ac3-91f8-b73e52c9e3b8`。
deploy後: `1f30a924-1596-4278-bd81-deb75699c8d6`。add/removeでversion不変。

## 確認結果と証跡

| 項目 | 結果 | 主な証跡 |
| --- | --- | --- |
| build/check/自動テスト | 合格、937 pass / 0 fail | build-summary.md、check/bun-test/build stdout・stderr・exit-code |
| 新規hostname/resource空き、Zone条件 | 合格、読み取りAPIでDashboard代替 | preflight.json、preflight-zone.json |
| init paused/runtime readiness、resume | 合格 | init-result.json、initialized-service/domains.json、init-resume.json |
| fixture公開/lifecycle完了・before保存 | 合格 | *-completed.json、fixture-*-published.json、before-*、r2-before/ |
| 第5節: pauseと温めたcacheの503、add設定/接続/同version | 合格、Issue #6回帰なし | add-paused-*、add-continued-result.json、added-*、added-config-check.json |
| 第5節: 両host feed/cover/audio GET、audio HEAD/Range停止時503 | 合格 | added-paused-* |
| 第6節: 両host GET/HEAD/Range/ETag、RSS URLだけ変更、GUID/pubDate/site不変 | 合格、54要求 | added-public-checks.json、added-* HTTP証跡 |
| 第6節: media bytes/hash/length/type、revision/R2不変 | 合格 | before-*、r2-added/、*-current.json |
| 第6節: hidden404/gone410、draft/idle未公開、system/staging404/admin401 | 合格 | *-public-checks.json、r2-*/unpublished-check.json |
| 第6節: after-domain公開、Episode/Show非公開化・復元 | 合格、完了/所有権解放確認 | after-domain-*、keep/show-b-*-completed.json、*-unpublished*、keep-restored/show-b-restored-public-checks.json |
| 第7節: domain保持deploy/version/readiness、両host復帰 | 合格 | deploy-result.json、pre-deploy/deployed-*、deployed-public-checks.json、r2-deployed/ |
| 第8節: remove一回で完了、receipt保存、pending/token/lock解消 | 合格、Issue #7再現せず | remove-result.json、remove.exit-code、remove.stderr、remove-journal-final-check.json、removed-service/domains.json |
| 第8節: workers.dev復帰・after-domain維持・RSS URL復帰・media/revision/R2不変 | 合格、13要求 | remove-resume.json、removed-public-checks.json、removed-*-current.json、r2-removed/ |
| 第8節: 接続/DNS削除、旧hostnameは対象Workerを返さない | 合格 | removed-custom-domains.json、removed-dns-records.json、removed-runtime-probe-* |
| 最終pause/共通確認/feed503 | 合格 | final-pause-result.json、final-service/domains/domain-*.json、final-paused-feed.* |

削除journalは`completed=true`、`progress.phase=complete`。local/server progressのconnection receipt一致、pendingと正しい`.json.lock`不在を確認。admission.url_changeなし、invocations/local_operations/domainsは空。DELETEの生HTTP status/bodyは採取しておらず、どの許容応答で成功したかは断定しない。

## DNS経路・続行判断

PC/ルーターのDNSは調査・変更しない。試験process限定の127.0.0.1 CONNECT proxyで、**このhostnameだけを1.1.1.1で直接解決**。TLS終端/復号はせず、CLI/curlのhostname・証明書検証を維持した。APIと管理workers.devは通常経路。

最初のaddは明示的なDNS/TLS準備待ちとなった。`add.stderr`と`add-wait-*`を保存し、`add-dns-direct.json`でUDP/TCP A/AAAA解決、`add-runtime-probe.*`でTLS付き200・対象service/Workerを確認した後、同じoperation IDだけで続行成功。未知の変更結果の再送ではない。

1.1.1.1を使うことで、このPCの通常DNS反映待ちの影響を避けて試験を完了できた。権威DNS反映やTLS準備を常に省略できるという保証ではない。proxyは終了時に自分のPID/cmdlineを照合してSIGTERMし、active markerをdisabledへ移動（`dns-proxy-stop.json`）。

## 試験補助側の修正

- add完了後、検証scriptがservice-statusに存在しない`worker_name`を参照してKeyError。サービスはpausedを維持し、正式workers_dev_base_urlとruntime probeのWorker一致へ修正。add変更要求は再送せず検証から続行。
- Show非公開検証のfeedとnegative_checksのlabelが衝突。既存証跡を上書きせず、negative側labelを分離して読み取りから続行（`content-checks.stderr`）。製品のHTTP不一致ではない。
- `added/keep-restored/show-b-restored-*-current.json`は名前にかかわらずShow復元後に採取した照会。各時点のmetadata/revision不変は個別の`r2-added/`、`r2-keep-restored/`、`r2-show-b-restored/`でも確認している。
- 最終lock確認では実際のjournal lock名`.json.lock`と`completed=true`を追加検証（`remove-journal-final-check.json`）。

## 保持状態・未解決事項

run4は最終paused、invocations空、未完了domain操作なし。hostname接続/DNSは削除済み。Worker/bucket/Queue/DLQ、全workspaceと操作記録を保持。

run1/run2/run3には変更していない。特にrun3の未完了token・receiptなしの状態はそのまま保持し、今回のrun4成功を理由に解放していない。

今回の手順を妨げる未解決事項や管理者介入はなかった。GitHubへの追加報告・証跡pushは未実施。原本にはローカル識別情報や素材本文があるため、公開前に選別・匿名化すること。API token、`.castloop/secrets.json`は公開しない。
