# 独自ドメイン対応計画（レビュー用）

作成日: 2026-09-25  
状態: 実装前・レビュー待ち

## 目的

管理者がcastloopサービスの公開Workerを、自身のCloudflare管理下にある独自ホスト名から利用できるようにする。Podcast feed、カバー画像、Episode音源のURLを独自ドメインにし、配信基点をサービス単位で管理する。

本計画は、既存のサービス構成（1サービスにつき1つの公開Worker、private R2、複数Show）を維持する。Cloudflare for SaaSを使って一般ユーザーのドメインを受け入れる機能や、castloopが共有ホスティングを提供する機能は対象外とする。

## 現状と影響範囲

- `init`で`workers.dev` URLを`castloop.toml`の`public_base_url`に設定する。
- Show/Episodeの公開Workerは同じWorker URL上でfeed、cover、audioを配信し、`system/`と`staging/`を外部公開しない。
- Episode公開時に`public_base_url`を使ってenclosure URLを生成し、Show/Episodeの公開処理でfeed XMLをR2へ保存する。feed URL、画像URL、音源URLはPodcast directoryやクライアントに長期間保持される。
- したがって、独自ホスト名をWorkerへ接続するだけでは既存feedのURLは切り替わらない。正規URL切替では、既存Showすべてのfeedを新しい基点で再生成し、旧URLの扱いを明示する必要がある。

## 提案する最初のスコープ

1. **サービス単位の独自ホスト名を1つ**登録できる。
2. ホスト名は、サービス管理者が所有または管理権限を持つCloudflareアカウント内のActive Zoneに属する。
3. Cloudflare Workers **Custom Domains**をREST APIで設定する。Custom Domainが指定ホスト名の全pathをWorkerへルーティングし、CloudflareがDNS recordとTLS証明書を設定する機能を利用する。
4. R2はprivateのままとし、公開配信は引き続きcastloop Workerを通す。
5. `workers.dev`は常時有効な代替・回復URLとして残す。
6. ドメインをWorkerへ接続する操作と、`public_base_url`をそのドメインへ切り替える操作を分離する。
7. 一度切替後も、管理者が明示的に元へ戻せるようにする。削除・切替手順で既存Showのfeedを途中のままにしない回復方法を設ける。

### 対象外

- 外部顧客が自己所有ドメインを登録するマルチテナント型Custom Hostnames / Cloudflare for SaaS。
- 1サービスで複数の独自ホスト名を正規配信先として同時に維持する機能。
- `www`/apex間の自動redirect、DNS providerがCloudflare以外のドメインへの対応。
- R2のpublic bucketやR2 Custom DomainによるWorkerを介さない配信。
- Apple Podcasts等のdirectoryへ登録済みfeed URLを自動変更する機能。

## Cloudflare上の前提

- Cloudflare Custom DomainsにはActive ZoneとWorkerが必要。ホスト名はzone apexまたはそのsubdomainとし、既存DNS状態との競合がないことを確認する。
- Custom Domainは指定ホスト名のすべてのpathを対象にする。`example.com`と`www.example.com`は別hostnameとして扱う。
- ドメイン追加時にCloudflareがDNS recordとTLS証明書を設定する。証明書が利用可能になるまで公開先として案内しない。
- Cloudflare APIのWorker Domains機能はWorkers ScriptsのRead/Write権限を必要とする。実際のtoken権限、作成・削除API、証明書反映時間、zone ownership/record conflict時の応答は実機で確認してから実装を確定する。
- 独自ドメイン機能がCloudflare Freeプランを含む対象プランで利用できること、および追加課金の有無を、公開前にCloudflareの最新プラン情報と対象アカウントで確認する。利用可能性を未確認のままREADMEで保証しない。

## CLIと設定の案

以下はレビュー用のCLI案。名称とサブコマンド構成は確定前。

```text
castloop domain add <hostname>
castloop domain list
castloop domain set-primary <hostname|workers.dev>
castloop domain remove <hostname>
```

