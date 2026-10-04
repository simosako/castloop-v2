# 独自ドメイン対応 実装ログ

## 2026-10-04: 管理URL分離と通常更新の接続保持

開発順①を実装した。管理操作は同じWorkerの`workers.dev`へ固定し、`public_base_url`はRSS/公開URLとして維持する。

- optionalな`workers_dev_base_url`をstrict service schemaへ追加。対象Worker名とHTTPS originを検証し、新規initで保存する。未設定の既存M6設定では元のworkers.dev URLを使い、設定値や稼働証跡のhashを自動変更しない。
- 共通管理クライアントと旧形式の調査用クライアントで管理URLを解決する。独自ドメインへのfallback、redirect追跡、失敗時の自動再送はしない。
- 通常deployのREST対象をaccount/Worker identityで決める。設定どおりの0/1件の接続を事前・更新中・検証時に照会し、別hostname/別Worker/複数接続/接続消失なら拒否する。DomainのPUT/DELETEは通常更新では行わない。
- 既存の停止・所有者・version receipt・HTTP/Queue/runtime検証をそのまま使い、独自ドメイン付き更新も完了後はpausedを維持する。新規initと旧形式変換のworkers.dev限定条件は維持する。
- journal identity schemaは同じwire形式のまま共有定義へまとめた。操作固有の状態遷移・receipt検証は変更していない。

検証: `bun test` 911件成功、`npm run check`、試験用TypeScript検証、Linux単一バイナリのbuildと資格情報なしのhelpが成功。追加テストは管理先の固定、既存hash互換、接続保持/不一致拒否と独自ドメイン付き既存更新フローに絞った。既存テストのHTTP期待値を管理先へ合わせ、安全条件のテストを重複追加していない。

`domain add/list/remove`はまだ公開していない。次は共通admissionでの正規URL切替、active feed再生成・purgeと設定同期を接続する。実サービス・DNS・Cloudflareリソースは変更していない。

## 2026-10-04: v0.2.1に合わせた計画の縮小・更新

[`custom_domain_plan.md`](./custom_domain_plan.md)をM6完成後の共通処理へ合わせて改訂した。今回は文書のみを変更し、以下は実装済み機能と追加予定の区別である。以下の2026-09-30以前の記述は履歴として保持する。

- `ensureWorkerDomain`は既存の別hostname/別Workerを拒否し、1サービス1ドメインをすでに制限している。domain listはこの0/1件の状態確認であり、複数ドメイン実装は不要。
- 通常の配信・公開・削除・restoreはドメインに依存させない。別の停止・CAS・lock・cache・consumerを作るのではなく、M6の共通層を利用する。
- 独自処理はCloudflareの接続/切断とDNS/TLS確認だけに絞る。正規URLの切替・逆方向の復帰は同じ処理にし、既存feed生成・lifecycle選別・journal保存を再利用する。
- 通常deployのCustom Domain拒否は解除予定。ただし`migrationWorkerPath`のworkers.dev限定条件と、管理APIが`public_base_url`へ接続する前提も修正が必要。旧形式変換・新規initの安全条件まで緩めない。
- 改訂計画では既存service-pause/resumeを使い、一時停止下で切替を完了する。stagingを並行継続する機構、無停止移行、旧形式変換、一般的な操作状態機械は追加しない。
- URL変更はWorker再配備・音源コピー・revision変更ではない。現行のcompatible updateは新Worker version前提なので偽装転用せず、必要なURL変更所有者を共通service admissionへ最小限追加する計画とした。
- 接続/TLS、feed・cache・R2/ローカル設定の収束を確認し、未完了の変更中は通常resume/deployを拒否する。操作完了後もpausedを保持し、明示再開後に公開配信を確認する。

直前のコード調査では関連テスト61件と`npm run check`が成功。今回、実サービス・DNS・Cloudflareリソースの変更や新CLI公開は行っていない。

## 2026-09-30: M6を先行する開発順へ変更

公開済みv0.1.2の次マイルストーンを[Episode・Showの公開停止と削除（M6）](./m6_content_lifecycle_plan.md)とした。独自ドメインの承認済み方針とD0/D1基礎コードは維持し、完成・CLI公開・実機受け入れはM6の後続へ回す。domainコマンドは引き続き未公開。

M6で導入する状態モデル・Showの受付排他・cache entrypointに合わせ、domain移行はactiveコンテンツだけを扱う必要がある。全Showの原子的移行停止やprimary設定の同期は未解決のままで、M6がそれを解決したとは扱わない。以下の過去ログは当時の調査・実装範囲として保持する。

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
