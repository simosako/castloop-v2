# 番組サイトとEpisodeページ（Issue #70開発版）

Issue #70の第1段に、標準デザイン、Showごとの任意CSS 1ファイル、説明の抜粋と安全な本文リンク、自動短縮URL、公開日表示のタイムゾーン設定を追加した開発版。合意した機能実装と本人の画面確認は完了した。Cloudflare Free性能の実証や全端末での確認を意味しない。

フェーズ2開発版の新規13/13環境向け。healthとinspectionは`website="static-show-v2"`を使う。サービス設定はversion 2・`show-v1`、metadataはversion 1。旧環境の変換・移行・資源採用は提供しない。Feed/HTMLはSQLiteからオンデマンド生成し、素材だけR2へ直接配置する。実環境には未配備。

## サイト方式を選ぶ

新規サービスを初期化し、対象への登録・公開を承認した後の操作例:

```sh
castloop create-show my-show --site-mode builtin
castloop show-resume my-show NEW_WINDOW_UUID
# Edit my-show/show.toml and provide the cover named in image_path.
castloop publish-show my-show
```

`create-show`はShow登録とローカル雛形作成だけで、公開しない。`publish-show`がローカル入力を検証・素材配置し、同期公開結果`changed`／`unchanged`とrevisionを返す。

内蔵方式の`show.toml`には次を指定する。他の番組情報・カバーは従来どおり必要である。

```toml
site_mode = "builtin"
# Do not set site_url for builtin websites.
```

外部サイトを使う場合:

```sh
castloop create-show my-show --site-mode external --site-url https://your-site.example/podcast
```

TOMLでは`site_mode = "external"`と実在するHTTP(S)の`site_url`を指定する。`site_mode`省略時も外部方式として扱い、URLを必須にする。外部方式ではHTMLを生成せず、RSSの紹介先は指定URLのまま。内蔵方式と`site_url`の同時指定は拒否する。

方式変更は`show.toml`を編集し、preview後に`publish-show`で明示する。内蔵から外部に変えると内蔵ページは404、逆では公開済みEpisodeのページを配信する。旧音源・revisionは削除しない。

## 見た目の変更

内蔵サイトの`show.toml`へ任意の1ファイルを明示指定する。省略すれば標準デザインを使う。

```toml
site_mode = "builtin"
site_css_path = "site.css"
```

`site.css`は`show.toml`と同じdirectoryへ置く。[変更例](../examples/show-site.css)を利用できる。通常のUTF-8 CSSだけを受け付け、上限は65,536 bytes（64 KiB）。空ファイルは追加CSSなし、指定ファイルの欠落はエラー。URL・directory指定・symlink・不正UTF-8・NUL・`</style`（大小文字不問）は拒否する。CRLF／CRはLFへ正規化する。CSS本文の`site_css`はCLIが生成する保存用fieldなので、ローカルTOMLに直接書かない。

編集後にpreviewし、`publish-show SHOW`で一覧・Episodeページの表示内容を一緒に更新する。標準へ戻す場合は`site_css_path`を削除して明示公開する。ファイル編集だけでは公開せず、Worker再配備も不要。

標準CSSの後にカスタムCSSを埋め込む。よく使う変数は`--cl-accent`、`--cl-background`、`--cl-text`、`--cl-muted`、`--cl-content-width`、`--cl-radius`。指定先のclassは次のとおり。

| 範囲 | class |
| --- | --- |
| 全体・ページ種別 | `cl-site`、`cl-page-list`、`cl-page-episode` |
| 共通部分 | `cl-header`、`cl-brand`、`cl-subscribe`、`cl-main` |
| 番組紹介 | `cl-show`、`cl-cover`、`cl-author`、`cl-description` |
| Episode | `cl-episode-list`、`cl-episode`、`cl-episode-title`、`cl-episode-date`、`cl-player`、`cl-audio-link` |
| 説明文 | `cl-description`、`cl-description-full`、`cl-description-link`、`cl-read-more` |
| ページ送り | `cl-pagination` |

