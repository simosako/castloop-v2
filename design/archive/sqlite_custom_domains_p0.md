# Issue #68: P0詳細契約とAPI非上書き条件の確認

2026-10-24。[開発計画](sqlite_custom_domains_plan.md)に対して開発開始の指示を受け、P0の調査・詳細化を実施した。**管理者確認により、外部同時変更は実装の想定外として制約を記録し、開発を進める。API条件による保留は解消。** 実Cloudflareへの認証付き操作、配備、DNS変更、接続・切断、公開・Resumeは行っていない。

## 1. P0で見つかった判断事項

公開APIの仕様だけでは、外部の同時変更を含めた「他のDNS/Worker接続を上書き・削除しない」を確認できない。

1. castloopがGETで対象hostnameに接続/DNS競合がないと確認する。
2. 別の管理者・dashboard・自動化が同じhostnameへ接続やDNSを追加する。
3. castloopのAttach PUTが到着する。

この競合に対する条件付き作成、期待旧状態の指定、CAS、非上書きflagが公開Attach APIに見当たらない。**実際に必ず上書きするという調査結果ではなく、上書きしないという保証が不足している**。直前GET・直後GET・ローカルlock・DOの保守拘束は、Cloudflare側の他の書き手を拘束しない。

管理者判断により、この外部同時変更への対処は実装要件にしない。既知の競合を検出・拒否する条件と、未知結果を再送しない条件は維持する。

## 2. 確認した一次資料

### 2.1 公開REST

- [Domains一覧](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Attach](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/): `PUT /accounts/{account_id}/workers/domains`
- [Detach](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/): `DELETE /accounts/{account_id}/workers/domains/{domain_id}`

Attachの公開入力はhostname、service、Zone指定、enabled/previews設定であり、非上書きflagや期待旧接続IDは掲載されていない。Detachも対象IDによる要求であり、GET時のWorker/hostnameと一致する場合だけ削除する条件指定は掲載されていない。どちらも、他ツールが同時に変更する場合の保護を推測で補わない。

Attach/DetachのAPI受け入れ権限は公式記載では`Workers Scripts Write`。これとは別にZone/DNS/routesの事前読取権限が必要になる。Cloudflareのrouting案内は変更対象Zoneの`Workers Routes Write`も要求するため、API単体の記載だけを最小権限の保証にはしない。[利用ガイド](../../docs/sqlite_custom_domains.md)に必要範囲を記載し、権限変更は自動実行しない。

Detachの公開成功形式はHTTP 200の`success: true`、`errors`、`messages`を持つenvelope。新実装ではerrorsが空配列またはnullであることと本文の完全読取を要求する。2026-10-24の別途承認された実機確認では、空のWorker domain一覧が`errors: null`、`result_info={page:1,per_page:0,count:0,total_count:0}`（`total_pages`なし）を返した。単一page一覧はcountと全件数の一致を引き続き要求し、DNSの複数page列挙は明示的な`per_page=100`と`total_pages`を必須のまま維持する。旧バグ対応にあった200/nullや204を、この資料だけから許可する根拠は得られていない。未知形式は未知結果として保持し、後の不在GETで完了へ昇格しない。

Worker domainの`id`はaccount/Zone/namespaceの32桁IDとは別のopaque識別子として扱う。公開Get仕様はstringで固定長を定義しておらず、上記実機の読取一覧では40文字だった。長さ1〜256、英数字・`_`・`-`の安全なpath segmentを許容し、GET/DELETEではURL encodeする。IDの切り詰め・変換や別IDの同一視はしない。接続PUTの成功receiptを保存できなかった初回環境は、このparser修正後も読取状態から採用・昇格しない。[初回停止記録](sqlite_custom_domain_live_verification_20261024.md)を参照する。

[再試験](sqlite_custom_domain_live_retest_20261024.md)もreceipt検証で停止し、GETで見える接続が修正版schemaに適合しても元PUTの成功へ昇格しない。ID修正だけで解消したとは扱わない。次の切り分け用に`domain_connection_unverified`とallowlist済みfield名/codeだけの診断を追加し、値・未知field名・任意例外文は出さない。診断追加は応答の受け入れ条件や復旧許可を変えない。

別途承認された[Show 0件の第3試験](sqlite_custom_domain_environment_review.md)では、PUT応答の`environment="production"`固定検証で停止することを確認した。元の値/有無は未記録であり、GETのproductionから補完しない。deprecated fieldの扱いとPUT/GETの役割を分ける二段階receipt案を同文書へ提示した。**レビュー待ち・未実装**で、完全接続のproduction gateや既存unknown非採用はまだ変更していない。

