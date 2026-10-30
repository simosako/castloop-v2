# 番組サイトとEpisodeページ

内蔵サイトは、番組の一覧・Episodeページと、ブラウザ標準の音声プレイヤーを提供します。標準デザインをそのまま使うか、ShowごとのCSS 1ファイルで見た目を調整できます。外部のWebサイトを紹介先にすることも可能です。

サービス作成は[はじめに](getting_started.md)、編集内容の反映は[公開・更新](publishing.md)を参照してください。ファイルを編集しただけではサイトは変わりません。

## サイト方式を選ぶ

新規サービスを初期化し、対象への登録・公開を承認した後の操作例:

```sh
castloop create-show my-show --site-mode builtin
# Edit my-show/show.toml and provide the cover named in image_path.
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH
```

`create-show`はShow登録とローカル雛形作成だけで、公開しない。`publish-show`がローカル入力を検証・素材配置し、同期公開結果`changed`／`unchanged`とrevisionを返す。

上の例はサービスワークスペースで実行します。`REVIEWED_HASH` は確認した `input_fingerprint` に置き換えてください。内蔵方式の `show.toml` には次を指定します。他の番組情報・カバーも必要です。

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

CSSはShowの保存内容と履歴に含まれます。Episode更新・復元では現在のShowのCSS、Showの過去版採用では選んだ版のCSSを使います。反映後のサイト配信に、管理端末や外部ビルドを起動しておく必要はありません。

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