変数・classは公開した指定先として扱うが、内部の要素の深さや子要素番号は保証しない。CSSでplayerやfocusを隠すことは防げないため、変更後の操作性は管理者が確認する。標準playerの内部UIはブラウザ依存である。公開日は下記のShow設定で表示し、`datetime`属性に元の公開日時を保持する。

HTML構造・表示内容の変更、独自JS、外部CSSのimport、Web font、追加画像のuploadは提供しない。外部画像・font・data URLは既存CSPでも許可しない。Sass等を使う場合の変換は管理者側で行い、castloopに追加runtimeは不要。高度な変更には既存の外部サイト方式を使う。

CSSはShow revisionの一部として保存する。Episode更新・復元では現在のShowのCSSを、Showの過去版採用ではその版のCSSを使う。domain再生成も保存内容だけで行い、ローカルファイルや外部buildを必要としない。CSSは各HTMLと履歴へ重複して保存され、既存のHTML・batch予算とR2無料枠へ算入する。履歴は自動削除しない。

RSS取り込みでも、最初の公開前に取り込み元directoryのShow TOMLへ指定し、同じ場所へCSSを置いてレビューする。公開入力へ固定し、取り込み先へ保存する。開始後にCSSを変更して既存処理を続行しない。

## 公開日表示のタイムゾーン

内蔵サイトの`show.toml`に任意で指定する。未設定ならUTCで表示する。

```toml
site_mode = "builtin"
site_timezone = "Asia/Tokyo"
```

一覧とEpisode個別ページの公開日を、その地域の日付と公開時点のUTCとの差で表示する。例えば`published_at = "2025-12-16T22:00:00Z"`は、UTCでは`2025-12-16 (UTC+00:00)`、`Asia/Tokyo`では`2025-12-17 (UTC+09:00)`になる。時刻は表示しない。夏時間のある地域では各Episodeの公開時点の規則を適用し、例えばNew Yorkは冬`UTC-05:00`・夏`UTC-04:00`となる。

`UTC`またはruntimeが対応するIANA名（`Asia/Tokyo`、`America/New_York`等）を指定する。`JST`・`EST`等の略称、数値offsetだけの指定、未知の地域名はエラーとし、UTCへ自動で戻さない。外部サイト方式ではこの設定を指定しない。

変更後は`publish-show SHOW`で**全一覧・全公開Episodeページ**の表示を更新する。設定を削除して明示公開すればUTCへ戻る。Show revisionに設定を保存するため、Showの過去版採用ではその版、Episode更新・復元では現在のShow設定を使う。

変えるのはHTMLの表示だけであり、保存済み`published_at`、RSSの`pubDate`、新しい順の並び、GUID、短いURL、音源は変えない。[管理用設定](admin_configuration.md)の`castloop-admin.toml timezone`はCLIの日時入力・確認用で、サイト表示へは流用しない。PCや閲覧者のタイムゾーンからも推測しない。

変換にはWorker標準の`Intl.DateTimeFormat`を使い、1回のHTML生成batch内で使い回す。閲覧時の変換・追加JavaScript・新しい依存やサービスはない。生成数・既存batch予算は変えず、native Free性能の実測結果は未取得。[採用設計](../design/show_website_timezone_plan.md)も参照する。

## URLとプレイヤー

`public_base_url`が`https://podcasts.example.com`の場合:

| 内容 | URL |
| --- | --- |
| 新しい順の先頭20件 | `https://podcasts.example.com/podcasts/my-show/` |
| 21件目以降 | `https://podcasts.example.com/podcasts/my-show/page/2/` |
| Episode紹介 | `https://podcasts.example.com/podcasts/my-show/db0a48404cdf5c53/` |
| RSS | `https://podcasts.example.com/podcasts/my-show/feed.xml` |