- `domain add`はhostnameを正規化・検証し、現在のCloudflare API状態を確認してからWorker Custom Domainを作成する。これは接続操作であり、`public_base_url`や既存feedを変更しない。
- `domain list`はCloudflare上のhostnameとWorkerの関連付け、およびローカル設定上の正規URLを区別して表示する。
- `domain set-primary`はサービス設定の`public_base_url`を変更し、全公開Showのfeedを新しい基点で再生成する。対象Show、進行状況、失敗Show、再実行方法を表示する。
- `domain set-primary workers.dev`は独自ドメインから元に戻す操作として扱う。変更前の独自ドメイン接続は、切替成功後も自動削除しない。
- `domain remove`は正規URLに設定中のhostnameを削除できないようにする。先に別の正規URLへ切り替え、feedの再生成が完了した後に実行する。Cloudflare側のdomainを削除しても関連するAdvanced Certificateが自動削除されない可能性があるため、結果と必要な手動後片付けを案内する。
- 非対話利用を優先し、必要な値は引数で渡せるようにする。API token、account ID、証明書秘密情報はTOMLやログへ保存しない。

### `castloop.toml`の案

- `public_base_url`を引き続き正規配信URLの唯一の値として使う。
- Cloudflare Custom Domainの接続状態と、正規URLの指定を混同しない。永続化が必要な情報は最小限にし、hostname/zone/Workerの関連付けはCloudflare APIから再取得できる形を優先する。
- ローカル設定とCloudflare API状態が食い違う場合に備え、変更前の値を安全に保持し、操作を再実行できる手順を設計する。
- 新しい設定項目を追加する場合はstrict Zod schemaと`parseServiceConfig`を更新し、既存v0.1.1の`castloop.toml`をそのまま読める後方互換を保つ。

## 正規URL切替とfeed移行

独自ホスト名へ正規URLを切り替えると、Show feed内のchannel link、feed URL、cover URL、およびEpisode enclosure URLが影響を受ける。

### 提案する移行手順

1. hostnameをWorkerへ追加し、TLS/HTTPの準備完了とGET/HEAD配信を確認する。既存feedと`public_base_url`は変更しない。
2. 現行の全Show一覧を取得し、Showごとの現行feed/metadataを検証する。未公開Showや不完全な公開状態があれば切替を中断する。
3. 新しい基点のfeedをShowごとに再生成する。Episode GUID、公開日時、immutable MP3 object key、revision履歴は維持し、enclosure URLのhostnameだけを新基点へ変える。
4. 各feedのR2書き込み後、既存のfeed cache tag purgeを行う。Showごとの成功・失敗を追跡し、失敗時に同じ切替を再実行して収束させる。
5. 全Showのfeed更新とpurgeが確認できた時点で`public_base_url`を新しいURLとして確定する。途中で失敗した場合の旧URLへのrollbackまたは再試行を可能にする。
6. 完了後に新feedのURL、RSS内の画像/enclosure URL、HTTP GET/HEAD/Range、Cloudflare Cache purge後の新内容を検査する。

この順序の具体的実現方法は未確定。現在のWorkerがfeed再生成に使う`system/service.toml`と、CLIのローカル`castloop.toml`の更新タイミングを調査し、部分成功時に不整合が残らないプロトコルを実装前に決める。

### 旧URL

- 初期案では`workers.dev`を有効なまま維持し、旧URLへのアクセスが継続できるようにする。
- Feedが新しい正規URLへ切り替わった後、Podcast directory側の再クロール・更新は管理者が行う。feed内のEpisode GUIDは変えない。
- Workerは旧hostnameからの要求も同じR2 public keysへ応答する。旧URLから新URLへのHTTP redirectは第一段階では行わない。Podcast appのURL変更挙動やCacheへの影響を実機確認後、将来の選択肢とする。
- 独自domain切断はfeedの正規URL切替とは別操作にし、切断によって公開中feedのURLを壊さない。

## 実装マイルストーン案

### D0: API/プラン実証

- Workers Custom Domainsの作成・一覧・削除APIとレスポンス形状を確認する。
- 専用Workerと検証用zone/hostnameを使い、成功、既存DNS record競合、別Workerへの既登録、証明書待ち、API応答喪失後の再実行を試す。
- 現在のMVP tokenを拡張する場合の最小権限、必要なzone権限、Freeプランでの利用条件と料金を記録する。
- 管理用CLIからCloudflare API tokenのみで完結し、Dashboardでの手動DNS編集が必要なケースを明確化する。

