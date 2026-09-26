# 独自ドメイン対応計画

作成日: 2026-09-25
方針確定: 2026-09-26
状態: 設計方針承認・実装前

## 目的と初期スコープ

管理者自身のCloudflareアカウント内の公開Workerを、任意の独自ホスト名から配信できるようにする。**独自ドメインは1サービスにつき1つのホスト名だけ**とし、サービス内の全Showに共通で適用する。Showごとの独自ドメインや複数ドメイン対応は対象外とし、必要になったときに改めて検討する。既存の`workers.dev`は引き続き利用可能にする。

**R2は常にprivateとし、feed・画像・MP3を含む公開配信は必ずcastloop Workerを経由する。** 1サービスにつき1 Worker/1 private R2 bucketで複数Showを扱う現行構成は維持する。R2 Custom Domainやpublic bucketは利用しない。Cloudflare for SaaSによる、外部顧客のドメインを受け入れるサービスではない。

## 現状と影響

- `init`が`workers.dev` URLをサービス設定`public_base_url`へ書き、`system/service.toml`にも保存する。CLI管理APIの接続先もローカル`public_base_url`である。
- WorkerのShow/Episode公開処理はR2の`system/service.toml`から同じURLを読み、feedを生成する。Episodeの現行metadataとimmutableなrevision metadataは絶対URLの`enclosure_url`を持つ。
- Feedの`atom:link`、カバーURL、enclosure URLは公開先が変わる。**channelの`link`と画像要素内の`link`はShowの`site_url`であり、ドメイン切替だけでは変えない。** Episode GUID、公開日時、音源のR2 keyも変えない。
- 現状の`src/feed.ts`はrevisionに保存されたenclosure URLをそのまま出力する。単純に`public_base_url`を変更してfeedを再生成するだけでは既存Episodeのenclosureは旧ホスト名のまま残る。音源未変更のEpisode改訂も旧URLを継承する。この点を解消する移行・feed生成設計が必要。
- Workerは現在公開パスをhostnameでは区別しない。独自ドメインでも全Showの公開パスが開くことを初期スコープの仕様とする（他のShowの独自ドメインとしては扱わない）。`system/`と`staging/`は引き続き非公開。

## スコープの判断

Cloudflareは同一Workerへの複数ホスト名の接続を許すが、現行の公開URLとEpisode revisionの`enclosure_url`はサービス単位であり、WorkerはhostnameごとにShowを区別しない。Show別ドメインにはURL移行とhostname別の配信制御が追加で必要になる。今回の実装では扱わず、Show別URLの設定項目も追加しない。

## DNS、zone、TLSの前提

- Workers Custom Domainには、対象ホスト名を含む**ActiveなCloudflare Zone**と対象Workerが必要。登録したホスト名の全パスをWorkerへ接続し、CloudflareがDNS recordとTLS証明書を用意する。既存のCNAME recordや他サービスとの競合を勝手に上書きしない。
- **独自ドメイン利用の必須条件は、対象zoneの権威DNSがCloudflareであり、zoneがActiveであること。** ドメイン登録事業者そのものをCloudflareへ移管する必要はない。現在Route 53を権威DNSとして使っている場合は、zoneのネームサーバーをCloudflareへ切り替え、既存DNS recordを移行・確認してから利用する。
- Route 53等を権威DNSとして維持するpartial (CNAME) setupは本機能の対象外。CloudflareにはBusiness/Enterprise向けのpartial setupも存在するが、castloopではプランにかかわらずこの方式を扱わない。Freeプランで「Route 53のまま指定ホストだけCNAMEを追加すれば動く」とは案内しない。
- `www.example.com`だけを登録した場合、`example.com`のDNS、HTTP、redirectには**関与しない**。逆も同様。複数aliasや自動redirectは対象外。
- 本機能のtokenに必要な権限、DNS/TLSが利用可能になるまでの時間、FreeプランでのWorker Custom Domain利用条件・追加料金は、実装前のAPI調査と実機検証で確定しREADMEに記載する。

## 管理操作

```text
castloop domain add <hostname>
castloop domain list
castloop domain remove
```