同じ公開日時の回はEpisode ID順。一覧の説明はタグを除き、文字参照（`&amp;`等）を一度だけ文字へ戻し、段落・改行を空白へまとめた先頭160 Unicode文字を表示する。超える場合だけ`…`を付ける。説明文全体と「全文を読む」は既存のEpisodeページへのリンクで、個別ページに文章全文を表示する。本文が空なら説明リンクを作らず、タイトルから移動できる。末尾の`/`を含む上記形式だけを受け付け、`page/1/`や世代別HTMLの直接URLは提供しない。

Episodeページの識別子は、Episode ID全体のSHA-256から先頭16文字の小文字16進数を自動で割り当てる。管理者がslugを入力する設定はない。同じShow内で衝突した場合、新しい回だけ4文字ずつ延ばす（最大64文字）。対応はShowのSQLiteへ永久予約し、非公開化や失敗・中断でも他の回へ再利用しない。外部サイト方式で公開したEpisodeにも予約を保持し、後で内蔵方式へ変更しても同じ規則を使う。

ページ入口はShow直下の短いもの一つだけであり、`e/`付き・`episodes/<episodeId>/`付きのページ入口や旧URLからの転送はない。一覧・RSS item link・canonical・OGPは同じ短いURLを使う。内部Episode ID・GUID・音源URLの`episodes/<episodeId>/<revisionId>.mp3`は変えない。短縮ハッシュ自体にはアクセス制御の効果はない。

全文とShow紹介では段落`p`・改行`br`と、安全なHTTP(S)リンク`a`を作り直す。本文中の`http://`・`https://`のURLは自動でリンクにし、元の`a`はHTTP(S)の絶対URLに限って表示文字列とリンク先を復元する。認証情報付きURL、相対URL、`javascript:`等の別scheme、制御文字・backslashを含むリンク先はリンクにせず本文を残す。元のイベント属性・装飾・`target`等は引き継がず、リンクは同じタブで開く。一覧の抜粋内には外部リンクを作らず、全文ページへのリンクだけを置く。

箇条書き等の境界は改行とし、script・style・埋込み・フォーム等は内容ごと除く。プレーンテキストの改行は維持する。元のmetadataやRSSの説明文は変更しない。meta／OGPにはタグなしの抜粋を使う。処理は公開時だけで、閲覧時の解析・追加JS・全文取得APIはない。番組紹介の著者名は表示するが、`copyright`だけを置くフッターは表示しない。RSSの著作権情報は維持する。

同じタブで個別ページへ移動すると一覧の再生は終了する。再生を続けながら読む場合はブラウザの操作で別タブに開く。player自体は説明リンクの外にあるため、再生操作だけでページ移動はしない。

各回の`<audio controls preload="none">`にSafari・Chrome等が標準の再生／停止／シークUIを表示する。Playで既存の承認済みMP3配信経路へアクセスし、ページ遷移なしで再生する。自動再生・全音源の一括先読み・独自JavaScriptプレイヤーは使わない。先読み指定の細部やUIはブラウザに依存する。

EpisodeページのURLはmetadata-only／audio-only更新、保存済みrevision採用でも変わらない。完了後のHTMLが承認済み音源のURLを指す。非公開化した回は一覧から消え、ページ・音源も配信しない。復元は保存済み内容を使い、GUID・日時・音源identityを保持する。Show復元は個別に非公開化した回を復活させない。

内蔵方式ではRSSの番組link・image linkを番組トップへ、各itemのlinkをEpisodeページへ設定する。GUIDやenclosureの意味は変更しない。

## 更新・停止・保守

