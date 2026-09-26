# 独自ドメイン対応 実装ログ

## 2026-09-26: D0/D1の着手

承認済みの計画は[`custom_domain_plan.md`](./custom_domain_plan.md)。既存サービスの変更や実機のCustom Domain作成はまだ行っていない。`domain add/list/remove`は公開CLIへ接続しておらず、v0.1.1の利用者に未完成の移行操作は見せない。

### 文書上確認したAPI契約

- Worker Domain: `GET /accounts/{account_id}/workers/domains`、`PUT /accounts/{account_id}/workers/domains`、`DELETE /accounts/{account_id}/workers/domains/{domain_id}`。Attach/DetachはWorkers Scripts Write、ListはWorkers Scripts Read/Writeを使用する。
- Zone確認: `GET /zones?account.id=...`。Zone Zone Readが必要。対象hostnameを含む最も具体的なzoneが`active`かつ`full`、対象account所有であり、pausedでないことを確認する。
- DNS競合確認: `GET /zones/{zone_id}/dns_records?name.exact=...`。DNS ReadまたはDNS Writeが必要。A/AAAA/CNAME/NSの既存recordは自動置換しない。RESTの権限は既存MVPのtokenとは別に確認する必要がある。
- Custom Domainの設定API応答だけでは公開TLSの準備完了を意味しない。実際のHTTPS応答で確認する待機方法は今後決める。

### 実装済みの基礎

- Feed生成時に、Episode revisionに残る絶対`enclosure_url`の**同一Show・Episode・音源path**を検証し、現在の公開基点に組み立て直す。音源未変更のEpisode改訂も現在の基点を使う。既存のimmutable revision、音源、GUIDは変更しない。
- CLIのCloudflare APIクライアントへzone検索、Worker Domain照会、同一hostnameの冪等な接続、対象Workerを確認した切断、DNS競合の事前検査を追加。外部から呼び出すコマンドはまだない。
- URLとAPI処理の自動テストを追加。実際のzone/証明書での動作や料金・Freeプランの受け入れは未検証。

### 次の設計・実機ゲート

1. **安全な公開停止:** 既存のShowごとのR2 admission keyとは別に移行markerを置いてチェックするだけでは、marker作成と新しいclaimが競合する。全Showの新規claimを止めてから既存のconsumerが書き終わるまで待つことを、R2の条件付き更新のみで原子的に保証する方式を決める。`processing`を強制解放しない。
2. **耐久移行状態:** 途中でfeedとcache purge、R2の`system/service.toml`、ローカル`castloop.toml`の一部だけが更新されたときの再開規則を実装・検証する。移行中の新規publicationと古いQueue再配送の扱いも決める。
3. **実機検証:** 管理者が所有する検証用Active/full zoneと専用Workerを決め、tokenの追加権限、DNS record競合、TLS反映時間、Freeプランの利用条件、API応答喪失時の照会・回復を確認する。既存の公開サービスやzoneは許可なく変更しない。
4. **公開ゲート:** `domain add`のprimary化と`domain remove`の復帰・Detachの両方が安全に完了するまで、公開CLIへコマンドを接続しない。

### 参照

- [Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Zone list API](https://developers.cloudflare.com/api/resources/zones/methods/list/)
- [DNS records list API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
