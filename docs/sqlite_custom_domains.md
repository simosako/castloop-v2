# SQLiteサービスの独自ドメイン

Issue #68の開発版CLI/Worker向け。対応版でfresh initしたservice schema 2 / `show-v1`、内部queue/content schema **6/7**とhealth識別`feed_generation_allocator="reservation-v1"`・`domain_changes="sqlite-domain-change-v1"`を必要とする。旧版のDB・journal・資源・外部で作った接続の移行や採用は行わない。

**Cloudflare実機の総合受け入れは未完了。** [初回](../design/sqlite_custom_domain_live_verification_20261024.md)・[再試験](../design/sqlite_custom_domain_live_retest_20261024.md)後の[ログ付き反復試験](../design/sqlite_custom_domain_iterative_verification_20261024.md)で、元PUTのenvironment空文字とDELETE成功時の0バイト本文を特定し、限定修正した。Show 0件での接続完了まで実証。切断復帰・公開redirect等の実機確認範囲は同記録を参照する。この文書自体は実環境操作の承認ではない。

[Show 0件の第3試験](../design/sqlite_custom_domain_environment_review.md)までの元応答は欠測のまま。[ログ調査と診断追加](../design/sqlite_domain_response_logging.md)後の新規実測を根拠に修正し、既存unknownの再送・採用・補完はしない。

## 前提と制約

- 1サービス1専用subdomainで全Show共通。apex・wildcard・Show別domain・複数domain・外部権威DNS・Cloudflare for SaaSは非対応。
- Workerと同じaccountのactive/full Cloudflare Zoneが必要。**Cloudflareで管理する必要があるのは権威DNSであり、購入・更新先のRegistrar移管は不要**。nameserver/Zoneの設定はcastloopが自動変更しない。
- 未使用のhostnameだけを指定する。既存DNS、委任、干渉するWorker Route、同hostnameの接続、同Workerの出所不明な接続は上書き・採用しない。
- **domain add/removeおよび未完了操作のcontinue中に、同じhostnameのDNSや対象Workerのdomain接続をdashboard/Terraform/別CLIから並行して変更するケースは想定外**。事前照会はCloudflare側のCASではない。無関係なDNSの管理や読取照会まで禁止する意味ではない。未知IOが残る場合も、CLI終了を根拠に別ツールで接続を変更・解放しない。
- `CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN`と元workspaceの管理鍵を使う。通常のWorker/R2管理権限に加え、対象ZoneのZone Read・DNS Read・Workers Routesの権限が必要。Cloudflareの現行routing権限案内は変更対象ZoneのWorkers Routes Writeを要求する。権限は管理者が確認し、自動拡張しない。Paid移行や証明書削除権限は要求しない。
- workers.devは管理originとして維持する。管理鍵を独自domainへ、Cloudflare tokenをCloudflare API以外へ送らない。Wrangler/Node.js/別R2 credentialは不要。

## 接続前の停止

未公開・未確定のローカルdraftは、domain変更前に元の設定で完了させる。staleな下書き・未知uploadを新しい設定へ引き継がず、原本・journalを消して回避しない。

各Showで明示Pauseし、既受付jobの終了（drain）を待つ。Pauseは新規受付と配信を停止するが、受付済みjobを取り消さない。blockedが残る場合は進めない。サービス共通domainの切替なので、結果として全所属Showが停止する。全体Pauseコマンドや自動Resumeはない。

```sh
castloop show-pause my-show PAUSE_UUID --workspace ./service
castloop service-status --workspace ./service --json
castloop domain add podcasts.example.com --zone-id ZONE_ID --operation-id ADD_UUID --workspace ./service --json
```

Showが複数ある場合は、それぞれ別UUIDでPauseする。`ADD_UUID`等は実際のUUID、`ZONE_ID`は対象Zone IDへ置き換える。

addは所属固定とShow別保守拘束、Custom Domain接続・DNS/TLS確認、R2設定保存、**新しい公開URLを埋め込んだWorker再配備**、全DOのnative確認、Feed再生成/purge・readiness、ローカル設定同期、保守解除を行う。音源・cover・revision履歴・GUID・日時・Showのsite_urlは変更しない。完了しても各Showはpausedのまま。

## 照会と明示再開

```sh
castloop domain list --workspace ./service --json
castloop domain status ADD_UUID --workspace ./service --json
castloop show-resume my-show NEW_WINDOW_UUID --workspace ./service
```

list/statusは読取専用。listは既知の接続とCloudflareの同Worker接続全件、設定・接続不一致、未完了ローカル操作と残存lockを表示し、想定外の複数接続を隠さない。statusはローカルphaseとremoteの固定要求、部分状態、全対象の集計を返す。Show一覧は20件ずつで、`next_cursor`を`--cursor SHOW_ID`へ渡す。一覧は非原子的snapshotで、復旧・再送の権限ではない。`doctor --local`も未完了domain記録・残存lockを警告するが修復しない。

