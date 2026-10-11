# 修正版独自ドメイン受け入れ試験 run3（2026-10-11）

## 最新結果：第5〜7節合格、第8節の切断応答処理で停止

今回、通常PC resolverとCloudflare公開DNSの反映状況の差は、1.1.1.1を明示して対象hostnameを解決することで回避できた。
OS/ルーターのDNS設定変更なしでdomain addを続行し、第5〜7節を完了した。
公開DNSでの解決とTLS準備を先に確認したうえでの今回の結果であり、権威DNSやTLS準備の待機を常に省略できる保証ではない。
残る未完了範囲はdomain removeの完了、resume後のworkers.dev復帰配信、最終停止状態の共通確認。

管理者は通常DNSの調査を終了し、対象hostnameに1.1.1.1を明示した試験継続を承認。
OS DNS/CLI binaryは変更せず、試験プロセスのHTTPS_PROXYによる127.0.0.1限定CONNECT tunnelを使用した。
対象hostnameのみ1.1.1.1:53で解決し、TLSを終端せずCLI/curlの証明書・hostname検証を維持した。
Cloudflare API/Workers管理hostはNO_PROXYで通常経路。通常DNSでの解決成功を主張するものではない。

### 変更操作

| 操作 | operation ID | pause ID | Worker version |
| --- | --- | --- | --- |
| init | f2498204-dd97-46e8-aa04-074b83c89a9b | 同左 | cab7bbf2-2637-4f42-b8d8-47ac4bc409d8 |
| add | 4f20fdfe-4cf6-4345-a051-f1dfe23a565b | fe5b60f3-f21b-472a-a7a0-69445f251280 | 初期versionのまま |
| deploy | 652997c0-de6a-45be-9b5f-63f14058916f | d736a92e-64ad-4db9-96d1-352bf137f51a | 64017114-44a5-46aa-893d-bc0d7bb3f684 |
| remove（未完了） | 9dd5b0ac-ab4d-41ad-ad15-dfe785e4b21f | e69d8d23-baa2-49bf-9521-cb0d5cfcc829 | deploy後versionのまま |

### 項目別結果

| 節・確認 | 結果 | 主な証跡 |
| --- | --- | --- |
| 第5節 add結果・同operation・接続1件・両URL・version不変 | 合格 | add-explicit-dns-result.json, added-domains.json, added-service.json |
| 第5節 共通停止確認・両host両Show feed/cover/audio503・明示resume | 合格 | added-{service,domains,domain-a,domain-b,domain-idle}.json, added-paused-*.{headers,status}, add-resume.json |
| 第6節 feed/cover/audio GET/HEAD200、両hostRSS一致、media before一致 | 合格 | added-public-checks.json, added-*.{headers,body,status} |
| 第6節 音源length/type、Range206/1024bytes/Content-Range/先頭一致 | 合格 | added-public-checks.json, added-*-audio-range.* |
| 第6節 feed/cover/audio ETag304、旧feed ETagへ200 | 合格 | added-*-304.*, added-worker-*-old-feed-etag.* |
| 第6節 RSS URLのみdomain化、GUID/pubDate/site_url維持 | 合格 | added-public-checks.json, added-*-feed.body |
| 第6節 hidden404/gone410とGUID除外、idle404/draft非露出 | 合格 | added-public-checks.json, r2-added/unpublished-check.json |
| 第6節 system/staging404、鍵なしadmin401 | 合格 | added-public-checks.json, added-*-denied.*, added-*-admin-no-key.* |
| 第6節 current_revision・R2 keys/TOML不変 | 合格 | added-domain-{a,b}-revision.json, r2-added/ |
| 第6節 after-domain公開・新規音源/RSS canonical domain | 合格 | after-domain-published.json, publish-domain-a-after-domain-completed.json, keep-restored-public-checks.json |
| 第6節 keep unpublish/restore、404→同GUID/revision/mediaで200 | 合格 | keep-unpublish-completed.json, keep-unpublished-*.status, keep-restore-completed.json, keep-restored-target.json, keep-restored-public-checks.json |
| 第6節 Show domain-b unpublish/restore、両host全media404→200 | 合格 | show-b-{unpublish,restore}-completed.json, show-b-unpublished-*.status, show-b-restored-public-checks.json |
| 第6節 各変更後hidden/gone/draft不変、lifecycle完了条件 | 合格 | *-invariants-*.{body,status}, *-completed.json |
| 第7節 共通確認・domain保持deploy・version更新/readiness一致・両URL/接続維持 | 合格 | pre-deploy-*.json, deploy-result.json, deployed-{service,domains,domain-a,domain-b,domain-idle}.json |
| 第7節 resume後両host GET200、RSS/media/revision/R2確認 | 合格 | deployed-public-checks.json, deployed-domain-{a,b}-revision.json, r2-deployed/ |
| 第8節 remove前共通確認 | 合格 | remove-paused-*.json |
| 第8節 domain remove結果domain-changed-paused | **失敗：応答処理例外** | remove.stderr, remove-failure-domains.json |
| 第8節 停止中workers feed503（診断） | 確認済み | remove-failed-paused-feed.* |
| 第8節 Custom Domain/DNS不在（API診断、Dashboard未実施） | 観測済み。要求IO終了とは判定しない | remove-observed-custom-domains.json, remove-observed-dns-records.json |
| 第8節 remove完了・resume・workers復帰配信・最終pause完了 | 未実施 | — |