変えるのはHTMLの表示だけで、保存済み `published_at`、RSSの `pubDate`、並び順、GUID、URL、音源は変えません。[管理用設定](scheduling.md#任意の管理用設定)の `castloop-admin.toml timezone` はCLIの日時入力・確認用であり、サイト表示には使いません。PCや閲覧者のタイムゾーンからも推測しません。

日付はサーバー側で表示用に変換し、閲覧者のブラウザでの変換や追加JavaScriptは使いません。

## URLとプレイヤー

`public_base_url`が`https://podcasts.example.com`の場合:

| 内容 | URL |
| --- | --- |
| 新しい順の先頭20件 | `https://podcasts.example.com/podcasts/my-show/` |
| 21件目以降 | `https://podcasts.example.com/podcasts/my-show/page/2/` |
| Episode紹介 | `https://podcasts.example.com/podcasts/my-show/db0a48404cdf5c53/` |
| RSS | `https://podcasts.example.com/podcasts/my-show/feed.xml` |

同じ公開日時の回はEpisode ID順。一覧の説明はタグを除き、文字参照（`&amp;`等）を一度だけ文字へ戻し、段落・改行を空白へまとめた先頭160 Unicode文字を表示する。超える場合だけ`…`を付ける。説明文全体と「全文を読む」は既存のEpisodeページへのリンクで、個別ページに文章全文を表示する。本文が空なら説明リンクを作らず、タイトルから移動できる。末尾の`/`を含む上記形式だけを受け付け、`page/1/`や世代別HTMLの直接URLは提供しない。

Episodeページの短い識別子は自動で割り当てます。管理者がslugを指定する設定はありません。非公開化しても他の回へ使い回さず、外部方式から内蔵方式へ変更した場合も保存された対応を使います。短いURL自体にアクセス制御の効果はありません。

一覧・RSS item link・canonical・OGPは同じ短いページURLを使います。`e/` や `episodes/<episodeId>/` 形式のページ入口は提供しません。Episode ID・GUID・音源URLは、ページの短い識別子とは別です。

全文とShow紹介では段落`p`・改行`br`と、安全なHTTP(S)リンク`a`を作り直す。本文中の`http://`・`https://`のURLは自動でリンクにし、元の`a`はHTTP(S)の絶対URLに限って表示文字列とリンク先を復元する。認証情報付きURL、相対URL、`javascript:`等の別scheme、制御文字・backslashを含むリンク先はリンクにせず本文を残す。元のイベント属性・装飾・`target`等は引き継がず、リンクは同じタブで開く。一覧の抜粋内には外部リンクを作らず、全文ページへのリンクだけを置く。

箇条書き等の境界は改行とし、script・style・埋込み・フォーム等は内容ごと除く。プレーンテキストの改行は維持する。元のmetadataやRSSの説明文は変更しない。meta／OGPにはタグなしの抜粋を使う。公開時に描画の妥当性を検査し、配信のキャッシュミス時にサーバーで説明文を解析してHTMLを生成する。ブラウザ側の解析・追加JS・全文取得APIはない。番組紹介の著者名は表示するが、`copyright`だけを置くフッターは表示しない。RSSの著作権情報は維持する。

同じタブで個別ページへ移動すると一覧の再生は終了する。再生を続けながら読む場合はブラウザの操作で別タブに開く。player自体は説明リンクの外にあるため、再生操作だけでページ移動はしない。

各回の`<audio controls preload="none">`にSafari・Chrome等が標準の再生／停止／シークUIを表示する。Playで既存の承認済みMP3配信経路へアクセスし、ページ遷移なしで再生する。自動再生・全音源の一括先読み・独自JavaScriptプレイヤーは使わない。先読み指定の細部やUIはブラウザに依存する。

EpisodeページのURLはmetadata-only／audio-only更新、保存済みrevision採用でも変わらない。完了後のHTMLが承認済み音源のURLを指す。非公開化した回は一覧から消え、ページ・音源も配信しない。復元は保存済み内容を使い、GUID・日時・音源identityを保持する。Show復元は個別に非公開化した回を復活させない。

内蔵方式ではRSSの番組link・image linkを番組トップへ、各itemのlinkをEpisodeページへ設定する。GUIDやenclosureの意味は変更しない。

## 更新・停止・保守

- HTMLは確定済みの内容から閲覧時に生成・キャッシュします。通常の内容変更にWorkerの再配備は不要です。
- 条件付き応答は本文のETagで判定し、HTMLには `Last-Modified` を送りません。
- 1ページのHTML上限は1,000,000 bytesです。公開件数・JSON・RSSの上限も適用し、超過を切り詰めて公開しません。
- 配信停止には[非公開化・復元](lifecycle.md)を使います。キャッシュがあっても公開可否の判定を通します。
- 公開URLの変更は[独自ドメイン](custom_domains.md)、Workerコード更新は[サービス保守](maintenance.md)の手順です。
- RSSプレビューの新規ページURLは候補であり、公開時に確定します。プレビューだけでは公開しません。
- 保存済みHTML・再生バッファーや、検索・SNS等の第三者コピーを遠隔消去することはできません。

## RSS取り込み

download後、**最初の公開前**に取り込み先の`show.toml`へ`site_mode = "builtin"`を追加し、`site_url`を削除してレビューする。その後の`publish-rss-import`は同じ公開経路で各回のページを配信可能にする。HTML自体は閲覧時に生成する。設定を変えなければ元RSSの外部サイトURLを維持する。公開開始後は凍結入力を変更せず、中断時は同じ取り込み入力と進捗記録で続行する。

## Cloudflare Freeの前提と検証範囲

無料で無制限のホスティングではありません。キャッシュヒットでもWorkerとShow DOの処理を使うため、要求数・実行時間・SQL・R2操作・履歴容量を同一アカウントの利用量に算入します。キャッシュミスではRSS・HTML生成のCPUも使います。CLIは料金プランやCPU上限を自動変更しません。

現行版の小規模な非公開実機確認は、再生と東京日付表示の確認を含みますが、性能測定・全ブラウザ・モバイル・キーボード操作・全Free適合の証明ではありません。[リリースノートの検証範囲](release-v0.8.0.md#verification-and-limitations)を参照してください。

内部のURL割当・配信・キャッシュは[配信設計](../design/components/delivery.md)、追加の実機試験は[検証の責務](../design/testing.md)と[保護条件](../design/security.md#非公開の実機試験)に従います。