- HTMLは確定済みSQLite内容からオンデマンド生成し、HTML専用Gatewayと`SiteCachedPages`のCDN cacheで配信する。Feed／画像／音源の`SqliteCachedAssets`とはcache・purgeを分ける。
- 必要なpurge後、内容と世代を同じSQLiteトランザクションで切り替える。パージやDB失敗では現在内容を維持する。HTML事前生成batch・R2 HTML保存・公開jobは使わない。
- 旧形式へのcode-only deploy・DB変換は行わない。現行形式同士のcode更新は通常の保守手順で行う。
- 1 HTMLは1,000,000 bytes以下。公開件数・JSON・Feed予算も適用し、超過を切り詰めない。全件Feed生成などの負荷は残る。
- `show-admission-pause`は新規受付を止め、確定済み内容の配信を続ける。`show-pause`はHTML・画像・音源も停止する。cache HIT、HEAD、304、旧workers.devからのredirectの前にも最新のShow判定を行う。
- domain変更は[専用保守](sqlite_custom_domains.md)でHTMLのcanonical／OGPとFeedを新originへ生成する。全Showの保守完了後も自動Resumeしない。code-only deployでdomainを変更しない。
- 短い識別子は公開時に確定して索引へ保存する。閲覧時は内部Episode IDを解決し、公開・停止・readiness判定を通してHTML cacheへ進む。
- RSS previewはサーバーから取得した予約を使い、新規Episodeには未予約の候補を表示する。previewで予約・公開はしない。候補の確定は明示公開の処理で行う。
- 保存済みHTMLや再生buffer、検索・SNSの第三者コピーを遠隔消去することはできない。

## RSS取り込み

download後、**最初の公開前**に取り込み先の`show.toml`へ`site_mode = "builtin"`を追加し、`site_url`を削除してレビューする。その後の`publish-rss-import`は同じ公開経路で各回のページも生成する。設定を変えなければ元RSSの外部サイトURLを維持する。公開開始後は凍結入力を変更せず、未知処理を別jobでやり直さない。

## Cloudflare Freeの前提と検証範囲

有料機能・CPU上限拡張・別Worker／生成用DOを追加しない。画像・音声の解析とupload検証は従来どおりCLI、HTML生成だけをShow DOに置く。管理者にWrangler・Node.js・別R2資格情報は不要。

無料で無制限のhostingではない。CDN HITでも外側Worker・内側cache entrypointとShow DOの判定を使うため、要求数・DO duration・SQL・R2 operation・履歴容量を**同一アカウントのFree枠へ合算**する。Feed/HTMLのキャッシュミス時には生成CPUも使う。

ローカルのSQL/R2/cache/REST模擬試験・型検査・単体CLI buildは、Cloudflare FreeのHTTP CPU 10msやDO既定CPU上限への適合証拠ではない。実Cloudflareでの配備・CPU／要求数／duration／容量測定、Safari／Chrome実機での再生・シーク確認は別承認で行う。詳しい比較・予算・受け入れ条件は[設計](../design/show_website_plan.md)参照。

別途承認された[非公開の実機試験](../design/show_website_private_trial_verification_20261025.md)では、新規環境でShowと3 Episodeを公開し、本人からブラウザでのアクセス・3件再生成功の報告を得た。閲覧後の未認証要求もAccessで拒否された。個別ページ・シーク・スマートフォン・CPU性能等の未確認範囲は同記録で区別する。

2026-10-26には明示承認を受け、上記の短尺試験環境を削除して、[標準デザインと通常音源3件の別環境](../design/show_website_css_large_trial_verification_20261026.md)を作成し、本人から再生成功の報告を得た。その後の説明表示版のレビューを経て、同環境を退避・削除し、[自動短縮URL・リンク表示版の新規非公開環境](../design/show_website_short_url_trial_verification_20261026.md)を作成した。約53.7〜62.9 MBのMP3の全量hash、短いページURL、元のリンク復元、フッター非表示、公開前後の未認証30要求拒否を確認し、本人からも当該変更の画面更新確認を得た。2026-10-27には別承認で[同環境をタイムゾーン版へ更新](../design/show_website_timezone_trial_verification_20261027.md)し、一覧・個別ページの東京設定と更新前後の未認証拒否を確認した。本人もブラウザで東京の日付表示を確認した。カスタムCSSの実機公開、native CPU性能、スマートフォン／キーボードの実機確認等は未完了である。これらの実機結果は統合前10/11環境のものであり、予約公開統合後11/11版は未配備。試験環境をそのまま保持し、互換更新はしない。