### 第8節停止理由と保持状態

`Domain operation ...: null is not an object (evaluating 'data.success')`。
`packages/cli/src/cloudflare-api.ts:77-82`の共通json()はnull検査なしでdata.successへアクセスし、removeWorkerDomain(:301-309)もこの経路を使う。
実機DELETEの生応答/statusは未保存のため、実際のHTTPやCloudflare側応答仕様を断定しない。CLIにreason_codeフィールドはない。

最終状態はpaused、invocations=[]、connection execution/pendingとurl_change残存、local phase=configured、lock_present=false。
public_base_urlはworkers.dev、domains=[]、configuration_matches/connections_match=true。ただしこれだけで切断IOの終了や操作完了を判断せず、再送/強制解放/resumeは行っていない。
Worker/bucket/Queue/DLQ、3環境のworkspace/.castloopと記録を保持。r2-remove-failureでもkeepのmetadata/revisions不変を確認した。
証跡: remove-final-service.json、remove-final-domains.json、run-state-summary.json、remove.stderr。

試験用proxyは終了し、active markerはdns-proxy-disabledへ移動。OS/routerのDNS設定は変更なし。
dns-proxy-connections.jsonlはresolver/IP情報のみで、header/bodyや復号TLSを含まない。
今後は切断応答処理と残留connection tokenの復旧判断が必要。未知要求の再送や自動強制解放は禁止。

以下はDNS待機時までの経過記録。上記が最新状態。

## DNS追加診断（17:16 JST）

管理者報告では別VPSの通常DNSで解決成功。本PCから1.1.1.1:53へ直接問い合わせたUDP/TCPのA/AAAA全4照会も成功。
A=104.21.19.82/172.67.185.171、AAAA=2606:4700:3033::ac43:b9ab/2606:4700:3035::6815:1352、TTL=300。
同時の本PC通常resolvectl queryはName not found。公開DNSの反映と本PC通常resolverの結果に差がある。
negative cacheやupstream等を疑うが未確定。システムDNS設定/サービス状態の変更はなし。
証跡: dns-direct-1111.json、dns-local-recheck.txt。再現補助: diagnostics/dns-direct.py（ローカル作業ルート配下）。

## 対象

- commit: 20a92f49ec283f5edc3ec5af3e8d27725928bfe0（feature/custom-domains最新、試験開始時）
- 手順: acceptance-procedure.md（更新日2026-10-11）
- binary SHA-256: c381f8adf09b7348ddd1e178e01b6d9967168b0e32f767c2d758d6b2af25fa5b（binary.sha256、build-binary.sha256）
- account/Zone: otftalk.com、IDはpreflight-zone.jsonに保持
- hostname: castloop-test.otftalk.com
- service: domtest-1011-r3
- bucket: castloop-domain-20261011-run3
- Worker/Queue: castloop-domtest-1011-r3-67afcecc
- DLQ: castloop-domtest-1011-r3-dlq-67afcecc
- init operation/pause ID: f2498204-dd97-46e8-aa04-074b83c89a9b
- Worker version: cab7bbf2-2637-4f42-b8d8-47ac4bc409d8
- add pause ID: fe5b60f3-f21b-472a-a7a0-69445f251280
- add operation ID: 4f20fdfe-4cf6-4345-a051-f1dfe23a565b
- deploy/remove操作ID: 未作成