Resume後の旧workers.dev公開URLは、同じパスの独自domainへ**Feed 301、cover/audio 307**で転送する。転送前にも対象Showの最新gateを確認し、Pause/readiness/保守/非公開/未承認パスでは転送しない。管理APIはworkers.devだけで、独自domainの管理経路は404。queryや資格情報を転送先へ含めない。正規domainでは従来のGET/HEAD/単一Range/ETag/日付条件を扱う。

## 中断後

```sh
castloop domain status ADD_UUID --workspace ./service --json
castloop domain continue ADD_UUID --workspace ./service --json
```

同じadd/removeを再実行しても暗黙再開しない。continueは**変更を含み得る明示操作**で、同じCLIの組み込みsource、旧/目標設定hash、操作、namespace、成功receipt等を照合して、未開始部分だけを進める。

外部接続receiptの検証失敗は`domain_connection_unverified`を返し、JSON errorの`fields`は既知のfield名と検証codeだけを最大20件示す。応答値・未知field名・本文・任意例外文は出さない。この診断は成功証拠や再送/採用の許可ではない。

失敗時のstderrには1行JSONの`event="sqlite_domain_cloudflare"`を出す。固定の`api_operation`・`method`・`reason_code`でHTTP/本文/JSON/envelope/接続照合のどこで止まったかを区別し、接続receiptでは`environment_kind`で欠落/null/空文字/production/別文字列/不正型を区別する。任意の値・例外・本文・URL・鍵は記録しない。詳細とローカル検証は[応答検証ログ](../design/sqlite_domain_response_logging.md)を参照する。過去PUTをログ取得のために再送せず、既存journalも変更しない。

資格情報なしのTLS HEAD待ちは`domain_tls_pending`と`api_operation=tls_probe`で区別する。接続がconnectedとして保存済みでも、TLS成功前は設定書込・配備へ進まない。

成功配備後の有限native待機は`domain_rollout_pending`として停止する。同じ配備receiptから明示continueし、再配備しない。CLI全体の実行時間は有限待機120回に加え各HTTP/照合時間も含むため、外部runnerの120秒制限で強制終了しない。残ったlockは強制解除しない。

| 停止位置 | 対応 |
| --- | --- |
| attachment_acknowledged保存済み、完全接続GET待ち | 同じIDへGETしproduction・全fieldの一致を検証。PUTは再送せず、connected保存前は設定書込・配備しない |
| 接続成功receipt保存済み、DNS/TLS待ち | continueで到達を観測する。接続PUTを繰り返さない |
| 配備PUT成功checkpoint保存済み、REST/native確認が停止 | continueで同じ配備を検証し、未開始activationだけを行う。再配備しない |
| 管理POSTの応答喪失、同じ要求の耐久完了証拠あり | continueで読取照合。元のPOSTを再送しない |
| remote完了・ローカル未同期 | 元/目標configだけを許容して同期する。無関係な編集を上書きしない |
| 接続/切断/設定/配備PUT自体の結果不明 | continueも再送・現在値からの採用を拒否。記録と停止状態を保持 |
| Feed書込/purge/probeのblocked、部分prepare/activation/解除の未知結果 | 万能復旧はない。新IDでの置換・自動rollback・Resume・lock強制解除をしない |

通常公開は明示publishだけ。完了済みdraftは、既知の完了domain変更と保存済み公開結果を照合した後、次の明示updateで元記録をそのままarchiveし、新configの別draftを作る。過去の要求を新configへ書き換えたり、未公開/不明draftを昇格したりしない。旧schemaの移行機能ではない。

## 切断

**301を記憶したpodcast appは独自domainへ直接アクセスし続ける可能性がある。切断だけで購読先がworkers.devへ戻ることは保証しない。** directory登録や利用者への移行案内は管理者の責任で、`itunes:new-feed-url`や購読者の自動移行は提供しない。

```sh
castloop show-pause my-show REMOVE_PAUSE_UUID --workspace ./service
castloop service-status --workspace ./service --json
castloop domain remove --operation-id REMOVE_UUID --workspace ./service --json
castloop domain list --workspace ./service --json
```

全Showの停止後、先にFeed/R2/Worker/DO/ローカル設定をworkers.devへ復帰・検証してから、正確な既知domain IDだけを切断する。成功後もpausedで、個別Resume後はworkers.devから本文を返す。旧独自originは配信allowlistから外れ、恒久的な転送維持はしない。音源・cover・revision・Feed履歴と共有証明書は削除しない。証明書がCloudflareに残る場合も自動整理しない。

切断DELETEは、正常なJSON成功envelope、またはHTTP 200・Content-Length 0・完全な0バイト本文を検証してから成功保存する。空応答の許容はこのDELETEだけで、HTTP statusだけの推測や後の不在GETから未知操作を成功へ昇格するものではない。

同configの通常`deploy`はdomain変更とは別操作で、既知接続を照合・保持するだけで接続/切断しない。

関連: [設計](../design/sqlite_custom_domains_plan.md)、[P0のAPI根拠・制約](../design/sqlite_custom_domains_p0.md)、[実機確認案](sqlite_custom_domain_live_acceptance.md)。旧Queueの操作は[v0.5.2固定文書](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/custom_domains.md)を使う。
