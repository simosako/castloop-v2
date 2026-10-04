# 独自ドメイン対応 実装ログ

## 2026-10-04: domain CLI・ローカル同期と限定的な復旧の接続

開発buildの`domain add HOSTNAME`・`domain list`・`domain remove`を正式CLI entrypointへ接続した。既存のservice-pause/resumeを使い、操作完了後もpausedのままにする。別のdomain deploy、consumer、Show lock、汎用状態機械は追加していない。

- 1つのURL変更runnerから両方向のfeed/cache/R2同期を呼ぶ。addは接続と秘密を送らないHTTPS probeを先に確認し、removeはworkers.devへの収束後に一致するdomain IDだけを切断する。通常deployは接続を保持する既存経路のまま。
- `createLocalJournalStorage`の保存・fsync・exclusive lockを再利用した。TOML同期も同じ同期書き込みhelperを使い、rename前後のsource/target hashとローカル編集を確認する。無関係な編集、違う固定要求、異なるreceipt、unknown lockは上書きしない。
- 接続API成功のreceiptをlocalに保存してからremoteへ渡す。TLS待ちや確認済みのpurge失敗は同じコマンドで続行する。管理API応答喪失は、固定要求とsettledなremote receipt/progressで確認できる場合だけ続行し、RESTを繰り返さない。
- connection claim後の応答生成失敗やreceipt-returnのCAS競合でも、claim/returnのpendingとexact tokenを失わない。確認済みreceiptと一致するtokenだけを返す明示続行を検証し、エラーを理由に未知のconnection/Worker IOを解放しない。
- Cloudflare PUT/DELETEそのものが不明ならconnection tokenとpendingを保持する。読み取りで想定接続が見えてもtokenを返さない。これは万能な外部IO復旧を追加しないというMVP範囲を維持するもので、応答喪失の安全をCloudflare保証として扱わない。
- listは接続の全件・正規/管理URL・設定不一致・admission・unfinishedなlocal操作/lockを読み取り専用で返す。想定外の接続を隠さず、add/removeは採用を拒否する。操作記録は必要な小さな固定要求/receiptだけを保持し、秘密やコンテンツ診断文を複製しない。
- CLI/管理API間の変更箇所を既存M6 fixtureで検証した。両方向、秘密の送信先、読み取り不変、TLS待ち、purge失敗、管理receipt喪失、実行中/未知REST、設定片側更新、lockと不一致を確認した。formal CLIの引数/helpとlistのREST GET接続も検証した。既存lifecycle/300 MB試験を別の大規模試験群へ複製していない。

検証: **`bun test` 932件成功 / 0失敗**（101 files、14,065 assertions）、`npm run check`、試験用TypeScript検証、Linux単一バイナリbuildと資格情報なしのdomain help/不正引数拒否が成功。全体試験で共通保存helperの変更による失敗時temp保持の差分を検出し、従来の保存契約を維持するよう修正した。試験結果は`/tmp/opencode/castloop-domain-cli-final-tests.log`。

[`docs/custom_domains.md`](../docs/custom_domains.md)に未リリースbuildの利用・復旧制限を記載した。ローカル実装・自動検証は完了し、残るのは承認された専用hostname/M6サービスでのDNS/TLS・両host配信・lifecycle・通常deploy・removeの実機受け入れ。今回はユーザー指定に従い**Cloudflare/DNS設定を一切変更していない**。未リリースであり、v0.2.1バイナリに提供済みとは扱わない。

## 2026-10-04: 共通coreへの管理API接続と秘密を送らないTLS確認

認証・request上限・no-store・固定要求照合を既存管理経路で共有し、`/admin/domain`からURL切替coreを呼べるようにした。読み取り専用statusはURL ownerや未知のtokenが残っていても照会できる。CLIからのCloudflare接続/切断中にも同じservice admission上のtokenを保持し、Worker側のstep/completeと並行しないようにした。接続receiptは固定要求と一致するものだけを保持し、別token・別action・receiptの書き換えを拒否する。

