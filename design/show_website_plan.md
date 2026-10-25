# Issue #70: R2上の静的な番組サイト・Episodeページの設計と実装

作成・改訂日: 2026-10-25。**Issue #70の第1段となる最小限実装。案Bとサイト方式の2択を採用し、CLI・Show DO・Workerへ接続した開発版**。全公開経路の接続と検証を§13に記録する。見栄え・日時表示などの改善は後続とし、Issue全体の完了とは扱わない。本設計だけでは実Cloudflare操作の承認にならない。

- 対象: [Issue #70](https://github.com/simosako/castloop-v2/issues/70)。Issue本文・コメントを確認した。確認時点でコメントはない。
- 改訂時の調査基準: `1d53d0e330d719b6895ddeaf60b7e3143d0103e6`、package version `0.7.5`。main同期後の公開内容取得・revision採用も含む。基準版の内部queue/content形式は7/8。今回の実装は8/9のfresh環境専用とし、旧環境は変換しない。
- 当初は実装・ローカル検証だけを対象とした。その後、別途明示承認された専用環境で非公開試験を実施した（§13.3）。この承認を他環境の配備・公開・Resume・資源／domain／権限／課金設定変更へ流用しない。

## 1. 採用方針の要約

**案Bを採用する。完成済みのHTMLをprivate R2に保存し、サイト専用の配信処理・CDNキャッシュから配信する。公開・停止の正本は既存Show DOと共有し、HTML生成も同DO内のサイト専用処理で事前実行する。**

前稿で既存経路を全面再利用した理由は、Pauseや非公開化の判定と公開世代の切替を二重化しないためだった。ただし、**公開状態を共有することと、HTMLの配信実装・キャッシュまで共有することは別**である。HTMLの処理・キャッシュは分離でき、分離する方が責務を読み取りやすい。生成用DOまで分ける案との比較は§4.1.1に示す。

1. 番組トップに公開Episodeを公開日時の新しい順で20件ずつ表示する。**一覧の各回で、その場で音声を再生できる**ことを必須とする。
2. 各Episodeに、タイトルや音源を更新してもURLが変わらない紹介ページとプレイヤーを設ける。音源ファイル自体のURLとは分ける。
3. 初期版は通常のHTMLと小さい固定CSSだけにする。ブラウザ標準の`audio`を使い、JavaScript・SPA・独自プレイヤーを必須にしない。
4. R2のpublic bucket化はしない。`r2.dev`やR2直結domainを設けず、Pauseや非公開化を迂回できる経路を作らない。
5. 一般のWorkers Freeの10ms制限と、DOの実行上限を区別する。DO側も無制限にはせず、ページ生成を小さい単位に分ける。
6. castloopで番組ページを作るか、管理者が別途運営するWebサイトを番組の紹介先にするかを選べるようにする。例えば既存のWordPressサイトを使うShowでは、そのURLを勝手に置き換えない。

**今回の処理分担は「画像・音声の解析は従来どおりCLI、HTML生成はShow DO」である。** 音声解析等を新しく移動する提案ではない。CLIでHTMLも生成する案は§4.2の比較記録として残すが、採用方式には含めない。

### 主な用語

| 用語 | 本書での意味 |
| --- | --- |
| Show DO | 番組ごとの公開状態・受付順を管理する、SQLite-backed Durable Object |
| Alarm／batch | DOを起動する仕組み／1回の起動で処理する有限個のページ。batch間では処理位置を保存する |
| Gateway／gate | アプリ内の公開要求を扱う処理／最新状態に基づく配信可否の判定。Gatewayは別のCloudflare製品名ではない |
| CDNキャッシュ／cache owner | Cloudflare側で配信内容を再利用する仕組み／そのキャッシュ対象になる内部配信処理。DOの保存領域とは別。既存は`SqliteCachedAssets`、サイト用は別の`SiteCachedPages`を提案する |
| 世代／snapshot | 確定した内容を区別する番号／その時点の内容を保存した不変ファイル |
| lifecycle／blocked | 公開・非公開等の状態／途中停止や不明なIOがあり、後続処理を止めている状態 |
| CSP／OGP | ブラウザが実行・取得できる内容を制限する応答header／SNS等が共有カードを作るためのmetadata |

## 2. 現状から引き継ぐこと

| 確認箇所 | 現状・今回への制約 |
| --- | --- |
| `packages/shared/src/index.ts` | Showは`site_url`必須。EpisodeにWebページURLはない。GUID・公開日時は更新でも維持する |
| `src/feed.ts` | 番組の`link`は`site_url`。itemの`link`は未生成。Episodeは公開日時降順、同日時はID昇順 |
| `packages/shared/src/public-assets.ts`、`src/sqlite-show-routing.ts` | 公開パスを厳密に列挙し、パスから対象Show DOへ到達する。単なるR2 keyの転送ではない |
| `src/sqlite-gateway.ts`、`src/sqlite-publication-content.ts` | 毎要求、最新のShow単位の公開可否を判定する。条件付き要求やredirectも判定後に処理する |
| `src/sqlite-publication-executor.ts` | Alarmで候補Feed等を保存・検証し、必要なpurge後にSQLの公開対象を切り替える |
| `src/sqlite-publication-alarm.ts` | 現行は1 Alarmで1 jobを実行する。中断したrunningを再実行せずblockedにする |
| `src/lifecycle-cache.ts`、`src/sqlite-cache-purge.ts` | 世代を指定した内部cache ownerから配信し、外向けは再検証必須。purge対象はShow／Episode単位 |
| `docs/published_content_review.md`、`src/sqlite-service-runtime.ts` | v0.7.5には認証付き公開内容取得・CLIでのRSS試作・過去revisionの明示採用がある。サイトも過去版採用の結果へ追随する必要がある |
| `packages/shared/src/publication-budget.ts` | Feedの公開対象には最大10,000 Episode・revision JSON合計2,000,000文字等の既存予算がある。これは無料運用可能な規模の保証ではない |

正本は従来どおり、編集元がローカルTOML、公開制御がShow DO SQLite、payload・公開snapshotがR2である。サイトHTMLはその派生物とし、サイト専用の公開状態を別サービスで管理しない。

関連契約: [全体設計](initial_design.md)、[SQLite公開契約](sqlite_sequential_publication_implementation_plan.md)、[Show分離](do_show_separation_options.md)、[受付と配信の分離](show_admission_delivery_separation_plan.md)、[独自domain契約](sqlite_custom_domains_p0.md)、[公開内容確認・過去版採用](../docs/published_content_review.md)。

## 3. Cloudflare Freeを前提にした制約

2026-10-25に参照した公式資料による。CloudflareのzoneのFree契約、Workers Free、R2の無料利用枠は別の条件であり、まとめて「Cloudflare Freeだから無制限」と扱わない。

| 対象 | 確認した条件 | 設計への反映 |
| --- | --- | --- |
| 通常のWorkers Free | 100,000要求/日、HTTPのCPU 10ms、isolateのmemory 128MB | GatewayでHTML生成・全Episodeのparse／sortをしない。cache miss時もR2をstreamする |
| SQLite-backed DO | Freeで利用可能。DO資料はHTTP／Alarm等のCPUを既定30秒、Alarmのwall timeを15分と記載 | 公開時の小さいHTML生成は検討可能。30秒を使い切る設計やCPU上限の引き上げは採用しない |
| DO無料利用枠 | 100,000要求/日、13,000 GB-s/日、SQL読取500万行/日・書込10万行/日、合計保存5GB | 公開処理だけでなく毎回の配信判定、Alarm、管理照会と同じ枠を使う。IO待ちもactive時間を消費する |
| 内部IO | Workers Freeは外部subrequest 50回、Cloudflare内部サービスへのsubrequest 1,000回/invocation。同時接続待ちは6本 | R2操作を無制限に1 Alarmへ詰めない。生成単位・bytes・IO回数を制限する |
| R2 Standard | 10 GB-month/月、Class A 100万回/月、Class B 1,000万回/月、egress無料 | 音源・旧revision・Feed・サイト履歴を合算する。Infrequent Accessは使わない |
| Workers Cache | cache HITも要求数に算入。cacheを有効にした内部entrypoint呼出しも対象。HIT時はそのentrypointのCPUを使わない | CDNはR2読取と内部配信CPUを減らすが、公開可否判定や要求数をゼロにはしない |
| Workers Static Assets | Workerを実行しない静的要求は無料・無制限。Freeは20,000 files/version、25MiB/file | lifecycle判定のためWorkerを先行実行すれば、その要求はFreeのWorkers枠を使う |

DO資料の30秒は通常のHTTP Workerの10msとは異なる。**資料上サーバー生成が可能なことと、この実装が実機でFreeに収まることは別**である。CPU、memory、SQL、IO、durationの実測を受け入れ条件に含める。過去の36件試験を新サイト機能のFree適合の証拠に流用しない。

### 無料利用枠の意味

- 有料プランへのupgradeやCPU制限変更を前提としない。新たな有料製品も追加しない。
- R2の無料枠は超過を自動で無料にする上限ではなく、超過分には従量料金が発生し得る。無料運用にはアカウント全体の利用量の管理が必要である。
- Workers／DOのFree枠超過時は利用不能になり得る。エラー時にR2直配信へ逃がして停止制御を省略してはならない。
- 独自domainの取得・更新費用まで無料になるわけではない。内蔵サイト自体は既存のworkers.dev originでも動く設計とする。

## 4. 構成上の選択肢

### 4.1 保存・配信先

| 案 | メリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| R2 public bucket＋直接CDN配信 | 閲覧時のWorker／DO処理を省ける | 現在の同一bucketには内部データもある。別bucketに分けても、直接URLはShow／Episodeの最新状態を確認せず、Pause・非公開化・保守拘束を迂回する | 不採用。purgeやTTLだけを停止保証の代わりにしない |
| **private R2＋サイト専用の配信処理・cache owner** | HTMLの処理・キャッシュ・無効化対象をFeed／音源から分けられる。公開可否はShow DOに問い合わせるため停止制御も維持できる | サイト用entrypointと公開処理からの接続が増える。CDN HITでも公開判定と要求数の消費は残る | **採用。分離範囲は次項の案B** |
| Workers Static Assets | 静的配信が標準機能。Workerを呼ばなければ要求数面で有利 | 本件ではWorker先行判定が必要。Episode公開でasset配備も必要になり、コンテンツ公開と現在の共有Worker更新手順を分離しにくい | 一般の新規サイトには有力だが、本件のR2派生物には採用しない |
| Pages／外部静的hostingへ出力 | 外部サイトとして独立運用できる | 配備先・公開管理が増える。出力後の停止をcastloopで保証できない | 内蔵サイトの初期方式には含めない |

ここでいう「R2上のStatic website」は、R2に完成した静的HTMLを置くという意味であり、S3のwebsite hostingと同じindex解決等をR2が自動提供することを前提にしない。公開URLからHTML objectへの対応はGateway側で明示する。

### 4.1.1 既存機能と何を共有し、何を分けるか

**管理者の選択により案Bを採用する。** サイトの配信処理・cache owner・生成moduleを分け、Show DO・公開状態の正本・R2 bucketは共有する。以下は採用理由を確認するための比較であり、案A・C・Dは初期実装に含めない。

| 案 | メリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| A: 既存配信処理・cache owner・Show DOを全面共用 | 新しい接続箇所が少なく、同じ公開処理へ追加しやすい | HTML固有のheader、ページ索引、purgeがFeed／音源処理に混ざる | 前稿の案。今回の改訂では第一推奨から外す |
| **B: サイトの配信処理・cache owner・生成moduleを専用化し、Show DOは共有** | HTMLの責務とcache key／purge範囲が分かれる。公開と停止の正本、Feedとサイトの原子的な切替は維持できる | 同じWorker・Show DO内なので、実行負荷や障害、配備の完全な隔離にはならない | **採用済み** |
| C: Bに加えて、HTML生成用DOも分ける | 生成用の実行単位・進捗保存を既存Show DOから分けられる | Show DOから生成入力を凍結して渡し、生成結果を照合して公開するDO間の手順が必要。中断・応答喪失の扱いも増える | 不採用。初期版はDO間連携を増やさない |
| D: サイトを別Worker・生成DO・cacheへ分ける | サイトのcode配備も分離できる | Worker間接続、設定・配備・domain管理が増える。公開可否をShow DOへ問い合わせる依存は残り、同一アカウントのFree枠も共有する | 不採用。初期版は独立配備まで分けない |

**Bで共有するものは、同じURL originを扱う小さい振分け処理、公開状態の正本、R2 bucketである。** 既存の`serveSqliteGateway`へHTML処理を継ぎ足すのではなく、サイトURLを専用handlerへ振り分ける。HTML生成、ページ用header・CSP、HTMLのR2読取、サイト用purgeは専用moduleに置く。Feed・cover・MP3は今の経路を保ち、サイトHTML用cacheへ複製しない。

キャッシュは、ご指摘のとおりCDN側のキャッシュを指す。Cloudflareの同じWorkers Cache製品を使うが、既存の`SqliteCachedAssets`とは別のnamed entrypoint `SiteCachedPages`（仮称）を設ける。公式仕様ではentrypointごとにcache keyとpurge範囲が分かれる。**同じCDN製品を使うことと、同じcache領域・purge対象を使うことは別**である。

既存Show DOを共有する理由は、単なるコード再利用ではない。Episode非公開化とページ公開参照の無効化、FeedとHTMLの公開世代切替を、同じデータベースの1回の確定で扱えるためである。サイト用DOに独立した`published`／`paused`を持たせると、片方だけ更新された場合の対処が必要になる。

比較した案Cでも、公開判断の正本をShow DOに残したまま生成用DOだけを分けることは可能である。ただし、候補HTMLの生成・結果承認を複数DOで連携する必要がある。**初期版は案Bに一本化し、生成用DOは追加しない。本稿後半も案Bの詳細とする。**

独立entrypointを増やしても無料枠は増えない。またBでは、HTML生成のCPUやサイト生成失敗による同一Showの後続停止を既存の公開処理から隔離できたとは説明しない。

### 4.2 HTMLを生成する場所・タイミング

| 案 | メリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| **公開時にShow DOのAlarmで静的生成** | サーバーの確定内容と凍結した要求だけを使える。非公開化・復元・RSS取り込みにも同じ生成処理を適用できる。受付後にCLIが終了しても完了できる | R2 IOとDO durationが増える。大量ページ向けに、安全な生成分割と次回Alarmへの引継ぎが必要 | **採用。案Bに従い既存Show DOで生成する** |
| CLIで生成・R2へuploadし、DOが承認 | HTML生成CPU・memoryを管理者端末へ移せる。既存の1 Alarm/1 jobを保ちやすい。v0.7.5の公開内容取得も利用できる | 既存取得APIをサイト入力用に組み合わせ、stale検査とHTML群のreceipt／manifest検証へ接続する必要がある。非公開化・復元・domain変更にも生成とuploadが必要 | 比較対象として記録するが、現在の推奨案では実装しない |
| 閲覧時のSSR | ファイル生成・保存が少ない。常に最新内容から作れる | cache missやbotアクセスが生成負荷になる。通常Workerの10ms制約が厳しく、DOで実行しても閲覧量とCPU負荷が結合する | 非推奨 |
| 静的shell＋ブラウザで公開JSONを描画 | サーバーのHTML生成を最小化できる | JSと追加要求が必須。共有先のOGPや検索クローラがEpisode内容を取得できない場合がある。JSONにもlifecycle gateが必要 | 初期版には非推奨 |

**推奨理由は「DOなら重い処理を何でもできる」ではない。** 現在すでに公開時にFeedを生成しており、限定したHTML生成を同じ公開境界へ置くと、公開内容の整合を最も直接的に維持できるからである。音声変換、画像変換、任意テーマのbuild、複雑なMarkdown／HTML処理はここへ追加しない。

CLI案を選ぶなら、サーバーの公開snapshot＋今回明示した変更だけから生成し、対象Show・runtime/config・受付window・旧Feed/Show/Episode世代・要求hash・template版へ候補を束縛する。全ファイルの検証済みreceiptと公開パス集合を確定し、DOが実行時に同じ入力世代であることを確認してからFeedと一緒に承認する。変化していれば副作用前に拒否し、自動再生成・再送はしない。大量HTMLの検証も小さいbatchに分ける必要があり、CLI案でもサーバーの仕事がゼロになるわけではない。

### 4.2.1 今回の処理分担

| 処理 | 実行場所 | 今回変えること |
| --- | --- | --- |
| 音声形式・尺・サイズ等の解析、画像の入力検証、uploadとreadback照合 | CLI | 場所も基本的な責務も変更しない |
| 番組紹介・Episode一覧・Episode詳細のHTML生成 | 既存Show DO | サイト用の新しい生成処理を追加する。閲覧要求では実行しない |
| HTMLの候補保存と公開世代の承認 | R2とShow DO | HTMLを保存しただけでは公開せず、必要な検証とpurge後に公開対象として確定する |
| ページ表示と音声の再生UI | リスナーのブラウザ | 静的HTMLを表示し、HTML標準の`audio`で既存MP3を再生する |

つまり、**解析処理をCLIからDOへ移さず、HTMLをCLIで生成する機能も今回追加しない**。生成時に音声変換や画像加工を行う提案でもない。

### 4.3 一覧とページの作り方

| 要素 | 案とメリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| 一覧の分割 | 全件1 HTMLなら生成・リンクが単純 | Episode増加でHTML・プレイヤー数が増え、モバイルの初期負荷が大きい | **20件の番号付き静的ページ**。管理一覧と同じ件数だが管理APIは流用しない |
| 一覧の分割 | cursor式／日付別なら新規追加で古いページを再生成する量を減らせる | 安定した次／前リンク、件数偏り、非公開化時の穴の扱いが増える | 初期版では採用しない。番号ページの再生成費用は§6で明示 |
| 更新範囲 | 毎回全Episodeページを作り直せば単純 | 1件の編集でもN件のHTML書込が増える | **一覧ページ＋変更したEpisodeを生成し、未変更EpisodeのHTMLは再利用** |
| プレイヤー | ブラウザ標準ならJSなしで再生・seek・キーボード操作ができる | UIはブラウザ依存。複数プレイヤーの同時再生を自動制御しない | **標準`audio controls`**。独自プレイヤーや排他的再生制御は必須にしない |
| 説明文 | テキストとしてescapeすればHTML sanitizerが不要 | RSS由来のHTML記法を装飾として表示できない | **初期版はテキスト表示**。HTML記法も文字として表示し、その制約を案内する |

## 5. リスナー向け仕様とURL

### 5.1 番組トップ・一覧

- 番組名、説明、カバー、著者、RSS購読リンクを表示する。管理用メール・ローカルファイル名・job情報は出さない。
- 公開Episodeを`published_at`降順、同時刻は`episode_id`昇順で表示する。Feedと同じ順序にし、タイトル更新や音源差し替えでは順序を変えない。
- 各回にタイトル、公開日時、短い説明、Episodeページへのリンク、**その場で押せる再生ボタンを含む標準プレイヤー**を置く。Episodeページへ移動しないと再生できない構成にはしない。
- 説明の抜粋は一覧だけの表示処理とし、元データを切り詰めない。全文はEpisodeページで読める。
- 20件を超えたら通常の前／次リンクを表示する。0件でも公開済みShowの紹介ページとRSSリンクは表示する。
- 未来の`published_at`だけで公開状態を決めない。予約公開の有無とは独立して、サーバーで公開済みの内容だけを出す。

### 5.2 Episodeページと音声

- タイトル、公開日時、説明全文、音声プレイヤー、番組トップ・RSSへのリンクを表示する。
- `<audio controls preload="none">`と`audio/mpeg`を使う。自動再生しない。プレイヤーにEpisode名を対応付け、見出し・リンク・focus表示もキーボードで利用できるようにする。
- 音声URLは公開indexの承認済みrevisionから構築する。同一公開originのMP3を直接streamし、既存のGET／HEAD／単一Range／ETag経路を使う。DOで音声を中継せず、再encoding・HLS化もしない。
- `preload="none"`は未再生の全音源の先読みを避けるための指定で、全ブラウザが一切通信しない保証ではない。
- 標準player非対応時の音声リンクも置く。アプリ導入・ログイン・プラグインを要求しない。

#### プレイヤーをどう実現するか

HTMLの`<audio controls>`を書くと、ブラウザ自身が再生ボタン・一時停止・再生位置の操作などを表示する。castloopがボタンや音声再生のJavaScriptを実装する方式ではない。見た目や操作項目はSafari／Chrome等により異なる。

番組一覧の1回分には、次のようなHTMLを事前生成する。URL・タイトルは説明用の例であり、実際は検証済みの公開参照から出力する。

```html
<article aria-labelledby="episode-first-title">
  <h2 id="episode-first-title">
    <a href="/podcasts/my-show/episodes/first/">第1回のタイトル</a>
  </h2>
  <audio controls preload="none" aria-labelledby="episode-first-title">
    <source
      src="/podcasts/my-show/episodes/first/00000000-0000-4000-8000-000000000001.mp3"
      type="audio/mpeg">
    このブラウザは音声プレイヤーに対応していません。
  </audio>
  <p>
    <a href="/podcasts/my-show/episodes/first/00000000-0000-4000-8000-000000000001.mp3">音声ファイルを開く</a>
  </p>
</article>
```

1. ページを開くとブラウザが標準プレイヤーを表示する。
2. リスナーがその再生ボタンを押すと、ブラウザがMP3を取得して再生する。Episodeページへの移動は不要。
3. 再生位置を変える場合は既存の音声配信経路へRange要求を送る。HTML用cacheやDOを音声中継に使わない。

音声リンクはplayerの外にも表示し、非対応ブラウザや再生できない場合に使えるようにする。Episode詳細にも同じ標準プレイヤーを置く。独自の再生キュー、倍速ボタン、1回だけを排他的に再生する制御は初期版に追加しない。

### 5.3 公開パス案

| 用途 | パス |
| --- | --- |
| 番組トップ＝一覧1ページ目 | `/podcasts/<showId>/` |
| 一覧2ページ目以降 | `/podcasts/<showId>/page/<n>/` |
| Episode共有ページ | `/podcasts/<showId>/episodes/<episodeId>/` |
| RSS・カバー・MP3 | 現在のURLを変更しない |

IDは既存の検証済みShow/Episode IDを使う。タイトル由来のslug、任意URL、revision IDを共有URLへ加えない。`page/1/`や末尾slashなしの既知パスを正規化する場合も、対象Showの公開判定後だけredirectする。不存在ページは404、未知パスは既存と同様に拒否する。queryをpaginationや世代選択に使わず、内部cacheにも転送しない。

音源変更後もEpisodeのパスは同じで、新しく確定したHTMLだけが新音源を参照する。通常更新で旧承認済みMP3を削除・不正扱いにしない。Show／Episode IDの変更・再利用は今回追加しない。domainを変えればoriginは変わるため、永続性の保証は「同じoriginでの更新」と既存domain redirect契約の範囲である。

#### 「安定したEpisodeページ」の意味

「安定」は、**同じ回を紹介するページのURLが、タイトル・説明・音声の差し替えで変わらない**という意味である。例えば共有した`https://podcast.example.com/podcasts/my-show/episodes/first/`は、音源を差し替えた後も同じURLで開ける。

一方、そのHTML内で参照するMP3は`.../episodes/first/<audioRevisionId>.mp3`であり、音源の差し替え時に新しいファイルのURLへ切り替わる。リスナーは紹介ページのURLを共有すれば、音源ファイルの世代を意識せず、現在公開されている内容を読んで再生できる。

これは「常時アクセスできる」「非公開にしてもページを残す」という意味ではない。Pause中は503、Episode非公開化後は404等、§8の配信条件をそのまま適用する。

## 6. 採用案Bの生成・公開契約

### 6.1 責務と処理順

```text
CLI: TOML・素材を検証 → 一意keyへupload・照合 → 明示publish
Show DO: 要求を凍結 → 既存のbase／世代を検証
  → 新しいFeed・HTML・必要な音源／画像を非公開の候補keyへ保存・検証
  → 必要なら小さい生成batchを次のAlarmへ引き継ぐ
  → 必要なcache purge → 同じSQL transactionで公開対象とjob成功を確定
閲覧: URL振分け → サイト専用Gateway → 対象Show DOの最新判定
  → サイト専用SiteCachedPages（CDNキャッシュ）→ private R2のHTML
音声取得: 既存Gateway → 対象Show DOの最新判定 → SqliteCachedAssets → private R2のMP3
```

生成入力は、**確定済みの公開内容＋今回の凍結済み明示要求による差分**だけとする。公開予定の差分は候補として生成できるが、SQLで確定するまで一切配信しない。ローカルの全draft、stagingの列挙、R2のmetadataファイル全走査、運用記録を入力に使わない。

### 6.2 保存形式案

- HTMLは、例として`public/podcasts/<showId>/sites/<generation>/index.html`、同じ世代の`page/<n>.html`、`episodes/<episodeId>.html`へ不変保存する。`public/`というR2 prefix自体に公開権限はない。これらの世代別keyを公開URLにせず、GatewayからR2への一般的なkey変換も設けない。
- `generation`には既存の予約済みFeed世代を使う。通常公開・lifecycle・domain再生成が同じ採番を使い、job sequenceやcover世代から推測しない。
- Show DOに「公開サイト全体がどのFeed世代に対応するか」と「各公開ページがどの不変HTMLを参照するか」の小さい索引を持つ。未変更ページは以前のHTML世代を再利用できる。
- 公開索引と生成途中の候補参照を分ける。最終transactionで一覧・Episode参照、Feed、必要なmetadata/media承認を一緒に切り替える。途中のbatchは公開索引を変えない。
- HTMLもR2 bindingの条件付き作成とSHA-256・size確認を行う。確定objectが欠落・不一致なら503にし、古いHTML・Feed・ローカル入力へfallbackしない。
- 本文はR2へ置き、DOの配信判定には本文をparseしない小さい列だけを使う。SQLiteの1行へ全サイトHTMLや巨大manifestを詰めない。
- 既存のbinding／DO・cache class名／compatibility dateを維持し、サイト用cache entrypointを別名で追加する。サイト用にも実行version・config一致とcache／purgeの動作確認を設け、既存entrypointの確認だけでサイト配信をreadyにしない。新しいSQL列・生成途中状態・health識別は永続形式変更として扱い、旧形式のcode-only更新や移行は設計しない。

この索引は公開判定のためのものであり、R2とは別のコンテンツ編集元ではない。公開中の索引が参照しなくなったHTMLも自動削除しない。

### 6.3 何を再生成するか

| 操作 | 生成・切替範囲 |
| --- | --- |
| 初回Show公開 | Episode 0件の番組トップとFeed |
| Episode追加・metadata/audio更新 | 全一覧ページ＋対象Episodeページ＋Feed。未変更Episodeページは再利用 |
| Episode非公開化 | 全一覧ページとFeedを更新し、対象ページの公開参照を外す。全音源revisionも既存gateで拒否 |
| Episode復元 | 全一覧ページ＋保存済み対象Episodeページの内容＋Feed。GUID・日時・音源identityを維持 |
| Show metadata／cover更新 | 番組名等を含む全一覧・全公開Episodeページ＋Feedを生成 |
| Show非公開化 | Showのgateで全ページを拒否する。停止のために全HTMLを書き直さない |
| Show復元 | 保存済みShowと現在公開対象のEpisodeから再生成。個別非公開Episodeを復活させない |
| Show／Episodeの過去revision採用（v0.7.5） | 採用後に確定する内容で上記のShow更新／Episode更新と同じ範囲を生成。過去のHTMLをそのまま公開して現在の一覧やdomainを巻き戻さない |
| `open / admission_paused / paused`の切替 | HTMLを生成しない。最新gateで配信可否を変える |
| domain変更 | 専用保守内で新origin用の全ページ・Feedを生成し、Showごとに同時切替。通常deployへ混ぜない |
| 内蔵／外部サイト方式の切替 | 明示Show公開でFeed linkとページの有効性を同時切替。外部化したら内蔵ページは404 |

一覧は番号式なので、新規追加で古いページの内容もずれる。初期版は全一覧の再生成で単純さを優先し、差分のあるページだけを探す追加アルゴリズムは入れない。ページ数が減ったときは余った公開参照も最終transactionで外す。

固定templateの更新もHTMLの変更である。通常のcode-only deployだけで既存HTMLを自動生成し直さず、明示したShow公開で全ページを新templateへ更新する。更新まで旧HTMLとそのCSS hashを引き続き配信できるようにする。

### 6.4 大量生成を1 Alarmへ詰めない

既存上限の10,000 Episodeなら、20件ごとの一覧が500ページ、Episodeページが10,000ページになる。Show編集で10,500 objectを書き込む処理は内部subrequest 1,000回を超えるため、**全生成を既存の1 Alarmに単純追加する案は採用できない**。

推奨は、まず**1 batch最大20 HTML**を内部定数の案とし、さらに生成bytesとR2 IOの予算で分けること。全HTMLをメモリに保持せず、小さいページを生成・保存して解放する。batch数は有限で、必要なSQL indexとkeyset読取を使い、毎batchで全Episodeをparse／sortし直さない。具体的なbytes上限・IO内訳・SQL計画は実装前に確定し、既存のFeed入力・生成上限も維持する。

ここでいうkeyset読取は、最後に読んだ公開日時・ID等を保存し、その次から一定件数ずつ読む方式である。現行FeedのTypeScript側のID比較とSQLiteの文字列照合順が同じとは仮定せず、同時刻・hyphenを含むIDでも順序が一致することを確認する。

**これは既存Alarm実行方式への実質的な追加であり、単なるrenderer追加ではない。** 引継ぎには次の契約が必要になる。

1. 同じShowの先頭jobだけが生成を進める。正確なrequest hash、runtime/config、旧公開世代、所有する実行単位、template版、処理段階とcursorを照合する。
2. IO前に「このbatchを開始した」を耐久保存する。R2 IOはtransactionへ入れない。
3. 開始済みIOがすべて確定成功した後だけ、候補参照・次のcursor・次回Alarm予約を同じtransactionで保存し、耐久化する。
4. 次のAlarmは「正常に完了を記録したbatchの次」だけを実行する。前回の処理途中で再起動した場合や、IO結果が不明な場合はblockedにし、そのbatchを再送しない。
5. 最後に既存のFeed／cover用とサイト用のそれぞれのentrypointから必要なpurgeを行い、両方の成功後に公開対象と成功結果を確定する。中間checkpointを公開成功と表示しない。

現在の「残ったrunningは中断としてblocked」という扱いを、一律に自動再開へ変更してはならない。**正常なbatch間の待機**を、**実行途中・未知IO**と永続状態で区別する必要がある。blocked retry、token奪取、時間切れ解放、一般的なworkflow engineは追加しない。ページが少ない場合も同じ方式の1 batchで済ませ、別実装に分けない。

domain再生成は通常jobではなく、既存の専用保守operationが生成を所有する。上記の入力固定・batch開始／完了・未知IO保全をそのoperationへ結び付け、通常publishを別途投入しない。全対象Showのページ・Feed・readiness確認が終わる前に、制御DOの保守完了やResumeを許可しない。

生成に時間がかかりCLIの既存5分poll上限へ到達しても、公開済み扱い・自動再submit・job取消にはしない。保存済みjobのstatus確認へ移る。batch化は各invocationの上限対策であり、DOの1日分のdurationや要求数を減らす仕組みではない。

生成と進捗保存は採用した案Bに従い、同じShow DO内で行う。別の生成用DOや複数方式の併存、失敗時にCLI生成へ自動切替する仕組みは作らない。

## 7. サイト設定、Feed link、外部サイトとの併存

### 「外部サイト」とは何か

ここでいう外部サイトは、**管理者がcastloopとは別に作っている番組紹介サイト**である。例えばWordPressや自作のWebサイトを指す。「外部サイトを新しく用意してください」と推奨しているのではなく、すでにそのようなサイトを使っているShowの扱いを決めている。

**初期版は、Showごとに次の2通りから選ぶ方式を採用する。**

| 選択 | castloopが提供するもの | RSSで番組紹介先として案内するURL |
| --- | --- | --- |
| **castloopでサイトを作る** | 今回の番組トップ・20件一覧・Episode紹介ページに加え、従来のRSS・画像・MP3 | 例: `https://podcast.example.com/podcasts/my-show/` |
| **自分の既存サイトを使う** | 従来どおりRSS・画像・MP3。今回のHTMLページは作らない | 例: `https://www.example.net/podcast/`。管理者が指定したURLを維持する |

前者は別途サイトを作りたくない管理者向け、後者はすでにサイトを持つ管理者向けである。各URLは設定済みorigin等の例であり、新たなdomainの取得や接続を要求するものではない。

**管理者が『castloopでサイトを作る』と選んだShowだけにページを作り、既存サイトへのリンクは自動変更しない。** この2択の方針は採用済みである。以下は設定への具体化であり、field名やschema採番等の詳細は実装前に確定する。

### 設定方法の比較

| 案 | メリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| `site_url`が内蔵URLと一致すれば自動判定 | 設定項目を増やさない | domain変更や既存外部URLの意味が曖昧になる。単なるURL編集が機能切替になる | 非推奨 |
| **Showに明示的な`site_mode`を追加** | 内蔵／外部の意図が明確。CLI・Feed・生成処理が同じ判断を使える | schemaと入力説明の変更が必要 | **推奨** |
| service全体で内蔵サイトを強制 | 設定が少ない | Showごとの既存外部サイトを維持できない | 不採用 |

提案する意味は次のとおり。名前・schemaの採番は実装前レビューで確定する。

- `site_mode = "external"`: `site_url`必須。現在の番組／画像のRSS `link`を維持する。内蔵ページは提供せず、Episode item `link`も現状どおり未生成にする。
- `site_mode = "builtin"`: 手入力の`site_url`は持たず、サービス設定の`public_base_url`とShow IDから番組URLを導く。番組／画像のRSS `link`は番組トップ、itemの`link`は対応するEpisodeページにする。
- モード省略は外部サイトとして扱う。既存URLを内蔵URLへ自動置換しない。外部サイト＋内蔵ページの両方を個別公開する第3モードや、外部Episode URLの個別上書きは初期版へ追加しない。
- `create-show`で内蔵を明示選択すれば、外部サイトURLなしで作成できるようにする。未指定時は現在の外部サイト運用を維持する。createやupdateだけではページを公開しない。
- RSS importでは元の外部`site_url`を既定で保持し、内蔵化はレビューした明示選択とする。GUID、`guid_is_permalink`、公開日時は変えず、Episodeページの追加を理由にGUIDをURLへ置き換えない。

設定例は次のとおり。Show TOMLのサイト関連部分だけを示し、どちらも設定保存だけでは公開を始めない。

```toml
site_mode = "builtin"
```

この場合は外部の`site_url`を入力せず、castloopの番組ページURLを使用する。

```toml
site_mode = "external"
site_url = "https://www.example.net/podcast/"
```

この場合は管理者の既存サイトをRSSの紹介先として使い、内蔵HTMLページを生成しない。あとから選択を変える場合も、明示したShow公開で切り替える。外部サイトの内容・再生機能・停止はそのサイトの管理者が管理し、castloopから外部ページを更新・削除しない。

独自domain接続後のworkers.dev上のサイトURLは、対象Showのgateを確認後、正規originの同じパスへ307/no-storeとする案を推奨する。Feedの既存301は変更しない。307はdomain切断を考慮した可逆性を優先するためであり、検索エンジン向けには正規ページのcanonicalも設定する。永続転送を優先する301案は検索上の意図が明確になる一方、切断後にクライアントが旧転送を記憶する点が不利である。

## 8. lifecycle、キャッシュ、ブラウザ向け防御

### 8.1 応答と公開停止

| 状態 | ページ・一覧の扱い |
| --- | --- |
| 公開済みで配信条件を満たす`open`／`admission_paused` | 確定済みHTMLを200／HEAD／条件付き304で返す |
| 通常のShow／Episode更新の生成中 | 既存の保護条件にサイト参照の一致も加えた場合だけ、確定済み旧HTMLを返す |
| 旧内容の隔離を確認できるblocked | 現在のallowlist理由・検証済みflag・保存世代の一致を満たす場合だけ旧HTMLを返す |
| 初回公開、非公開化／復元の実行中、隔離できないblocked | 503/no-store。途中候補・削除予定内容を返さない |
| `paused`、未ready、runtime不一致、保守拘束 | 503/no-store。本文にも番組内容を含めない |
| 未公開Show、非公開Show／Episode、外部サイト方式、存在しないページ | 404/no-store |
| 将来の削除状態 | 既存契約に合わせ410/no-store。今回物理削除は実装しない |

「受付だけ停止」中も、既受付jobが成功すれば新しい確定サイトへ切り替わる。受付停止時点のサイトを固定する機能ではない。1回のHTTP応答は許可された不変HTML世代に固定するが、公開切替をまたぐ別要求同士の世代一致までは保証しない。

### 8.2 キャッシュを停止制御の外へ出さない

- サイト専用Gateway自体をcacheしない。最新のDO判定を通した後の内部`SiteCachedPages`だけをHTML用のCDN cache対象にする。既存Feed／cover／MP3用の`SqliteCachedAssets`とは別のentrypoint・cache領域・purge範囲にする。別のCache API storeやR2公開domainは追加しない。
- cache keyには公開パスと、判定したHTML参照世代・Show世代・必要なEpisode lifecycle世代等を含める。古いcache fillが遅れて完了しても新しい参照へ混入しないようにする。
- cache hit、HEAD、`If-None-Match`による304、正規化・origin redirectもgateより先に返さない。内部keyや世代をqueryで指定して旧HTMLを取り出す経路を作らない。
- 内部HTML cacheは既存Feedと同様の短い保持から始める。外向けの成功応答は`public, max-age=0, must-revalidate`、停止・非公開・エラーは`no-store`とし、内部cache tag等は外へ出さない。
- サイト用entrypointにはページ用tagを設け、Episode操作では全一覧と対象Episodeページを1回のサイト用purgeにまとめる。Show操作では全サイトが対象になる。Feed等の既存entrypointへのpurgeとは別の呼出しになり、片方をpurgeしてももう片方は消えない。
- 必要な両entrypointのpurge成功を確認してから公開する。片方だけ成功しても公開完了にはせず、どちらが確認済みかを保存する。ページごとにpurge APIを連打せず、entrypointの追加でpurge回数が増えることをFreeの制限・待機予算へ含める。
- purge失敗を成功に変換しない。既存の明確なrate-limit拒否への有限待機以外に、公開保存の再実行や未知purgeの再送を追加しない。

既に取得済みのHTML、ダウンロード済み音声、ブラウザの再生buffer、検索・SNS・第三者の保存内容は取り消せない。Pause／非公開化が止めるのは以後にサーバーの判定を受ける取得であり、取得済みの内容を遠隔消去する保証ではない。

### 8.3 HTMLとURLの扱い

- RSS由来を含むタイトル・説明・著者等を信用しない。本文と属性に適切なescapeを行い、ユーザー文字列をHTML、CSS、JavaScript、任意属性として挿入しない。
- 初期版の説明はテキスト表示。タグの削除や入力文字数計測用の`stripHtmlTags`をHTML sanitizerの代用にしない。rich HTML対応は別の要件・許可タグ設計として扱う。
- 外部サイトリンクは既存と同じHTTP(S)・credentialsなし等の検証に加えて属性escapeを行う。`javascript:`／`data:`等を認めない。画像・音源は任意URLを受けず、公開originの承認パスから構築する。
- CSSは小さい固定のものだけをHTML内へ埋め込む案とする。追加のCSS取得要求を避け、対応する固定CSSのhashをページ参照と一緒に保持してCSPに使う。任意テーマ・任意CSSは扱わない。
- CSPの基本は`default-src 'none'; script-src 'none'; style-src 'sha256-<fixed-css-hash>'; img-src 'self'; media-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`。hashは実際の固定CSS bytesから生成する。
- HTMLに`Content-Type: text/html; charset=utf-8`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`を付ける。CSP等のheaderはHEAD／304でも維持する。
- cookie、外部font、広告、analytics、Service Worker、オフラインcache、外部埋込みplayerを追加しない。

### 8.4 検索・共有metadataと外部出力

- 公開HTMLに`title`、短いmeta description、canonical、最小のOGP（title／description／url／cover）を静的に含める。音声そのものを共有botに先読みさせる仕組みは追加しない。
- 一覧2ページ目以降はそれぞれのURLをcanonicalにする。全ページを1ページ目へまとめて指さない。公開Episodeへ通常のHTMLリンクで到達できるようにする。
- 非公開・停止時に古いOGP付きHTMLを返さず、`X-Robots-Tag: noindex`も付ける。503では検索側が以前の情報を保持する可能性があり、即時削除は保証しない。
- サービス全体のShowディレクトリ、sitemap、検索機能は初期必須にしない。他Showの公開可否を毎回集約する機能を増やさない。
- 外部hostingへの静的exportは今回提供しない。将来提供する場合も、そのコピーの停止・削除・検索除外は管理者の責任となり、castloopのPauseでは止められないことを明記する。

## 9. 負荷・無料枠の評価方法

### 9.1 生成側

公開Episode数を`N`、一覧数を`P = max(1, ceil(N / 20))`とする。

- 通常のEpisode追加／更新は原則`P + 1` HTML、Episode非公開化は`P` HTMLを新規保存する。全EpisodeのHTMLを書き直さない。
- Show更新は`P + N` HTMLを生成する。36 Episodeなら通常更新で3 HTML、Show更新で38 HTMLとなり、20 HTML/batch案ではShow更新は2 batchになる。
- HTMLは不変履歴として蓄積する。R2容量は現行ページ分だけでなく、全生成履歴と音声／Feed／coverを合算する。Free枠を守る目的でも既存履歴の自動削除・一律期限切れを追加しない。
- Nが大きい初回RSS逐次公開では一覧も繰り返し生成するため、書込・保存量が増える。10,000件を無料で一括移行できるとは約束しない。

batchのCPUだけでなく、job全体のwall time、R2 HEAD/GET/PUT回数、SQLのrows read/written、DO active duration、候補・履歴の保存bytesを測る。生成失敗やpurge待機も消費に含める。

### 9.2 配信側

CDNでHTMLやMP3がHITしても、各配信経路とShow DOによる最新判定は残る。採用案Bでも、**許可された公開要求1回につき外側Workerの要求に加え、cacheを有効にした内部entrypoint呼出しもWorkers要求として数える保守的な計算**が必要になる。DOには通常1回の配信判定がある。HTMLと音声のentrypointを分けても、各要求は対象となる片方だけを呼び出す。

たとえば番組トップのHTML＋coverで2公開要求、再生・seekで音声要求が`r`回なら、その閲覧は概ね`2 + r`公開要求になる。上記の計算ではWorkers枠に概ね`2 × (2 + r)`、DO枠に`2 + r`が加わる。bot、再検証、redirect、管理操作、他サービスの利用量も加算する。これは容量計画用の式で、ブラウザが常に同じ要求数になる実測値ではない。

**無料・無制限の静的hostingではなく、Freeの要求数・保存量の範囲で運用できる静的サイト**と説明する。実測で内側cache要求の計上も照合し、単純に100,000 PV/日と換算しない。継続的な全Episode取得、ページ表示だけでの音声先読み、サイト表示のための管理API照会はしない。

## 10. 開発順と受け入れ条件案

案Bとサイト方式の2択は採用済みであり、実装・ローカル検証の指示を受けている。以下の順で具体化する。現在の到達点と未完了部分は§13で区別する。

1. **詳細契約の確定**: 採用した案Bとサイト方式の2択を前提に、site modeのfield名・schema、RSS link、ページ索引、世代・read guard、batch完了と中断の保存形式、生成bytes・IO予算を確定する。既存の10,000件上限を理由なく引き下げない。
2. **純粋なrendererと試験**: HTML escape、URL構築、公開日時順、20件分割、player、CSP用CSS hash、最小OGPを外部依存なしで実装する。
3. **保存・生成の接続**: fresh形式のSQLとhealth、候補R2保存、有限batchとAlarm引継ぎ、purge後の原子的な切替を実装する。
4. **全公開経路の接続**: Show/Episodeの公開・更新・非公開化・復元・過去revision採用、RSS import、domain保守、URL振分け／サイト専用Gateway／専用cache entrypointを接続する。既存Feed／音源の配信経路は維持する。
5. **CLI・文書**: 内蔵サイトを明示選択できる入力、schema／雛形／利用説明を更新する。Node.js、Wrangler、別R2資格情報を管理者へ要求しない。
6. **検証**: `bun test`、`npm run check`、必要な単体CLI buildとオフライン試験。実Cloudflare試験は対象・範囲の別承認後だけ行う。

受け入れ条件（実機も含む総合確認。ローカルで確認した範囲は§13で区別する）:

- [ ] 外部サイトを用意せずに内蔵Showを作成・明示公開できる。既存外部方式のURL・Feed linkは勝手に変わらない。
- [ ] 一覧の全Episodeで、そのページに留まったままPlay／pause／seekできる。モバイルSafari／Chrome、デスクトップ、キーボード操作で確認する。
- [ ] 0／1／20／21件、同一公開日時、複数一覧ページで順序とリンクが正しい。未再生全音源の一括取得を要求しない。
- [ ] metadata-only／audio-only／同時更新でもEpisode共有URLが変わらず、完了後に正しい承認済み音源を参照する。旧音源・revisionは保持する。
- [ ] 過去revision採用後もページURLを維持し、採用した内容と現在の公開一覧・正規originを表示する。
- [ ] system／stagingの公開パス、ローカルdraft、未承認音源、非公開Episode、管理用メール、運用記録、世代別HTMLの直接指定を配信しない。
- [ ] Show／Episode非公開化、復元、Pause、受付だけ停止、未ready、domain／Worker保守、各種blockedが§8.1と一致する。他Showへ影響を広げない。
- [ ] cache HIT／HEAD／304／Range／redirectでもgateを迂回しない。新旧cache fillの順序逆転、旧HTMLの直接指定、未知path、削除された末尾一覧ページを試験する。
- [ ] HTML・属性注入、危険なURL、RSS由来HTML、CSPを試験する。説明文をそのまま実行可能HTMLにしない。
- [ ] batch途中・IO応答喪失・checkpoint前後・Alarm重複／再起動・purge失敗を注入し、途中候補を公開せず、未知IOを再実行しない。
- [ ] HTMLとFeed／音声のcache・purge範囲が分かれ、片方のpurgeだけで両方を更新済みと判断しない。両方が必要な公開で一方のpurgeが失敗した場合も公開完了にしない。
- [ ] 既存予算内の大件数・大きい説明文で、1 batchのCPU／memory／IOが有界であることを確認する。ローカル境界試験とnative Free性能の証拠を分ける。
- [ ] 別承認のnative試験ではFree契約のまま、Gateway/cache miss CPU、DO Alarm CPU、SQL、duration、要求数、R2履歴容量を測る。欠測を適合済みと説明しない。

## 11. 採用済み方針

| 論点 | 採用方針・確認内容 |
| --- | --- |
| 保存・CDN配信 | **案Bを採用済み**。private R2を使い、サイト専用の配信処理とCDN cache entrypointへ分ける。公開・停止の正本は既存Show DOに置く。別Worker・生成用DOは追加しない（§4.1.1） |
| HTML生成場所 | **既存Show DOでの事前生成を採用**。同DO内のサイト専用処理で生成し、閲覧時には生成しない |
| CLIとDOの分担 | 画像・音声の解析は従来のCLIのまま。新しいHTML生成だけをShow DOへ追加する。HTMLのCLI生成は採用方式に含めない（§4.2.1） |
| ページの構成とURL | 新しい順の20件一覧とその場再生は確認済み。「安定」はタイトル・説明・音源を更新してもEpisode紹介ページのURLを変えない意味。公開停止時にも閲覧できる意味ではない（§5.3） |
| プレイヤー | 独自プレイヤーを作らない方針は確認済み。HTMLの`audio controls`によりSafari／Chrome等が標準UIを表示する。具体例と再生の流れは§5.2 |
| 外部サイト | **Showごとの2択を採用済み**。castloopでサイトを生成するか、管理者の既存サイトを紹介先に使うかを選ぶ。後者では内蔵HTMLを生成せず、既存URLを維持する（§7） |
| Freeの前提 | 有料機能・上限変更なし。サイト用に分離してもアカウントの無料枠は増えない。追加purgeも計上し、native実測前に適合を断言しない |

Show metadataの設定、内部形式・health識別、SQLの生成索引、正常batch引継ぎと未知IOの区別は§13のとおり具体化した。実装・ローカル検証の指示は受けているが、実Cloudflareでの配備・公開・資源変更を許可されたとは扱わない。

## 12. Cloudflare一次資料とブラウザ仕様

以下は2026-10-25に確認した公開資料。認証付きのアカウント操作や実機測定はしていない。

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Freeの10ms・memory・要求数・subrequest。
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Free契約とcache要求の計上。
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/): DOの既定CPU、Alarmのwall time、SQL等の上限。
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): SQLite-backed DOのFree利用と要求・duration・SQL枠。
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard無料枠、operation分類、egressと超過料金。
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/): 公開経路、custom domainとcache、開発用`r2.dev`の制約。
- [Workers Cache](https://developers.cloudflare.com/workers/cache/)、[limitations](https://developers.cloudflare.com/workers/cache/limitations/): 内部entrypointのcache、cache HITの要求計上、purge等。
- [Workers Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)、[purge scope](https://developers.cloudflare.com/workers/cache/purge/): entrypointごとに分離されたcache keyと、呼出し元entrypointだけを対象にするpurge。
- [Workers Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/): 無料の静的要求と`run_worker_first`使用時の違い。
- [MDN: audio](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/audio): ブラウザ標準player、`controls`、先読み指定`preload`。Cloudflare資料ではないが、プレイヤーの実現方法の根拠として参照した。

## 13. 実装と検証の範囲

### 13.1 接続した機能

| 範囲 | 実装 |
| --- | --- |
| metadata・CLI | strictなShow schemaに`site_mode`を追加。`builtin`では`site_url`禁止、`external`／省略では必須。`create-show ID --site-mode builtin`、help・schema・差分previewへ接続。単なる作成／uploadでは公開しない |
| HTML | `src/site-renderer.ts`。日時降順・20件一覧、安定したEpisode URL、標準audio、テキストescape、固定CSSのCSP hash、canonical／OGP。Feedと同じ日時・ID比較を使用 |
| 保存 | `src/site-storage.ts`。不変keyへの条件付きPUT・SHA-256・size確認。1 HTML上限1,000,000 UTF-8 bytes。旧objectを上書き・自動削除しない |
| 生成とSQL | `src/sqlite-site-content.ts`。所有job／保守operation、凍結入力・順序付きEpisode、候補参照、公開ページ参照、サイト全体のFeed世代を分離して保存。最大20 HTML・4,000,000 bytes/batch。通常Episode操作は一覧＋対象ページ、Show更新は全ページ |
| Alarm継続 | `publication_jobs.continuation_ready`を正常batch完了と次回Alarm予約と一緒に保存。claim時に0へ戻してdurability確認後にIOする。0のままのrunningは中断としてblocked。domain専用operationも独立したmarkerを持つ。各batchで全Episodeを再parse／sortしない |
| 原子的な公開 | `src/site-publication.ts`が既存executorを接続。必要なHTML・既存公開保存・media purge・site purgeが確認済みの場合だけ、既存queue完了transaction内でFeedとサイト参照を切り替える。通常job・domainともentrypointごとのpurge成功を別々のflagへ保存する。未知結果は再送しない |
| 配信 | HTML専用`src/site-gateway.ts`と`SiteCachedPages`。同Show DOの最新gateを先に評価し、サイト全体のFeed世代と参照を照合する。R2からstreamし、HEAD／条件付き応答・security headerを維持。内部tag・認証・cookieを外へ持ち出さない |
| readiness・形式 | 既存とHTMLの両cache entrypointのversion/config・cache有効状態とpurgeを検査。内部queue/content **8/9**、health／inspectionに必須`website="static-show-v1"`。旧形式は拒否し、移行しない。既存class/binding/dateは維持 |
| 公開経路 | Show/Episodeの公開・更新、非公開化・復元、保存revision採用、RSS逐次公開、domain再生成へ接続。builtin/external切替も明示Show公開として扱う。RSSの紹介linkはbuiltinだけ内蔵URLへ変える |

閲覧要求ではHTML生成、全metadata parse、全Episode走査をしない。最初の入力検証・凍結と最終の既存公開検証には既存の全体予算を維持する。HTML候補と凍結元も保存量・SQL消費へ算入する。一般的なretry／workflow基盤や別生成DOは追加しない。

### 13.2 ローカル試験

- `src/site.test.ts`: 0／1／20／21件、同日時順、player、HTML注入、URL維持、CSP、immutable PUT、HEAD／304、cache／redirect前のgate、未確認purge。
- `src/sqlite-site-content.test.ts`: ページ数とbytesの二重batch上限、大きい保存済み説明の非切捨て、予算超過、確認前の公開拒否、完了batchの非再送。
- `src/sqlite-publication-executor.test.ts`: 実際のSQLite queue/contentと模擬R2によるサイト公開・更新、方式切替、非公開化／復元、保存revision採用、21件の複数ページ、再起動・受付停止中の継続、旧公開内容の維持、HTML／両purgeの故障、Alarm予約失敗と非再送。
- CLI/domain/RSS試験: 正式CLIの`--site-mode builtin`、domainのcanonical変更・複数batch再起動・未知HTML結果、21件の内蔵RSS公開とGUID／日時維持。R2・REST・cacheは模擬実装を使う。

ローカル確認結果:

- `bun test`: 88 files、788成功・0失敗。
- `npm run check`: 成功。
- `npm run build:cli -- linux-x64`: 成功。
- 生成した単体CLIを資格情報なしで実行し、version／help／describe／schema、内蔵・外部方式の入力検証、builtinとsite_urlの競合拒否を確認した。
- `git diff --check`、新規ファイルの末尾改行・空白、本文書と利用ガイドの相対リンクを確認した。

利用手順は[サイトガイド](../docs/show_website.md)にまとめた。これらはローカルの模擬環境と単体CLIの確認であり、次節の実機結果を含まない。

### 13.3 承認済みの実機試験と未確認の範囲

別途明示承認された[Access保護付き試験](show_website_private_trial_verification_20261025.md)では、専用のfresh環境でShowとEpisode 3件の通常公開が成功した。本人からブラウザアクセス・3件再生成功の報告を得た。閲覧前後それぞれの未認証30要求もAccessへ転送され、コンテンツを取得できなかった。既存の保持環境・DNS・私有journal・原本・証跡は変更していない。

§10の受け入れ条件のうち、Episode個別ページ・シーク・モバイル／キーボード操作、native cache HIT／fill競合、Cloudflare Alarm/output gateの異常系、FreeのHTTP CPU・DO CPU・duration・SQL・要求数・容量測定等は未確認。小規模な正常公開・再生を全条件の合格や全Free枠適合と説明しない。Issue #70は継続し、見栄えの改善と残る検証を後続で扱う。
