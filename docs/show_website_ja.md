# 番組サイト

castloopの内蔵サイトでは、番組紹介、エピソード一覧、各エピソードのページを公開できます。各ページから音声を再生できます。

以下のコマンドは、サービスのワークスペースで実行してください。

## 番組サイトを使う

新しい番組を作るときに、`--site-mode builtin` を指定します。

```sh
castloop create-show my-show --site-mode builtin
```

`my-show/show.toml` に番組情報を入力し、カバー画像を用意します。続けて[プレビューと公開](publishing_ja.md)を行ってください。

公開後は、`castloop.toml` の `public_base_url` に続けて `/podcasts/my-show/` を開きます。

| ページ | URLの例 |
| --- | --- |
| 番組トップ・エピソード一覧 | `https://podcasts.example.com/podcasts/my-show/` |
| 一覧の2ページ目 | `https://podcasts.example.com/podcasts/my-show/page/2/` |
| エピソードの個別ページ | `https://podcasts.example.com/podcasts/my-show/db0a48404cdf5c53/` |
| RSS | `https://podcasts.example.com/podcasts/my-show/feed.xml` |

一覧は新しい順に20件ずつ表示されます。エピソードのタイトルや「全文を読む」から個別ページへ移動できます。個別ページのURLは自動で決まり、内容や音声を更新した後も同じURLを使えます。

## 見た目を変える

### 1. CSSを用意する

`my-show/` に `site.css` を作ります。[CSSの例](../examples/show-site.css)をコピーして編集しても構いません。

色や幅は、次のように指定できます。

```css
:root {
  --cl-accent: #2563eb;
  --cl-background: #f8fafc;
  --cl-text: #0f172a;
  --cl-content-width: 60rem;
}
```

### 2. CSSファイルを指定する

`my-show/show.toml` に次を設定します。

```toml
site_mode = "builtin"
site_css_path = "site.css"
```

CSSはUTF-8で保存し、64 KiB以下にしてください。

### 3. 公開して表示を確認する

まずプレビューを実行し、内容を確認します。結果の `input_fingerprint` を `REVIEWED_HASH` に入れて公開してください。

```sh
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH --json
```

公開後、一覧と個別ページの表示、音声プレイヤー、リンクの操作を確認してください。

標準の見た目に戻す場合は、`site_css_path` の行を削除して同じ手順で公開します。

### CSSで使える主な指定先

| 変更する部分 | CSS変数・クラス |
| --- | --- |
| 色 | `--cl-accent`、`--cl-background`、`--cl-text`、`--cl-muted` |
| 幅・角の丸み | `--cl-content-width`、`--cl-radius` |
| ページ全体 | `.cl-site`、`.cl-page-list`、`.cl-page-episode` |
| ヘッダー | `.cl-header`、`.cl-brand`、`.cl-subscribe` |
| 番組紹介 | `.cl-show`、`.cl-cover`、`.cl-author`、`.cl-description` |
| エピソード | `.cl-episode-list`、`.cl-episode`、`.cl-episode-title`、`.cl-episode-date` |
| 音声プレイヤー・音声リンク | `.cl-player`、`.cl-audio-link` |
| 説明文・全文へのリンク | `.cl-description-full`、`.cl-description-link`、`.cl-read-more` |
| ページ送り | `.cl-pagination` |

## 公開日表示のタイムゾーン

日本の日付で表示したい場合は、`show.toml` に次を追加します。

```toml
site_timezone = "Asia/Tokyo"
```

設定後、番組情報をプレビューして公開します。一覧と個別ページの日付が日本時間になります。例えば `2025-12-16T22:00:00Z` は、`2025-12-17 (UTC+09:00)` と表示されます。

既定の表示はUTCです。他の地域には `America/New_York` などのIANAタイムゾーン名を指定できます。

予約を入力するときのタイムゾーンは、[管理用設定](scheduling_ja.md#任意の管理用設定)で指定します。

## 外部サイトを使う

番組の紹介先として自分のWebサイトを使う場合は、URLを指定して番組を作ります。

```sh
castloop create-show my-show --site-mode external --site-url https://your-site.example/podcast
```

既存の番組を外部サイトに切り替える場合は、`show.toml` のサイト設定を次の形にします。`site_css_path` と `site_timezone` を設定している場合は、その行を削除してください。

```toml
site_mode = "external"
site_url = "https://your-site.example/podcast"
```

プレビューして公開すると、RSSの紹介先が指定したURLになります。内蔵サイトから切り替えた場合は、castloop側の番組ページの配信が終了します。

内蔵サイトに戻すときは、`site_mode = "builtin"` に変更し、`site_url` の行を削除して公開します。

RSSから番組を取り込む場合も、公開前にこのサイト設定を選べます。詳しくは[RSS取り込み](rss_migration_ja.md)を参照してください。