- **`domain add`の成功時に独自ドメインをprimaryにする。** 内部では「Workerへの接続→DNS/TLS/health確認→全Show feedと公開設定の移行」を順に行う。別の`set-primary`コマンドは公開しない。途中で処理が止まった場合はprimary化完了を報告せず、**同じ`domain add <hostname>`を再実行して再開**できるようにする。hostnameはHTTPSのhostだけ（パス・portなし）を受け付ける。
- すでに別の独自ホスト名がprimaryの場合は新規`add`を拒否する。変更したい場合は`remove`で`workers.dev`へ安全に戻してから追加する。
- `domain list`はWorkerへの接続状況、公開設定上のprimary、移行中/要再試行の状態を区別して表示する。Cloudflare APIのhostname一覧だけを移行完了の根拠にしない。
- **`domain remove`は全Showとサービス設定を`workers.dev`に戻してcache purgeした後でのみ**Custom Domainを切断する。途中失敗時はドメインを接続したまま、同じ`domain remove`で再開できるようにする。対象hostnameは現在のサービスに登録されたものに限り、他Workerの設定を消さない。
- **`domain add`と`domain remove`を同じ公開ゲートに含める。** `remove`の安全な実装が間に合わない場合は`add`も公開しない。公開後に戻す手段のない片道移行にはしない。CloudflareのAdvanced CertificateはCustom Domain削除後も残ることがあるため、後片付け方法を案内する。
- `deploy`/既存workspaceでの`init`再実行でも既存のCustom Domainと正規URLを保持し、Workerの`workers.dev`を無効にしない。管理APIは回復できるよう`workers.dev`からも利用可能とし、token/秘密鍵はサービスTOMLに置かない。

### 設定と互換性

`public_base_url`を唯一の**サービス正規URL**として保持する。ただしCloudflare側の接続状態とR2/ローカルの公開設定は別々に変わるため、移行対象URL・元のURL・進捗を耐久的に記録する必要がある。具体的な状態形式・原子的更新順は設計ゲートで決める。未公開job IDや管理鍵は引き続きgit管理外、公開済みShowと移行進捗はローカル状態だけに依存させない。新しいTOML項目を追加する場合はstrictなZod schemaを維持し、v0.1.1の設定をそのまま読み取れるようにする。

## `domain add`/`domain remove`のURL移行

1. Cloudflare上のhostname所有、Active Zone、競合状態、既存サービスとの衝突を調べる。`add`ではCustom Domainを接続してTLS/公開HTTPを確認する。ここまでは既存feedとprimaryを変更しない。
2. 現在の公開Show一覧をR2から列挙し、公開中Showに未完了のShow/Episode jobがないことを確認する。**移行中は新規publicationの受付を止め、進行中のconsumerが書き終わるまで待つ。** 単にCLIでチェックするだけでなく、Workerの受付とconsumer側でも移行状態を尊重する。`processing`の受付を強制解放しない。staging自体は妨げない。
3. 移行の対象URLとShowごとの進捗を耐久化する。Show metadata/current Episode metadataから各feedを再生成し、feedに載せるenclosure URLは検証済みの**既存音源pathを新しいbase URLに結合して**出力する。既存のimmutable revision metadata/MP3は書き換えず、GUID/公開日時も変えない。移行後の音源なし改訂・新規公開も必ず新URLでfeedを出す。既存revision metadataの`enclosure_url`は履歴として旧URLのまま残り得ることを明記する。
4. ShowごとにfeedのR2書き込みとtag purgeを実施し、完了を記録する。部分失敗時には公開済みのfeedが一時的に新旧混在し得るため、操作を完了扱いにせず同じコマンドで再試行する。全feedとcacheの収束を検証後、R2 `system/service.toml`とローカル`castloop.toml`をprimary URLへ揃え、受付を再開する。順序と再実行判定は、設定の片方だけ更新された場合も検出・復旧できるように実装前に確定する。
5. `remove`では逆向きに同じ手順を行い、**`workers.dev`でのfeed/音源の応答とpurge成功を確認してから**独自ドメインを切断する。切断要求の応答を失った場合はCloudflare側を照会して再開する。

対象Showが0件の場合も設定移行を行う。多数Showの一括処理は進捗と再開可能性を備えるが、全Showを単一の原子的更新として見せることは約束しない。部分移行中に旧URLのfeedが読まれても音源が再生できるよう、`workers.dev`は維持する。

## 旧URL・Podcast directoryとredirectの意味

例えば既存の`https://worker.subdomain.workers.dev/podcasts/a/feed.xml`を購読中のアプリは、ドメイン追加後もそのURLを取得しに来る。**redirectなし**とは、その要求に対して`301/302`を返さず、同じWorkerが同じR2 feedを`200`で返し続けること。feed内の`atom:link`・画像・enclosureは新しい`https://podcasts.example.com/...`へ切り替わる。管理者はPodcast directory側のfeed登録URLも、新URLへ変更が必要かサービスごとの手続きに従って確認する。castloopはその登録を自動変更しない。既存クライアントが旧feed URLから自動的に新URLへ購読先を変更することは保証しない。