### D1: 独自hostnameの管理

- CLIでCustom Domain追加・一覧・削除を実装する。
- 入力hostname、API取得値、zone ownership、既存recordの競合、別サービスWorkerとの重複を検証する。
- API通信の一時失敗と恒久失敗を区別し、作成成功後に応答を失った場合も一覧取得から安全に再開できるようにする。
- TLS準備完了を待つhealth checkの上限と、再試行方法を実装・文書化する。

### D2: 正規URL切替とfeed再生成

- `public_base_url`変更と全Show feed再生成を安全に実施するCLIフローを実装する。
- Episode GUID、音源URL path、revision履歴を維持したままhostだけを切り替える。
- 途中失敗のstatus、再実行、旧正規URLへのrollback、cache tag purgeを検証する。
- 新規Show/Episodeを独自domain有効化後に公開する場合にも正規hostnameが一貫することを確認する。

### D3: 受け入れ・配布

- API mock test、設定schema/後方互換test、feed移行testを追加する。
- Cloudflare専用zoneでcreate → TLS ready → publish → URL切替 → 更新 → rollbackまたはdomain removeを端から端まで検証する。
- v0.1.1バイナリの運用要件を維持し、Linux x86-64の配布バイナリで全管理操作を確認する。
- README、CLI help、トラブルシュート、必要なAPI token権限、zone/DNS前提を更新する。

## 受け入れ条件

- 独自domainを追加しても既存`workers.dev` URL、Show/Episode、private R2、Worker cache、Queue publicationの挙動が壊れない。
- 正常なCustom Domain作成後、Cloudflareが証明書を準備できるまで状態を区別して表示し、準備完了後にfeed/cover/audioがGET/HEAD/Rangeで配信できる。
- 別zone、非Active zone、既存CNAME/競合DNS record、既に別Workerへ接続されたhostnameを安全に拒否し、既存DNS設定を勝手に置換しない。
- 正規URL切替で公開中すべてのfeed内URLが独自domainに切り替わり、GUID、`published_at`、immutable音源key、revision履歴は不変である。
- Feed cache purgeの失敗時に移行完了を報告せず、同じ操作の再実行で完了できる。
- 部分失敗時に、処理済みShow、未処理Show、ローカル設定、R2設定の状態を明瞭にし、重複公開やEpisode再アップロードなしで再試行またはrollbackできる。
- `workers.dev`へ戻す操作で、全feedが旧hostnameへ戻り、公開素材が失われない。
- 既存v0.1.1サービス設定の後方互換を保ち、管理端末にNode.js/npm、Bun、Wrangler、ffprobe、R2 S3 credentialsを要求しない。

## レビューで決めたいこと

1. 初期スコープは「1サービスにつき独自hostname 1つ」でよいか。複数のalias（www/apex両方など）を初期から扱う必要があるか。
2. hostnameのCloudflare zoneは、castloopのWorkerと同じCloudflareアカウントに必須とするか。別アカウントや外部DNSは初期対象外でよいか。
3. Custom Domain接続後も`workers.dev`を残し続ける方針でよいか。
4. ドメイン接続コマンドと正規URL切替コマンドを分離する方針でよいか。
5. 正規URL切替時に既存Show全feedを一括再生成する方式でよいか。Show数が多い場合の進捗表示・再開要件はどの程度必要か。
6. 初期リリースではHTTP redirectを設けず旧hostnameを並行稼働させ、directory移行を管理者操作とする方針でよいか。
7. `domain remove`を初期リリースに含めるか、まず追加・一覧・正規URL切替・workers.devへの復帰までに絞るか。

## Cloudflare一次資料

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) — Active Zone、hostname単位の全path routing、DNS/TLS自動設定、既存CNAME等の注意事項。
- [List Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/) — account-scoped `GET /accounts/{account_id}/workers/domains` とWorkers Scripts Read/Write権限。
- [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) — 外部顧客の独自hostnameを提供する用途。本計画の管理者自身のzoneでのCustom Domainとは対象が異なる。