管理者の指摘により二段階案は保留し、先に[保存ログの調査・CLI段階別診断](sqlite_domain_response_logging.md)を追加した。元PUTの欠測を新しいログで埋めたとは扱わず、成功応答の許容条件や未知結果の再送/採用条件は変更しない。

その後の追加承認による[第4試験と修正](sqlite_custom_domain_iterative_verification_20261024.md)で元PUT空文字を特定した。現行はPUT acknowledgementのenvironmentを空文字/productionに限定し、GETより先に専用checkpointへ保存する。そのIDへのGETはproduction固定と全field一致を要求し、完全connectionを得るまで設定書込・配備しない。旧unknownは非採用・非再送のまま。前段落までの未実装/保留は診断当時の履歴である。

同記録の第7試験では、元DELETEのHTTP 200・Content-Length 0・完全0バイト本文を特定した。このDELETEだけ本文なし成功を検証できるよう修正し、他API/不完全応答/長さ不明の空応答は引き続き拒否する。旧detach_requestedもGET不在から昇格しない。

### 2.2 Cloudflareの公開ソースにある別経路

[workers-sdkの固定commit `e651d7c0dd8e171dcc1820679f9f46601971d876`の`publishCustomDomains()`](https://github.com/cloudflare/workers-sdk/blob/e651d7c0dd8e171dcc1820679f9f46601971d876/packages/deploy-helpers/src/triggers/publish-routes.ts)を確認した。

この実装では、Worker単位の別endpointを使う。

```text
POST /accounts/{account_id}/workers/scripts/{script}/domains/changeset?replace_state=true
PUT  /accounts/{account_id}/workers/scripts/{script}/domains/records
```

PUTには`override_scope`、`override_existing_origin`、`override_existing_dns_record`がある。ソース上は後ろの2つを初期値falseとし、非対話実行ではtrueへ変更している。したがってWranglerの非対話動作を安全な非上書き実装としてコピーしてはならない。

また、この処理はWorker単位の全体設定を扱う。公開Attach APIに同じflagが使える、false指定ならすべての競合が原子的に防げる、`override_scope`を変更しても同じ意味になる、という保証までは得られない。確認した公開Domains API一覧にはこのchangeset/records契約は掲載されていない。

これは代替APIの調査根拠であって、非公開契約の採用承認やWrangler依存追加の理由ではない。当初の開発指示では実機API検証を行わず、後に別途承認された試行だけを[初回停止記録](sqlite_custom_domain_live_verification_20261024.md)へ区別して残す。

## 3. 採用方針と運用上の制約

**公開RESTを使う。domain add/remove/未完了操作のcontinue中に、同じhostnameのDNSや対象Workerのdomain接続を他ツールから変更するケースは想定外とする。** 管理者確認済みの制約であり、この競合専用の仕組みや追加の確認フラグは実装しない。非公開endpointへの依存を増やさず、castloop内の排他と外部運用の境界を示す。

追加の前提:

- domain変更の事前確認開始から完了、または安全な中断状態の調査終了まで、対象hostnameのDNS・委任・干渉するroutesと、対象WorkerのCustom Domain接続をdashboard/別CLI/Terraform等で変更しない。
- 外部変更の不存在をcastloopが証明できるとは表示しない。この制約のための追加承認や実行時の証明は要求しない。照会と無関係なDNSの管理、通常運用全般を禁止するものではない。
- 既知の競合、複数接続、未知接続、権限不足、途中pagination、設定不一致は操作前に拒否する。途中で変化を観測した場合は停止し、取り戻すPUTや自動rollbackをしない。
- 未知IOが残った場合も「CLIが終了したから他ツールで修復可能」とはしない。専用hostname/接続の保全と未知結果の保持を継続する。

これにより保証する範囲は、**外部同時変更がない通常の運用で、検出した既存資源を採用・上書きせず、凍結した対象だけを操作すること**となる。任意の外部同時変更までAPIが原子的に防ぐ保証ではない。この制約は実装後の利用ガイドにも記載する。

非上書きの未記載の原子性を保証する目的の追加API調査・実機試験は、開発の前提としない。

## 4. 実装するHTTP契約

ユーザーから確認済みの停止手順・転送方向に沿い、次を実装契約案とする。

| 状態・経路 | 応答 |
| --- | --- |
| 独自domain未接続のworkers.dev公開パス | 対象Showのgate確認後、従来の本文/条件付き応答 |
| 接続完了・明示Resume後のworkers.dev Feed | 対象Showのgate確認後、同じ公開パスの独自domainへ301/no-store |
| 接続完了・明示Resume後のworkers.dev cover/audio | 対象Showのgate確認後、同じ公開パスの独自domainへ307/no-store |
| 正規独自domainの公開パス | 対象Showのgate確認後、本文/Range/条件付き応答 |
| paused/readiness不一致/保守拘束 | 503/no-store、Locationなし |
| 未知origin、private/内部/未承認パス | 従来の拒否、Locationなし |
| 独自domain上の管理API | 404/no-store、管理DOへ転送しない |
| workers.dev上の管理API | 従来どおり認証した管理処理。redirectなし |
| 切断・確認完了後、明示Resumeしたworkers.dev | 本文/条件付き応答へ復帰 |

Feedは購読先URLの移転に合わせ301、cover/audioは購読先保存を促す必要がないためmethod保持・可逆性を優先して307とする案。Feedの301をアプリが記憶した後の切断は自動復帰を保証しない。外部クライアントの状態はサーバーから取り消せず、短期間での接続/切断はdirectory登録や購読先への影響を管理者が確認する。

gatewayはorigin/path/methodを検証し、管理経路を先に分離してからShow配信判定を行う。公開許可後にだけredirectし、redirect応答ではcache ownerを呼ばない。公開本文の正規originでは再び最新gateを確認する。旧originの成功判定は転送先の永続的な公開許可ではない。

Locationは設定された正規originと承認済みpathnameだけから構築し、query/fragmentを引き継がない。GET/HEADのみを扱い、HEADに本文を付けない。Range/ETag等の結果は転送先で判定する。クライアントが条件headerを引き継ぐ場合・引き継がない場合を分けて試験し、後者でも未承認内容を返さない。既存のblocked継続配信条件は変更しない。

## 5. 旧/新configと途中状態の詳細化

以下を実装の基準とする。実装済み範囲は開発計画で区別する。

- 凍結要求は旧/目標config全文とhash、service/account/Worker/bucket/namespace/管理origin、source/metadata hash、操作ID、action、hostname/Zoneを持つ。差分は`public_base_url`だけに制限する。
- registryの所属集合を制御DO transactionで固定する。Show別に`prepare`、`activate`、`feed`、`probe`、`release`の進行を保存し、共有code-only更新と同じ排他に接続する。
- 各段階は`pending → requested → confirmed`。requestedを保存・syncするまで副作用を始めない。requestedの再送は行わず、同一要求の耐久完了証拠がある場合のみ読取照合する。
- 配備直後の専用statusは旧保存identityと目標実行identityを別fieldで返す。通常公開・通常管理mutation・Resumeは許可しない。制御DOだけの新native確認ではactivationしない。
- Show内activationは完全一致するpreparedと旧/目標runtimeを照合して実行する。Feed保存・purge・SQL pointer切替、新configのR2/cache/readiness検証が終わるまで保守拘束を維持する。
- 全ShowのFeed/probe完了とlocal/R2/Worker設定同期を確認してから解除する。解除の部分成功も保持し、全体完了と混同しない。各Showはpausedを維持する。

### Feed世代の採番

公開job FIFO sequenceとFeed snapshotの世代を分け、Show内に単調増加するFeed世代予約表を設ける案とする。通常publish/lifecycleとdomain再生成のすべてが同じ採番を使う。

- 公開jobは正確なjob/requestへ、domain再生成は正確な保守operationへ世代を束縛する。同じ要求に別の候補世代を発行して再PUTする経路は設けない。
- 副作用開始前に予約を耐久化し、candidate keyは現行の正整数世代形式を維持する。候補保存成功・必要なpurge成功後、期待旧世代の一致を再確認してpointerを原子的に切り替える。
- job sequenceとFeed世代の等値に依存するexecutor/commit/guard/fixtureを改修する。coverの不変世代、revision ID、Episode承認mediaは変更しない。
- queue/contentの新規形式識別を定義し、旧5/6環境を変換・採用しない。service schema 2・show-v1・Worker class/binding/compatibility dateは維持する。

## 6. 実装・検証への接続

1. §3の制約に沿って公開RESTを使う。外部同時変更について再承認を求めず、開発を進める。
2. P1〜P6のstrict schema、SQL、HTTP、CLI/journalと模擬故障注入を実装した。`bun test`・`npm run check`・CLI buildの結果と実機未確認の範囲は[開発計画§9](sqlite_custom_domains_plan.md#9-開発順とレビュー区切り)を参照する。

ローカル模擬試験を追加してもCloudflare APIの未記載の原子性は証明できない。実機試験、権限変更、Cloudflareへの問い合わせも自動では行わない。
