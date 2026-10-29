# SQLiteサービスの独自ドメイン

フェーズ3開発版（新規環境のservice schema 2 / `show-v1`、内部queue/content形式 **14/13**、health識別`domain_changes="sqlite-domain-change-v1"`）向け。旧版のDB・journal・資源・外部で作った接続の移行や採用は行わない。

## 前提と制約

- 1サービス1専用subdomainで全Show共通。apex・wildcard・Show別domain・複数domain・外部権威DNS・Cloudflare for SaaSは非対応。
- Workerと同じaccountのactive/full Cloudflare Zoneが必要。**Cloudflareで管理する必要があるのは権威DNSであり、購入・更新先のRegistrar移管は不要**。nameserver/Zoneの設定はcastloopが自動変更しない。
- 未使用のhostnameだけを指定する。既存DNS、委任、干渉するWorker Route、同hostnameの接続、同Workerの出所不明な接続は上書き・採用しない。
- **domain add/removeおよび未完了操作のcontinue中に、同じhostnameのDNSや対象Workerのdomain接続をdashboard/Terraform/別CLIから並行して変更するケースは想定外**。
- `CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN`と元workspaceの管理鍵を使う。通常のWorker/R2管理権限に加え、対象ZoneのZone Read・DNS Read・Workers Routesの権限が必要。権限は管理者が確認し、自動拡張しない。Paid移行や証明書削除権限は要求しない。
- workers.devは管理originとして維持する。管理鍵を独自domainへ、Cloudflare tokenをCloudflare API以外へ送らない。Wrangler/Node.js/別R2 credentialは不要。

## 独自ドメインの追加

手元の未公開編集は公開状態と独立しており、domain変更のために公開する必要はない。事前のShow Pauseや手動Resumeは不要であり、変更前の設定（`previous_config`）と変更後の設定（`target_config`）をローカルjournalに保存した上で実行する。

```sh
castloop service-status --workspace ./service --json
castloop domain add podcasts.example.com --zone-id ZONE_ID --operation-id ADD_UUID --workspace ./service --json
```

`ADD_UUID`は実際のUUID、`ZONE_ID`は対象Zone IDへ置き換える。

`domain add`は次の手順を一連で進める。
1. **準備**: 制御DOと全Show DOに要求を記録し、未実行の予約公開を`needs_approval`へ移す。準備から確定までの間、各DOは`publication_ready: false`となり公開配信はHTTP 503を返す。
2. **接続・設定・配備**: Custom Domain接続とDNS/TLS到達確認を行い、`system/service.toml`の更新と新しい公開URLを組んだWorkerの配備・反映確認を行う。
3. **確定・同期・完了**: 各DOで必要なキャッシュパージ後に設定hashとFeed世代を更新して配信を再開し、ローカルの`castloop.toml`を更新して制御DOにドメイン接続を記録する。音源・cover・revision履歴・GUID・日時・Showの`site_url`は変更しない。

## 照会と中断後の継続

```sh
castloop domain list --workspace ./service --json
castloop domain status ADD_UUID --workspace ./service --json
castloop domain continue ADD_UUID --workspace ./service --json
```

`list`／`status`は読取専用。切替完了後の旧workers.dev公開URLは、同じパスの独自domainへ**Feed 301、cover/audio 307**で転送する。管理APIはworkers.devだけで、独自domainの管理経路は404。

通信断やDNS/TLS待機（`domain_tls_pending`）、Worker反映待ち（`domain_rollout_pending`）で中断した場合は、保存された変更前後の設定とjournalをもとに `castloop domain continue ADD_UUID` を実行すれば、現在の状態をAPIで確認して未完了ステップから完了まで進められる。

通常公開は明示publishだけ。domain完了後は新しい設定でpreviewして公開する。停止した予約公開は`preview-schedule-reapprove`→`schedule-reapprove`で再承認する。

## 切断

**301を記憶したpodcast appは独自domainへ直接アクセスし続ける可能性がある。切断だけで購読先がworkers.devへ戻ることは保証しない。** directory登録や利用者への移行案内は管理者の責任で、`itunes:new-feed-url`や購読者の自動移行は提供しない。

```sh
castloop domain remove --operation-id REMOVE_UUID --workspace ./service --json
castloop domain list --workspace ./service --json
```

先にR2設定・Worker・全DO・ローカル設定をworkers.devへ復帰・確定してから、既知のdomain接続を切断して完了する。完了後は即座にworkers.devから配信を再開する。音源・cover・revision履歴と共有証明書は削除しない。

同configの通常`deploy`はdomain変更とは別操作で、既知接続を照合・保持するだけで接続/切断しない。

関連: [フェーズ3設計](../design/phase3_deploy_and_runtime_control_simplification_plan.md)、[P0のAPI根拠・制約](../design/sqlite_custom_domains_p0.md)。