## 結果

| 項目 | 結果 | 証跡 |
| --- | --- | --- |
| ビルド・配置hash一致、型検査・自動テスト | 合格、933 pass / 0 fail | build.txt, binary.sha256, typecheck.txt, unit-tests.txt, source-status.txt |
| 第1節 Zone/hostname/resource空き確認 | APIで合格、Dashboard目視未実施 | preflight.json, preflight-zone.json |
| 第2節 init・paused/readiness・resume | 合格 | init-result.json, initialized-service.json, initialized-domains.json, init-resume.json |
| 第3節 fixtures公開/非公開化/削除の完了条件 | 合格 | publish-*-completed.json, hidden-completed.json, gone-completed.json |
| 第4節 before RSS/media保存・音源hash/length一致 | 合格 | before-service.json, before-domain-{a,b}.json, before-domain-{a,b}-{feed,cover,audio}.* |
| 第4節 R2 keys/metadata/revisions保存 | API GET代替で確認、Dashboard未実施 | r2-before/ |
| 第5節 add前共通確認 | 合格 | add-paused-{service,domains,domain-a,domain-b,domain-idle}.json |
| 第5節 停止中feed/cover/audio GET | 両Showとも503、Issue #6の再確認合格 | add-paused-domain-{a,b}-{feed,cover,audio}.* |
| 停止中音源HEAD/Range（追加回帰確認） | 両Showとも503 | add-paused-domain-{a,b}-audio-{head,range}.* |
| 第5節 domain add | 接続作成済みだがDNS/TLS確認で未完了 | add-stderr.txt, add-failure-domains.json |
| 第5節 add後の設定/版/両host配信・resume | 未実施（未完了のため） | — |
| 第6節 両host配信・lifecycleの全項目 | 未実施 | — |
| 第7節 domain保持deployの全項目 | 未実施 | — |
| 第8節 domain remove・復帰・最終完了確認 | 未実施 | — |

## DNS/TLS待機と停止理由

初回domain addは `Domain DNS/TLS is not verified; keep the service paused and retry the same operation after it is ready`。
通常curlのruntime probeは名前解決できず、15秒間隔20回の読み取りでも同じ（add-tls-wait-*.stderr）。
Cloudflare APIではproxied AAAA recordが作成され、Cloudflare DoHではAレコードが解決できた（add-dns-records.json、add-doh-cloudflare.json）。
local resolvectlの通常/非cache queryはName not found（add-local-dns-no-cache.txt）。local DNS経路に問題がある可能性があるが、cacheだけが原因と断定しない。

認証なし、証明書検査有効、redirect追跡なしのcurl DoH runtime probeは200となり、nonce/service IDが一致した（add-doh-runtime-probe.*、add-doh-probe-nonce.txt）。
これは通常DNS経路の合格扱いにはしない。
DNS/TLS準備の証拠取得後、手順の待機例外に従い同hostname/operation IDで1回続行を試みたが、CLIは同じ未検証エラーで拒否（add-after-tls-ready.stderr）。
以後は自動retry・強制解放・resumeなしで停止した。CLI stderrにreason_codeフィールドはない。

## 最終状態と保持

final-service.json / final-domains.json: paused、invocations=[]、url_change保持。
Custom Domain接続1件、public_base_urlはまだworkers.dev、connections_match=falseは途中状態。
local操作はphase=feeds、lock_present=false。追加成功とは判定していない。
Worker version変更なし、過去2環境と旧バイナリは未変更。全Worker/bucket/Queue/DLQ/workspace/.castloop/操作記録を保持。
このhostnameのCustom Domain/DNSは追加途中の復旧情報として保持しており、削除は行っていない。
local DNSの問題解消後の同operation IDによる続行判断が必要。秘密情報やmetadata本文はこの報告に転載していない。
