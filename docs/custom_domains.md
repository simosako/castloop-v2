# 独自ドメインの設定と変更

一つのサービスの全Showを、専用サブドメインから配信する手順です。Workerコードの更新とは別の操作です。対応するサービス形式は[利用ガイド](README.md#対象と用語)を参照してください。外部で作った不明な接続や古い形式の管理記録は採用しません。

## 前提と制約

- 1サービス1専用subdomainで全Show共通。apex・wildcard・Show別domain・複数domain・外部権威DNS・Cloudflare for SaaSは非対応。
- Workerと同じaccountのactive/full Cloudflare Zoneが必要。**Cloudflareで管理する必要があるのは権威DNSであり、購入・更新先のRegistrar移管は不要**。nameserver/Zoneの設定はcastloopが自動変更しない。
- 未使用のhostnameだけを指定する。既存DNS、委任、干渉するWorker Route、同hostnameの接続、同Workerの出所不明な接続は上書き・採用しない。
- **domain add/removeおよび未完了操作のcontinue中に、同じhostnameのDNSや対象Workerのdomain接続をdashboard/Terraform/別CLIから並行して変更するケースは想定外**。
- `CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN`と元workspaceの管理鍵を使う。通常のWorker/R2管理権限に加え、対象ZoneのZone Read・DNS Read・Workers Routesの権限が必要。権限は管理者が確認し、自動拡張しない。Paid移行や証明書削除権限は要求しない。
- workers.devは管理originとして維持する。管理鍵を独自domainへ、Cloudflare tokenをCloudflare API以外へ送らない。Wrangler/Node.js/別R2 credentialは不要。

## 独自ドメインの追加

手元の未公開編集を、ドメイン変更のために公開する必要はありません。変更前後の設定をローカル記録へ保存して実行します。配信可否を手動で切り替える事前操作や、完了後の手動再開は不要です。

```sh
castloop service-status --workspace ./service --json
castloop domain add podcasts.example.com --zone-id ZONE_ID --operation-id ADD_UUID --workspace ./service --json
```

`ADD_UUID`は実際のUUID、`ZONE_ID`は対象Zone IDへ置き換える。

`domain add`は次の手順を一連で進める。
1. **準備**：対象Showの未実行予約を `needs_approval` へ移します。準備から確定までの間は `publication_ready: false` となり、公開配信はHTTP 503を返します。
2. **接続・設定・配備**：Custom Domainを接続し、DNS・TLS到達、公開URLを切り替えたWorkerの配備と反映を確認します。
3. **確定・同期**：必要なキャッシュパージとサーバー側設定の確定を行い、配信を再開します。ローカルの `castloop.toml` も同期します。

音源・カバー・履歴・GUID・日時・Showの `site_url` は変更しません。内蔵サイトのcanonical／OGPとRSSの公開URLは新しいオリジンへ切り替わります。複数Showと外部資源をまたぐ変更全体が、同時に一括確定するわけではありません。

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

現行形式のドメイン変更はローカル模擬試験の対象ですが、現行版の限定的な実機確認には含まれません。[検証範囲](../design/testing.md#実機検証と証明できる範囲)と実際の稼働確認を区別してください。

関連: [制御DOと独自ドメイン変更の設計](../design/components/control-do.md)、[設定・要求スキーマ](../design/data/schemas.md)。
