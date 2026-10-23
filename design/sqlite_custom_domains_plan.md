# Issue #68: SQLite方式の独自ドメイン対応計画

作成日: 2026-10-24。状態: **開発中。外部同時変更は想定外として制約を記録する方針を管理者確認済み。API条件による保留は解消。** [P0の根拠・採用契約](sqlite_custom_domains_p0.md)を参照する。
対象Issue: [#68](https://github.com/simosako/castloop-v2/issues/68)。調査基点: v0.7.2 / commit `72bc9f084c3a8ec6b4532d2b4833ac9a47735932`。

本書は開発範囲・契約・実装順のレビュー用である。現行の「SQLite独自ドメイン未対応」は、実装・検証後に利用文書を更新するまで変わらない。本書の承認も、実Cloudflareへの配備・公開・Resume・DNS/domain/権限/課金変更・削除・証跡cleanupの承認にはしない。

## 1. 開発するもの

**現行のShow単位SQLiteサービスに、サービス共通の独自hostnameを1つ接続し、Feed・画像・音源の正規originとして使用する機能を追加する。** 接続だけでなく、照会、切断によるworkers.devへの復帰、途中停止の表示と限定的な続行までを同じ開発範囲とする。

推奨する初期仕様は次のとおり。

| 項目 | 提案 |
| --- | --- |
| 対象 | 対応版でfresh initしたservice schema 2 / `sqlite-sequential-v1` / `show-v1` |
| domain範囲 | 1サービスにつき1つの専用subdomain。全Showに共通 |
| Cloudflare製品 | 同じaccount内のactive/full Zoneに対するWorkers Custom Domains |
| 初期化 | 従来どおりworkers.devで初期化し、完了後に明示的にdomainを接続 |
| 管理origin | `workers_dev_base_url`へ固定。独自domainへ管理APIを公開しない |
| 公開origin | 独自domain未接続時はworkers.dev、接続後は独自domainから本文を配信。Feed内の正規URLは`public_base_url`に一本化 |
| workers.devの公開動作 | 接続後の許可済み公開URLは、同じパスの独自domain URLへredirectする方向で設計する。管理APIは転送しない |
| 接続・切断中 | 所属Showを個別にPause/drainし、各Showで原子的な保守拘束。無停止切替は保証しない |
| 完了時 | 各Showはpausedのまま。再開は管理者がShowごとに明示 |
| 設定変更方式 | code-only `deploy`とは別の、旧/新config hashを束縛した専用手順。Worker設定の再配備を含む |
| 中断対応 | 読取照合と、成功証拠がある段階からの未開始処理の明示続行。未知mutationの再送は不可 |

### 1.1 Cloudflareで管理する範囲

**DNSをCloudflareで管理していることが前提であり、ドメインの購入・更新をCloudflare Registrarへ移すことは前提にしない。**

- 例: `example.com`を他社で購入・更新していても、権威DNSをCloudflareへ向け、castloopのWorkerと同じaccountでactive/full Zoneとして管理していれば、未使用の`podcasts.example.com`を対象にできる。
- 他社の権威DNSにCNAMEだけを追加する構成は、今回の対応範囲外。既存利用者のnameserver変更やZone作成もcastloopが自動実行しない。
- 親domain全体をcastloop専用にする必要はない。既存のWeb・メール等のDNSはそのまま保持し、明示した未使用の専用subdomainだけを操作する。

### 今回は作らないもの

- Show別domain、複数domain、apex、wildcard、www alias、外部権威DNSのpartial setup、Cloudflare for SaaS。
- R2のpublic bucket/domain、別Workerへの転送、Queue/D1等の新規基盤。
- 旧Queue実装の復活、旧サービス/schema/layout/DB/journalの移行・変換、既存接続や未知資源の採用。
- `itunes:new-feed-url`、Podcast directoryの自動更新、購読者の自動移行保証。HTTP redirectは追加検討するが、これらまで自動実行する意味にはしない。
- 自動Pause/Resume、自動rollback、汎用の設定変更コマンド、blocked jobのretry/release。
- DNS recordや証明書の個別削除、音源・revision・旧Feed世代のcleanup。

## 2. 現行実装から分かった変更点

| 箇所 | 現状と必要な変更 |
| --- | --- |
| `packages/shared/src/sqlite-service.ts` | HTTPS originとworkers.dev identityを検証し、**公開URLを含む完全config**をhash化する。domain変更でもこの照合を維持する |
| `packages/cli/src/sqlite-cloudflare.ts` | fresh initの`preflight()`は公開URL＝workers.devを要求する。このfresh init制限は残し、別のdomain preflightを追加する |
| `packages/shared/src/sqlite-worker-deployment.ts` | `CASTLOOP_SQLITE_CONFIG`へ完全configを埋め込む。R2/ローカルTOMLだけを書き換えても実行設定は変わらない |
| `src/sqlite-worker.ts` | DO構築でも公開URL＝workers.devを要求する。対応するdomain設定を認めるが、service/管理origin/layoutの照合は維持する |
| `src/sqlite-gateway.ts` | 管理origin以外を一律404とする。公開originの許可と管理originの許可を分離する |
| `src/sqlite-runtime-update.ts`、`src/sqlite-publication-queue.ts` | code-only更新はconfig hash変更を拒否する。この拒否を緩めず、専用の設定変更準備・activationを追加する |
| `src/sqlite-service-control.ts`、`src/sqlite-show-service.ts` | 所属固定・Show別prepare/activation/解除の基盤がある。domain変更との相互排他、旧/新config、Show別の部分完了を追加する |
| `src/feed.ts`、`src/media-url.ts` | 指定baseからFeed自己参照・cover・enclosure URLを構築できる。revision本文を変更せず再生成できる |
| `src/sqlite-feed.ts`、`src/sqlite-publication-content.ts` | Feedは不変世代snapshotで、現在は公開job sequenceを世代に使う。domain専用の再生成にも衝突しない採番が必要 |
| `src/sqlite-service-runtime.ts` | readiness probeはR2 `system/service.toml`、SQL runtime、同version cache ownerのconfig一致を確認する。新configで再検証が必要 |
| CLIのエージェント向け契約 | help/describe/schema/JSON外枠/doctorにも新コマンドと途中状態を反映する |

したがって、既存の等値制約を削除してdomain APIを呼ぶだけでは完了しない。**設定identityの切替、Show別のFeed切替、共有変更の完了判定**を一緒に設計する。

## 3. URL・配信・データの契約

### 3.1 管理と公開を分ける

- CLIの管理鍵は正確な`workers_dev_base_url`だけへ送る。Cloudflare tokenはCloudflare RESTだけへ送る。
- 管理通信とdomain到達確認はredirectを追わない。独自domainへのfallbackやTLS検証無効化をしない。
- gatewayは最初にURLのoriginと経路を分類する。`/admin/`はworkers.devだけを許可し、独自domain・未知originではDOの管理処理へ転送する前に404/no-storeとする。
- 公開originのallowlistはWorkerの検証済み設定から構築し、クライアントの`Host`補助header、query、`Origin`、`X-Forwarded-Host`から追加しない。未知originは404/no-store。
- 独自domainを設定しても、通常配信の可否は対象Show DOの最新判定だけで決める。制御DOへの毎回照会、配信gateのTTL cache、サービス全体のPause状態を追加しない。
- パスは現行のFeed/cover/承認済みaudioだけ。`system/`、`staging/`、metadata、内部世代パスは公開しない。
- GET/HEAD/単一Range/ETag/日付条件と外向け再検証headerを維持する。認証header/cookie/queryはcache ownerへ渡さない。
- Pause/readiness/保守拘束/非公開/lifecycle/blockedの既存gateを両originに同じく適用し、warm cacheでも迂回させない。
- workers.devの公開URLからのredirectも、対象Showの最新配信許可を確認した後だけ返す。停止・非公開・未承認パスを先に転送しない。転送先の独自domainでも通常の配信判定を行う。

### 3.2 正規URLの変更範囲

変更するのはFeedの`atom:link rel=self`、画像URL、enclosureのoriginである。公開パスは変えない。

維持するもの:

- GUID文字列、`isPermaLink`、公開日時、Episode ID、revision ID・履歴。
- MP3 payload/key/hash/size、承認済みの過去音源、cover payload/世代/identity。
- 保存済みrevisionの`enclosure_url`を含む本文、Show metadataと`site_url`、lifecycle。

既存音源pathを新しいbaseへ組み直す現行helperを利用し、過去revisionの絶対URLを一括置換しない。URL形式のGUIDも識別子として維持する。今後のpublish/restore/一覧/RSS公開後検証でも、現在の正規baseからURLを導出することを確認する。

workers.devの旧公開URLは、明示Resume後に独自domainへredirectする方向へ初稿から変更する。切断した独自hostnameの旧URLは継続保証しないため、管理者によるdirectory登録変更・利用者への案内が必要である。「設定変更完了」を「購読者移行完了」と表示しない。

### 3.3 旧workers.dev URLからのredirect案

転送方向は**旧workers.dev → 新しい独自domain**であり、独自domainからworkers.devへ戻す意味ではない。

```text
接続前:
  https://service.account.workers.dev/podcasts/show/feed.xml → Feed本文

接続・切替完了後、対象Showを明示Resume:
  https://service.account.workers.dev/podcasts/show/feed.xml
    → https://podcasts.example.com/podcasts/show/feed.xml → Feed本文

管理API:
  https://service.account.workers.dev/admin/... → 従来どおり管理処理、redirectなし
  https://podcasts.example.com/admin/... → 404
```

P0で確定する詳細案:

- **Feedは301を第一候補**とする。AppleのFeed URL変更案内も301を使用する。ただし同案内は`itunes:new-feed-url`と4週間以上の維持も求めており、301単独で全購読者が移行すると保証しない。
- cover/audioの旧URLも同じパスの正規URLへ転送する案を検討する。これらを購読先の恒久移行と同一視せず、301/307等のstatusとクライアント互換性をP0で確定する。
- 対象は検証済み公開パスのGET/HEADだけ。許可前に3xxを返さず、管理APIや不正なmethod/パスには適用しない。転送応答は`Cache-Control: no-store`とし、独自domainからは本文を返して転送ループを作らない。
- `Location`は検証済み`public_base_url`と承認済みパスだけから構築する。任意の転送先・入力query・資格情報を引き継がず、内部fetchで管理header等を独自domainへ送らない。
- workers.dev側の最初の応答は3xxとなる。Range/ETag/日付条件の200/206/304等は転送先で成立させ、HEADは本文を返さない。クライアントの転送追従と条件headerの扱いを試験する。
- 切断完了後はworkers.devから本文を配信する設定へ戻す。ただし、**301を記憶した購読アプリが引き続き独自domainへ直接アクセスすることは取り消せない**。独自domain切断は購読先の自動復帰ではない。切断時に影響を警告し、旧独自domainの維持期間・移行案内が必要かをレビューする。
- 301の記憶と即時切断の両立に制約があることを示し、可逆性を優先する307案との比較をP0に含める。`no-store`だけで購読アプリの購読先保存まで防げるとは扱わない。

接続直後・保守中・pausedのときはredirectを有効にせず、既存gateによる503等を維持する。全体切替と保守解除後も明示Resumeが必要である。

## 4. 設定・永続状態・排他

### 4.1 設定の正とidentity

- ローカルTOMLを編集元、R2を設定snapshot、Worker bindingを実行設定、DOを変更進行の正本とする。
- service TOMLは引き続き`public_base_url`と必須`workers_dev_base_url`を使う。Zone/domain IDや操作phaseは運用記録へ置き、秘密を設定へ追加しない。
- 変更可能な設定差分は`public_base_url`だけとする。account/service/Worker/bucket/管理origin/layout/protocolは不変。
- `public_base_url`をhash対象から除外したり、旧/新hashのどちらでも通常要求を受け付けたりしない。
- 旧config・目標config・双方のhash、対象namespace、旧runtime、送信source/metadata hash、操作ID、hostname/Zoneを送信前に凍結する。Cloudflare発行のdomain IDと配備receiptは対応する成功応答後に追記し、別の結果への置換を禁止する。
- config変更には同じ対応版Workerの再配備が必要。通常`deploy`は従来どおり同config限定で、domain接続は保持・照合するが作成/削除しない。

### 4.2 制御DOとShow DO

| 保存先 | 追加する情報・責務 |
| --- | --- |
| 制御DO | 現在の既知domain接続receipt、凍結した変更要求、所属集合、Showごとのprepare/Feed/activation/probe/解除結果、全体phase |
| Show DO | 正確な変更要求と旧/新identity、Resume禁止の保守拘束、開始時のcontent/Feed/cover/lifecycle根拠、候補Feed世代・検証結果、変更完了記録 |
| `.castloop/` | 新規の`sqlite-domain-changes` journal、Cloudflare mutationの送信開始と成功receipt、ローカル設定同期状態、既存方式の排他lock |
| R2 | 設定snapshotと不変Feed候補。lock/token/status/progressの正本は置かない |

domain変更・code-only更新の未完了操作は、**制御DOの同じ共有保守排他**で競合させる。別々のmarkerを非原子的に確認して通過する設計にしない。Show登録中や未知初期化があれば共有変更を開始せず、変更中は新規登録と他の共有変更を拒否する。

各Showのpaused/drained確認と保守拘束は同じShow DO transactionで保存する。先にGETで確認して後から拘束する方式にしない。未拘束ShowのResumeが先に成立した場合はそのShowのprepareを拒否し、配備へ進まない。既に準備したShowの部分状態は保持する。

新規形式はfresh環境専用とし、必須のdomain変更能力識別と専用schema versionを定義する。旧/欠落/未知形式は変更準備・配備前に拒否する。旧DBへ後付けして採用・変換する経路は作らない。service schema 2、`show-v1`、既存DO/cache class名・binding・compatibility dateは維持する。

### 4.3 新config配備直後の扱い

新Workerの実行configと、まだactivationしていないDOの保存configは一時的に異なる。この不一致は専用の凍結prepared要求でだけ説明できるものとする。

- `selectSqliteRuntime()`等に、完全一致するdomain変更準備の検証経路を追加する。任意のhash差分を許可する一般例外にしない。
- その経路でも通常受付・配信・Resumeは閉じる。専用statusは保存済み旧identityと実行中の目標identityを区別して報告する。
- 制御DOだけが新version/configになっていてもactivationしない。固定した全Showが正確な新native version/configと旧prepared状態を示すまで有限の読取観測とする。
- 部分activationでは、Showごとの旧/新identityとphaseを専用statusで検証する。一律の旧hash照合で照会不能にしたり、混在を全体readyとして隠したりしない。
- runtime/configのSQL切替はShow内の短いtransactionで行う。設定変更専用の許可条件を設け、code-onlyの`changeRuntime()`の条件は緩めない。

### 4.4 個別Pause/drainと再配備の意味

これは、**domainを切り替える間に、公開中の更新処理や配信が新旧の設定を混ぜて使わないよう、一時的な停止時間を設ける**という提案である。

1. 管理者がサービス内の各Showを個別にPauseする。Pauseは新しい公開要求と公開配信を止めるが、既に受け付けた公開jobは取り消さない。
2. 各Showで既受付jobの終了を待つ。これがdrainであり、queued/running/blockedが残っていない状態を指す。blockedがあればdomain変更へ進めない。
3. domain変更処理が各Showに保守拘束を保存する。これは途中で別のCLI等がResumeして切替と競合することを防ぐためで、全Showの準備が完了してから共有設定を変更する。
4. 公開URLはWorkerの埋め込み設定にも入っているため、新設定で同じ対応版Workerを再配備し、各ShowのFeed再生成・purge・設定/readiness確認を行う。音源やrevisionを作り直す意味ではない。
5. 全対象の確認後に保守拘束を解除するが、Pause状態は維持する。管理者が各Showを明示Resumeして初めて、新URLで配信・redirect・通常受付を再開する。

「全体Pauseを追加しない」は、サービス全体を一括で止めたり一括で再開したりする新しい状態・コマンドを作らない意味である。ただし**今回のdomainは全Show共通なので、切替には結果として全Showの停止が必要**となる。Showが1つならその1つ、複数なら全対象を個別に停止・確認する。無停止切替や自動再開は本案に含めない。

## 5. Feed再生成とcache

1. 保守拘束後、各Show自身の確定SQLから現在のmetadata、cover参照、公開Episode集合を読む。ローカルの未公開編集やR2列挙から再構築しない。
2. 公開済みShowだけ、目標baseで新しい不変Feed snapshotを生成する。非公開Showは公開せず、draft/非公開/削除Episodeを復活させない。Showが0件の場合も設定変更は成立させる。
3. 現行の件数・文字数・生成予算を適用し、hostnameが長くなった場合のURL増分も検証する。書込前に確定できる全Showの入力不正は、可能な限り外部mutation前に検出する。
4. Feed世代の採番を、公開job sequenceの直接流用から独立した**Show内の共通単調増加allocator**へ集約する。通常publish/lifecycle/domain再生成が同じallocatorを使い、同じ世代/keyを再利用しない。公開jobのFIFO sequenceは別のまま維持する。
5. この採番変更に必要なqueue/contentの形式識別と、executor/commit時の対応する世代照合を更新する。cover世代やrevision IDをFeed世代から導出しない。
6. R2 bindingの条件付き保存とkey/size/checksum検証を経てから、既存のShow単位cache invalidationで必要なFeed/cover purgeをawaitする。
7. 正確な保守要求・旧content/Feed/cover根拠を再照合し、Feed pointerと当該段階の完了を同じSQL transactionで確定する。通常publishを偽装する要求や、架空のEpisode revisionを作らない。

全Showの一括分散transactionは作らない。途中でShow Aだけ新Feedへ切り替わっても、Show Bの未完了を隠さず、全対象の確認が終わるまで保守拘束を解除しない。新旧snapshotは保持し、部分失敗後の再PUT・自動rollbackを行わない。

cache ownerは現行のoriginに依存しない内部URLと検証済み世代propsを使えるか確認し、正規originで確定内容を返す。workers.dev側は最新gateを確認してからredirectし、本文cacheで転送判定を代替しない。遅い旧cache fillが新Feedへ混入しない世代分離を維持する。外部podcast app等のcache破棄までは保証しない。

## 6. 接続・切断の手順

以下は実装する順序の提案であり、現在実行できる運用手順ではない。

### 6.1 接続

1. **事前確認**: 対象・設定・対応能力・既知の配備・既存接続・Zone/DNS/routesを読取確認。全Showの個別Pause/drainを要求し、source/configと要求を凍結する。
2. **共有prepare**: 制御DOで所属集合と変更要求を固定し、Showごとに送信開始を保存して、原子的な保守拘束とFeed生成の事前検証を行う。全対象確認前にはCloudflare mutationへ進まない。
3. **Custom Domain接続**: 送信開始をjournalへ耐久保存してから、固定hostname/Zone/Workerへの接続を1回だけ要求。完全に検証した成功応答のdomain ID・接続先を保存する。
4. **DNS/TLS待ち**: 接続先をRESTで再照合し、CLIから資格情報なしの通常HTTPS HEADで証明書/hostname検証と到達確認を行う。未準備なら待機状態で停止する。
5. **設定snapshot更新・配備**: R2設定の目標内容を保存・検証し、目標configを埋め込んだ同じ対応版Workerを配備する。PUT成功checkpointを後続GETより先に保存し、version/deployment/ETag/namespace/settingsを照合する。
6. **新native確認とShow切替**: 全DOの正確な新runtime/config到達を確認後、未開始のactivationを行う。各ShowのAlarmで不変Feed生成・purge・pointer切替と新configのreadiness probeを行い、全件の完了を確認する。
7. **同期・完了**: remote/R2/Worker/各Showの目標設定と接続を照合し、ローカルTOMLを安全に同期する。その成功後に専用finalizeを送り、Show別の保守拘束解除を確認して完了する。各Showはpausedのままで、明示Resume後に旧workers.devの公開URLから正規独自domainへのredirectを開始する。

### 6.2 切断

1. 301を記憶した購読アプリ等への影響と、切断後の独自domain継続配信は保証しないことを事前に案内する。接続と同様に個別Pause/drain・共有prepareを行い、目標`public_base_url`を保存済みworkers.devへ固定する。
2. **先に**R2/Worker設定を更新し、全対象ShowのFeedをworkers.dev正規URLへ再生成・purgeする。新runtime/config/readinessとworkers.devへの到達、ローカル設定同期まで確認する。
3. 既知の接続receiptと一致するaccount/Zone/hostname/Worker/domain IDだけを再照合し、送信開始を耐久保存してからDELETEを1回だけ行う。成功応答を検証・保存するまでは切断完了にしない。
4. 保守拘束の解除を全対象で確認し、pausedで完了する。明示Resume後はworkers.devから本文を配信し、新しいredirectは返さない。音源・revision・cover・Feed履歴は削除しない。証明書は残し、残存を照会結果・文書で案内する。

切断準備後の新Workerは旧独自originを公開allowlistから外す。DELETE未完了でもそのoriginから管理APIやコンテンツを配信せず、切断の未知結果は別の未完了状態として保持する。

### 6.3 DNS/TLSの確認を公開許可と混同しない

旧`/.well-known/castloop/runtime`や旧unsigned nonce probeは復活させない。通常HEADで確認するのはDNS/TLS到達だけであり、停止中のFeedを200や3xxにする例外は設けない。ShowのFeedなら503、未知パスなら404が正常にあり得る。到達確認用HEADはredirectしない既知の経路を使い、通常の公開redirectと混同しない。

**HEADのstatusだけでは対象Worker identity・配信ready・切替成功を証明しない。** それらはCloudflareの正確な接続/配備receiptと、workers.dev上の認証済み管理照会による全DOの証拠で確認する。TLS失敗・redirect・接続先不一致では先へ進まない。通常DNSを使い、OS DNS変更や独自resolver/proxyの自動設定を追加しない。

## 7. Cloudflare APIの安全条件

- hostnameは小文字化したASCII DNS名を厳密に検証する。scheme/path/port/credential/query/fragment/wildcard/IP/非対応IDNを拒否し、Zone境界はラベル単位で確認する。
- 対象accountに属するactive/full Zoneと、新規専用hostnameを要求する。既存DNS record、委任、干渉するWorker routes、別Worker接続、同Workerの出所不明な接続も採用・上書きしない。
- account-wide domain一覧とZone/DNS/routesのpaginationを最後まで確認する。権限不足・読取失敗・未完了paginationを「接続なし」にしない。想定外の複数接続は照会で全件報告し、変更操作は拒否する。
- 接続はWorkers Custom Domains RESTを使用する。DNS/TLSはCloudflareによる自動管理に任せ、独自のA/AAAA/CNAME作成・削除や証明書操作は行わない。
- 公式Attach APIの現行仕様にはCAS/条件付き作成の保証が記載されていない。**事前GETだけを競合保護の証明にしない。** P0で既存接続/DNSへの挙動と使用APIの非上書き条件を確認する。
- domain変更中の同じhostname/対象Worker接続に対するdashboard/他ツールからの同時変更は、管理者確認により想定外とする。この制約を利用ガイドへ記載し、専用の競合対策や確認フラグは追加しない。外部同時変更を原子的に防ぐ保証はしないが、検出済みの既存資源は採用・上書きしない。
- mutationは自動retryしない。例外、応答本文喪失、不正JSON、identity不一致、receipt保存失敗では未知結果として保全する。後のGETで存在/不在が見えても成功receiptに昇格しない。
- DELETE専用parserを用意する。公式の成功envelopeを厳密に検証し、`null`をdereferenceしない。旧Issue #7の互換許容を無条件にコピーせず、204/200-null等を許容する場合は根拠と個別テストを先に追加する。不正な成功応答を無条件成功へ変換しない。
- 必要権限をAPIごとに列挙し、domain変更を使わない利用者へ追加権限を要求しない。token権限の自動拡張、Paid移行、証明書削除権限の追加を行わない。

## 8. CLI・管理API・途中停止

### 8.1 提案するコマンド

```text
castloop domain add podcasts.example.com --zone-id ZONE_ID --operation-id UUID --workspace PATH
castloop domain list --workspace PATH --json
castloop domain status UUID --workspace PATH --json
castloop domain continue UUID --workspace PATH
castloop domain remove --operation-id UUID --workspace PATH
```

- `add/remove`は新規の固定要求を開始する。再実行で中断操作を暗黙再開せず、保存済み状態と次の確認手段を返す。
- `list`は接続全件、正規/管理origin、config/接続不一致、未完了操作を読む。`status`は操作と各Showの部分状態を読む。両方ともremote mutationを行わない。
- `continue`は**変更を含み得る**明示操作。単なるstatus確認とは区別してhelp/JSONに表示する。現在の証拠で許された未開始段階だけを進める。
- ローカル設定だけの同期も`continue`で扱うが、元configまたは既に同一の目標configであることを確認し、無関係な編集を上書きしない。保存は既存のatomic replace/fsync/lockを再利用する。
- `--json`、`--workspace`、help/describe、終了code、固定診断code、エージェント向け`next_actions`を現行CLI規約に合わせる。未知結果の次アクションに再送・強制解除・Resumeを出さない。

管理APIはworkers.dev上の専用domain変更endpointとし、prepare/status/activate/finalize等の要求をstrict schemaで定義する。読取GETのallowlistと有限予算を更新し、通常publishやcode-only updateの要求型を流用して設定変更を隠さない。

### 8.2 状態と続行範囲

全体phaseとは別に、各mutation/各Showの`pending`・`requested`・`confirmed`を保存する。全体phaseだけから「まだ送っていない」と推測しない。

| 状態・停止位置 | 許す対応 |
| --- | --- |
| 送信前の入力不正・非対応・競合 | 拒否。外部mutationなし。保守準備を開始済みなら部分拘束を明示 |
| 接続成功receipt保存済み、DNS/TLS未準備 | 読取確認を再開し、その後の未開始処理へ進める。接続PUTは繰り返さない |
| 配備PUT成功checkpoint保存済み、REST/native観測停止 | 同じreceipt/source/metadata/旧新configを再照合し、GETと未開始activationだけ続行。再配備しない |
| Feed/設定書込またはpurgeの結果不明・途中中断 | 該当Show/共有変更をblockedで保持。再PUT・再生成・purge再送で隠さない |
| 一部Showだけ完了、残りは未開始 | 完了済みは読取照合。全送信済み要求の終結が証明できる場合だけ、未開始分へ進める |
| requestedだが応答不明のprepare/activation/finalize/解除 | 正確な同一要求の耐久完了証拠があれば読取照合。存在しなければ再送・解放せず保持 |
| 接続/切断/配備/設定PUT自体の成功証拠なし | 変更結果がGETに見えても採用・再送しない。時間経過や不在観測で解放しない |
| remote切替済み、ローカル設定だけ未同期 | 正確なremote完了証拠と旧/目標ローカルconfigを照合し、ローカル同期のみ行う |
| 全remote処理済み、CLI最終応答喪失 | GETで全Show・設定・接続・解除完了を確認し、ローカル完了記録だけ確定 |

再起動やAlarm再配送で残ったrunning処理は再実行しない。通常jobのblockedとdomain保守のblockedを区別して表示する。どちらも時間切れlease、token奪取、残存lock削除による復旧を提供しない。既存のpurge rate-limit対策を使う場合も、同じ既知running内の明確な拒否への有限待機に限定する。

## 9. 開発順とレビュー区切り

| 段階 | 作業と主な対象 | 完了条件 |
| --- | --- | --- |
| P0 契約確定 | API衝突/応答/権限の根拠、旧新hash遷移、状態表、能力/schema識別、世代採番、redirectの対象/status/切断時の影響を具体化 | 停止手順・redirect詳細を合意。APIの非上書き条件等に未解決があればP1へ進む前に再レビュー |
| P1 shared・永続基盤 | 新規`packages/shared/src/sqlite-domain.ts`、DOの専用domain状態、共有保守排他、Feed世代allocator | strict schema、transaction rollback、永続再読込、旧形式拒否の単体試験 |
| P2 Worker設定切替 | `sqlite-worker.ts`、`sqlite-runtime-update.ts`、queue/runtime/control/show service、専用管理HTTP | 全Showの正確なprepared/native/activation/probe/解除、部分失敗とResume競合を模擬DOで確認 |
| P3 Feed・配信 | gateway、公開redirect、Feed再生成、content/世代key/commit/cache、通常publish/lifecycleの採番接続 | 正規originの配信・旧URL転送と停止gate、private/admin拒否、identity維持、purge-before-commit、遅い旧fillの分離 |
| P4 REST・journal | 新規`packages/cli/src/sqlite-domain-cloudflare.ts`、`sqlite-domain-journal.ts`、`sqlite-domain-operation.ts`等 | 接続/切断/配備の成功checkpoint・未知応答非再送、TLS待ち、入力凍結とローカル同期 |
| P5 CLI統合 | `index.ts`、help/describe/schema/JSON/doctor、通常deployの接続保持検査、正式entrypoint試験 | add→status/continue→removeの模擬walkthrough、独自domain上の通常publish/restore/deployの回帰 |
| P6 文書・全体検証 | 利用/設計文書、feature template、単一CLI build | `bun test`、`npm run check`、Linux CLI buildとローカルwalkthrough成功。実機未確認範囲を明記 |
| P7 実機受け入れ | 対象・hostname・許可操作を別途承認した新規隔離環境だけ | DNS/TLS、両origin、cache、共有設定変更、切断復帰を確認し、証拠と限界を保存 |

ファイル名は責務を示す案であり、既存helperを再利用して重複を避ける。巨大な汎用設定変更frameworkや新しいlint/formatterは追加しない。P1/P2の詳細化で本書の安全条件・対応範囲を変える必要が出た場合は、先に差分をレビューする。

### 9.1 現在の実装範囲

- P0の公開REST採用と外部同時変更の制約を確定した。同じ対象への並行したdashboard/他ツール操作は想定外とし、この点を開発の停止条件や追加確認フラグにはしない。
- `packages/shared/src/sqlite-domain.ts`に、専用hostname/Zone、旧・新の完全config、runtime/namespace/source/metadata hashを束縛するstrict要求schemaとhash検証を追加した。切断では既知のdomain ID・接続receiptも凍結する。変更できる設定は公開originだけで、旧版/schema/layoutの採用は許可しない。
- `src/sqlite-gateway.ts`に、正規公開originを明示した場合の管理origin分離とredirectを追加した。Feedは301、cover/audioは307で、対象Showの最新許可と論理key一致を確認した後だけ返す。query・認証情報を転送先へ組み込まず、正規originのHEAD/Range/条件付き配信を維持する。
- **まだ独自domain機能全体は利用できない。** 本番Worker入口は引き続きworkers.devだけをgatewayへ指定する。DOの設定切替・所属固定/保守排他・不変Feed再生成/世代採番・Cloudflare REST client・CLI/journalは未接続で、既存のconfig等値制約や形式を緩めていない。これらの完成前に対応済みとして公開しない。
- 新規schemaとgatewayの単体試験、既存回帰、型検査、Linux単一CLI buildで検証する。模擬試験は実機API/DNS/TLS/rolloutの証明ではない。
- この基盤変更時点のローカル検証: `bun test`は**593 pass / 0 fail**（71 files）。`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`も成功。実Cloudflare環境は変更していない。
- Feed世代予約表を通常publish/lifecycleの受付・実行・commitへ接続した。domain用予約と同じ単調増加空間を使い、job FIFO sequence・cover世代・revisionは独立して維持する。新queue/content schemaは6/7、必須health識別は`feed_generation_allocator="reservation-v1"`。旧環境を変換せず、旧識別のWorkerは配備前のhealth照合で拒否する。

## 10. 受け入れ条件と試験

- [ ] 接続・照会・切断・状態確認・限定続行の契約とfresh専用境界があり、旧Queue/layoutへfallbackしない。
- [ ] 正規originのFeed/cover/audioでGET/HEAD/Range/ETag/日付条件が動作する。旧workers.devの許可済み公開URLは同じパスの独自domainへ転送し、転送先で同じHTTP機能が動作する。独自domain未接続・切断後はworkers.devが本文を配信する。
- [ ] redirectの対象/status/Location/cache方針を確定し、転送ループ・任意転送先・query/資格情報漏洩を防ぐ。管理API・未知origin・内部/未承認パスをredirectしない。
- [ ] 管理鍵/token/cookieが独自domain・redirect先・cache ownerへ漏れない。TLS検証を省略しない。
- [ ] 両originのcold/warm cacheと条件付き要求でも、Pause/readiness/保守/非公開/lifecycle/blockedのgateを維持する。許可前に3xx/Locationを返さず、停止中はredirectしない。
- [ ] 複数Show、Show 0件、Episode 0件、非公開Show/Episode、draft、保存済み過去revisionを含め、GUID/日時/audio/cover/revision履歴が不変である。
- [ ] 新Feed内の自己参照/画像/音源は目標originで、保存済みrevision本文は不変。hostname長増加を含む生成予算を守る。
- [ ] 通常publish/lifecycle/domain切替のFeed世代が衝突せず、遅い旧PUT/fillを新世代へ採用しない。
- [ ] Feed保存・purge・SQL commitの各境界で故障注入し、purge失敗を再書込で隠さず、完了・Resumeを誤許可しない。
- [ ] 共有deploy/domain変更/Show登録/個別Resumeの競合、部分prepare/activation/probe/解除、再生成・Alarm再配送を試験する。
- [ ] DNS/TLS未準備、REST/native反映待ち、pagination途中失敗、別Worker/DNS/routesとの競合を正しく停止・表示する。
- [ ] PUT/POST/DELETEの送信前後・成功応答保存前後・本文喪失・不正応答・lock残存を試験し、未知結果を再送しない。
- [ ] R2/Worker/DO/ローカルの部分同期を区別し、ローカルの無関係な編集を上書きしない。成功済みreceiptも勝手に置換しない。
- [ ] 切断前に全Feed/設定をworkers.devへ戻し、切断対象を正確に照合する。切断後の新規要求にredirectを返さず、購読アプリが記憶した301の取り消しは保証しないことを案内する。証明書や既存DNSの個別削除を行わない。
- [ ] 独自domain設定後の通常publish/restore/RSS公開検証/code-only deployを確認し、接続や既存mediaを保持する。
- [ ] 単一配布CLIのhelp/describe/JSON/正式コマンド経路から一連の操作を検証できる。

ローカルは既存のBun SQLite・模擬R2/Cache/Cloudflare RESTと独立CLI processを使う。実機のDNS/TLS・Custom Domain API応答・native rollout・DO output gate・Workers Cache purge・性能/Free適合の証明とは分ける。コードを変更した段階では`bun test`・型検査・影響するCLI buildを実行する。

実機試験は専用の新規隔離サービスと専用subdomainを別途承認してから行う。保持サービス`sq16r-6ec01dc6`、非テスト`otftalk.com` DNS、共有証明書、ローカル原本/journal/私有証跡は対象外。異常時は後続mutationを止め、削除・cleanupも別承認とする。

## 11. 実装後に更新する文書

- `README.md`、`docs/sqlite_sequential_development.md`: Cloudflare権威DNSとRegistrarの区別、対応範囲、必要権限、個別Pause/drain・再配備・再開、通常deployとの区別。
- `docs/custom_domains.md`: 現行SQLiteガイドへ更新。旧Queueの手順は固定したv0.5.x文書へ誘導し、混在させない。
- `docs/custom_domain_live_acceptance.md`: 旧Queueの受け入れ実績と区別したSQLite専用手順。実機承認前に作成する。
- `design/initial_design.md`、`design/README.md`、共有更新/Feed世代/復旧の関連設計: 新契約と未提供範囲。
- `docs/agent_usage.md`、組み込み管理者Skill/コマンド説明: 承認境界、状態照会、危険な再送を勧めない次アクション。
- `.github/ISSUE_TEMPLATE/feature_request.yml`: 「SQLite独自ドメイン未対応」を実装後の保証範囲へ変更。
- リリース時の`CHANGELOG.md`・リリースノート: fresh専用境界、切替時の停止、公開redirectの方向・対象・status、切断時の制約と購読者移行非保証、実機未確認事項。

現時点では、これらの利用文書を「対応済み」へ先行変更しない。

## 12. レビューの確認状況と残る判断

| 項目 | 確認状況・次の判断 |
| --- | --- |
| 初期範囲 | **確認済み**: 1サービス1専用subdomain。apex/複数domain/Show別domainは対象外。Cloudflare権威DNSが前提で、Registrar移管は不要である点を§1.1で補足 |
| 停止を伴う切替 | **確認済み**: §4.4に、個別Pause → 既受付jobのdrain → 保守拘束 → 再配備/Feed切替 → 個別Resumeを記載。全Show共通domainのため切替中は全対象が停止する |
| 旧URL方針 | **実装契約確定**: 旧workers.dev → 新独自domain。Feed 301、cover/audio 307、最新配信gateを優先する。切断時に購読アプリの記憶済み301は取り消せない。管理APIは転送しない |
| 導入境界 | **確認済み**: まだ本番運用前のため旧版移行機能は不要。対応版でfresh initした環境だけを対象とし、既存schema/資源/journalを採用・変換しない |
| 中断時の保守性 | **確認済み**: TLS/読取待ち・成功証拠のある未開始段階だけ続行し、未知mutationやpurge/書込blockedの自動修復は提供しない |
| 実装開始の区切り | **確認済み**: P0で詳細化し、Cloudflare APIの非上書き条件等に未解決があれば再レビューしてからP1以降へ進める |

停止手順とredirectを実装する方向は管理者確認済みで、開発開始の指示を受けた。P0でFeed 301・cover/audio 307を実装契約とする。APIの外部同時変更は想定外として制約を記録し、開発を進める判断を確認済み。確認済み項目まで再承認を求め直したり、未記載のAPI原子性を保証したりしない。

## 参照

- 現行契約: [全体設計](initial_design.md)、[Show分離](do_show_separation_options.md)、[SQLite公開](sqlite_sequential_publication_implementation_plan.md)、[Worker更新の復旧](sqlite_worker_update_recovery.md)、[Show更新・不変Feed/cover](show_update_feed_availability_plan.md)。
- 過去の参考: [旧domain計画](archive/custom_domain_plan.md)、[Issue #6: Pause中の配信](https://github.com/simosako/castloop-v2/issues/6)、[Issue #7: DELETE応答](https://github.com/simosako/castloop-v2/issues/7)。旧方式の実装・承認・実機実績を今回へ流用しない。
- Cloudflare一次資料（2026-10-24確認）: [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Attach](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)、[Detach](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/)。Custom DomainはDNS/TLSを自動構成し、切断しても関連証明書は自動削除されない。料金・全Free適合・APIの未記載の原子性は推測で保証しない。
- redirectの参考: [Apple Podcasts: Change the RSS feed URL](https://podcasters.apple.com/support/837-change-the-rss-feed-url)（2026-10-24確認）。301と`itunes:new-feed-url`を4週間以上維持する案内。今回の301案を、同手順全体の自動実行や全アプリの移行保証へ拡大しない。