この方式なら旧URLからの取得は続くが、旧hostnameへのアクセスを新hostnameへ**強制的に転送する機能はない**。directory上の登録URL変更は管理者の作業とする。HTTP redirectや`itunes:new-feed-url`等の移転通知は今回実装しない。逆向きの`remove`後も接続が残る`workers.dev`を公開URLとして維持する。

## 実装マイルストーン案

### D0: 制約と移行プロトコルの確定

- APIのAttach/List/Detach Worker Domainと権限・zone参照、TLS準備確認方法、Freeプランの条件を調査する。検証専用のCloudflare Zone/WorkerでAPI tokenのみから動作を実測する。
- 正常作成、既存DNS/CNAME、別Worker接続、証明書待ち、API応答喪失を検証する。Route 53等を権威DNSとするzoneは対象外として拒否する。
- 公開ジョブとドメイン移行を衝突させない耐久的な受付制御、設定の同期、途中失敗と復帰のプロトコルを決める。既存の`processing` jobは安全に収束させ、無理に解放しない。

### D1: Worker domain接続と接続確認

- `domain add`の前半、`domain list`、同一hostnameの再実行時のCloudflare側reconcile、TLS/HTTPS確認を実装する。
- 登録済みhostnameの競合、zone不在、DNS衝突を明瞭に報告し、既存recordを勝手に置換しない。

### D2: URL切替と安全な復帰

- `domain add`成功時のprimary化・全Show feed再生成、同じ操作の再開を実装する。
- `domain remove`による`workers.dev`への復帰と安全なDetachを実装する。安全な復帰手段を完成できなければ、`domain add`を含めて公開を保留する。
- 既存Episode・音源未変更改訂・新しいEpisodeでのURL一貫性、cache purge失敗後の回復、CLI設定とR2設定の差異検出を検証する。

### D3: 受け入れと文書化

- API mock、既存設定の後方互換、複数ShowのURL移行・同時publication、feed生成の自動テストを追加する。
- 専用ZoneでCloudflare API tokenとLinux x86-64配布バイナリからadd→TLS→既存feed切替→追加公開→remove→旧URL復帰まで確認する。GET/HEAD/Range、feed/cover cache purge、MP3の内容一致、private R2を確認する。
- READMEにDNS切替の影響（Route 53既存recordの移行を含む）、必要なtoken権限、証明書待ち、途中失敗時の再開方法を明記する。管理端末にNode.js/npm、Bun、Wrangler、`ffprobe`、R2 S3 credentialsを要求しない。

## 受け入れ条件

- Custom Domain追加後も`workers.dev`が応答し、他Showの公開やprivate R2の隔離を壊さない。
- `domain add`が成功を返す時点でTLS/HTTP、すべての公開Showのfeed、ローカル/R2のprimary設定とcache purgeが新ホスト名へ収束している。`domain remove`成功時はその逆になっている。
- Feedの`atom:link`、cover、enclosureは正規ホスト名に揃い、Showの`site_url`、GUID、公開日時、immutable MP3/revisionは変わらない。旧revisionにある絶対URLが残っていても、新規publicationのfeedに旧URLを混入させない。
- feed/cover/audioのGET/HEAD、画像と音源のRange、cache purge、音源の内容一致を確認する。
- DNS衝突、TLS未準備、途中失敗、API応答喪失、公開ジョブ実行中の移行は安全に停止・再開できる。公開中の古いconsumerと競合したまま受付を再開しない。
- v0.1.1サービスの設定・公開済みShow/Episodeは後方互換。管理用の外部ツールや追加のR2認証情報を要求しない。

## 承認済みの方針

1. 独自ドメインは1サービスにつき1ホスト名。Showごと・複数ドメインは今回検討・実装しない。
2. 対象zoneの権威DNSはCloudflare必須。外部権威DNSを維持する方式は今回扱わない。
3. `workers.dev`はredirectせず`200`で配信を続け、Podcast directoryの登録URL変更は管理者が行う。
4. `domain add`と、`workers.dev`へ安全に復帰する`domain remove`を同じ公開ゲートに含める。

## Cloudflare一次資料

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) — 同一Workerへの複数domain、hostname全pathへの適用、DNS/TLSと既存CNAMEの注意。
- [Workers Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/) — account-scoped Attach/List/Detach。
- [Cloudflare DNS primary (full) setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/) — Free/Proを含む権威DNS構成。
- [Cloudflare DNS partial (CNAME) setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) — 外部権威DNSを維持するBusiness/Enterprise向け構成。
- [Cloudflare DNS subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/) — Cloudflareの独立subdomain zoneはEnterprise向け。