`/.well-known/castloop/runtime`はnonce・service/Worker/versionだけを返すno-storeの読み取り専用probeとした。独自hostのHTTPS到達確認に管理鍵・API tokenを送らず、管理APIは常にworkers.devを使う。probeは公開feed/媒体の停止gateを迂回せず、system/stagingを公開しない。

変更箇所のテストで認証・strict/上限・candidate経路の拒否、connection排他とreceipt、停止中probe/private領域を確認し、既存URL切替の7テストも成功。`npm run check`が成功。domain CLIとlocal journalへの接続は続けて実装する。Cloudflare/DNSの変更はしていない。

## 2026-10-04: 共通の停止中URL切替core

`src/service-url-change.ts`に、add/removeが同じ処理を使うserver coreを実装した。まだ公開管理APIやdomain CLIには接続していない。

- 既存service admissionのpaused recordに小さな`url_change` ownerを追加し、同じCASで実行tokenを管理する。状態enum・別のShow lock・consumer・deployは追加しない。処理中は通常mutation/consumer/recovery/resume/deployを共通層で拒否する。
- Show所有者の終了確認を通常更新と共有した。最大100 controlを確認し、unfinished/deleting/登録不完全なら拒否する。invocationがないだけで変更を始めない。
- feed選別・immutable音源HEAD検証・公開済みShow/coverの読み出し・bounded RSS生成・条件付きfeed保存を既存lifecycle処理と共有した。1 stepにつき1 Showを進め、activeなShow/Episodeだけを新URLへ再生成してpurgeする。非公開/削除/draftの不復活と、媒体・revision/current metadata・GUID・公開日時・`site_url`の不変を維持する。
- 全feed/purgeの成功後にR2設定を同期する。進捗は`feeds`→`configured`→`complete`の小さなrecordに固定要求とShow cursorだけを保存し、コンテンツやsecretを複製しない。設定PUTの応答喪失後はtarget hashから確認し、同じPUTを繰り返さず収束できる。
- `configured`でもownerを解放しない。domain接続/TLS、remove時のDetach、ローカル設定同期を将来のCLIで確認してから完了関数を呼ぶ。完了時は同じWorker/version/deploymentのまま設定hashだけを合わせ、pausedでownerを解放する。サービス再開は既存resumeだけを使う。
- purge失敗は進捗を進めず明示再試行できる。稼働中/未知の実行tokenはstatus・同じ要求の再実行でも解放・失効させない。receiptの`complete`表示だけでなくowner解放も確認する管理APIへ接続する予定。

変更箇所の7テストで両方向、複数Show、既存の新項目なし設定・Show 0件、purge失敗、設定応答喪失、live/residual token、早すぎるresume/deployと公開GET停止を確認した。`bun test`全919件、`npm run check`、試験用TypeScript検証とLinuxバイナリbuildが成功。既存M6の安全条件・300 MB受け入れを別の大規模試験群へ複製していない。

残りはCloudflareの接続照会とTLS確認をこのcoreへ接続し、共有local journal保存によるCLI・設定同期・復旧を完成すること。その後に承認された専用hostnameで実機検証する。Cloudflareリソース/DNSの変更はしていない。

## 2026-10-04: 公開URLから操作記録のidentityを分離

Show登録・local draft・staging・publication・lifecycleのidentity生成を共通の`serviceOperationIdentity`へ統一した。照合するのはservice/account/Workerと固定のworkers.dev管理originであり、変更可能なPodcast正規URLではない。既存journalのwire形式を変えず、identity内の従来の`public_base_url`欄には固定originを入れる。独自ドメイン未提供だった既存M6のworkers.dev identityはそのまま一致し、過去のrecordやfrozen要求を書き換えない。

公開URL変更後にも全4操作familyを読み取り専用で照会でき、未知のphaseやlockを修復・昇格しないことを既存fixtureで検証した。異なるaccount/Worker/管理originの拒否は維持する。`bun test` 912件と`npm run check`が成功。

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
