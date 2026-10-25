# 番組サイトとEpisodeページ（Issue #70開発版）

新規環境向けの内蔵サイト機能。配布済みv0.7.5ではなく、この開発版のCLIとWorkerを組み合わせる。内部queue/content形式は**8/9**、healthとinspectionの必須識別は`website="static-show-v1"`。サービス設定は引き続きversion 2・`storage_layout="show-v1"`、Show/Episode metadataはversion 1である。既存環境のDB変換・移行・資源採用は提供しない。

## サイト方式を選ぶ

新規サービスを初期化し、対象への登録・公開を承認した後の操作例:

```sh
castloop create-show my-show --site-mode builtin
castloop show-resume my-show NEW_WINDOW_UUID
# Edit my-show/show.toml and provide the cover named in image_path.
castloop update-show my-show
castloop publish-show my-show
```

`create-show`はShow登録とローカル雛形作成、`update-show`は検証済み素材の保存だけを行う。どちらも公開しない。`publish-show`の同じjobが`succeeded`になるまで公開完了とは扱わない。

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

方式の変更は`show.toml`を編集し、`update-show`→`publish-show`で明示的に行う。内蔵から外部に変えると内蔵ページは404になり、逆の場合は公開済みEpisodeから全ページを生成する。旧HTML・音源・revisionは削除しない。

## URLとプレイヤー

`public_base_url`が`https://podcasts.example.com`の場合:

| 内容 | URL |
| --- | --- |
| 新しい順の先頭20件 | `https://podcasts.example.com/podcasts/my-show/` |
| 21件目以降 | `https://podcasts.example.com/podcasts/my-show/page/2/` |
| Episode紹介 | `https://podcasts.example.com/podcasts/my-show/episodes/first/` |
| RSS | `https://podcasts.example.com/podcasts/my-show/feed.xml` |

同じ公開日時の回はEpisode ID順。一覧には短い説明、Episodeページには説明全文をテキストとして表示する。HTMLタグは実行しない。末尾の`/`を含む上記形式だけを受け付け、`page/1/`や世代別HTMLの直接URLは提供しない。

各回の`<audio controls preload="none">`にSafari・Chrome等が標準の再生／停止／シークUIを表示する。Playで既存の承認済みMP3配信経路へアクセスし、ページ遷移なしで再生する。自動再生・全音源の一括先読み・独自JavaScriptプレイヤーは使わない。先読み指定の細部やUIはブラウザに依存する。

EpisodeページのURLはmetadata-only／audio-only更新、保存済みrevision採用でも変わらない。完了後のHTMLが承認済み音源のURLを指す。非公開化した回は一覧から消え、ページ・音源も配信しない。復元は保存済み内容を使い、GUID・日時・音源identityを保持する。Show復元は個別に非公開化した回を復活させない。

内蔵方式ではRSSの番組link・image linkを番組トップへ、各itemのlinkをEpisodeページへ設定する。GUIDやenclosureの意味は変更しない。

## 更新・停止・保守

- HTMLは既存Show DOのAlarmで事前生成し、private R2へ不変保存する。閲覧時には生成せず、HTML専用Gatewayと`SiteCachedPages`のCDN cacheで配信する。Feed／画像／音源の`SqliteCachedAssets`とはcache・purgeを分ける。
- 1 batch（1回のAlarmで処理する生成単位）は最大20 HTML・合計4,000,000 UTF-8 bytes、1 HTMLは1,000,000 bytes以下。全入力には既存の公開件数・JSON容量予算も適用する。超過を切り詰めて公開しない。
- 正常なbatch完了と次回Alarm予約を保存した場合だけ次のbatchへ進む。実行中断・未知のPUTやpurgeは`blocked`として保全し、再送しない。
- HTML、Feed、必要な音源・metadataの保存確認と両方の必要なpurgeが完了してから、公開参照を同じSQL transactionで切り替える。通常更新中は検証済みの旧内容だけを配信する。
- `show-admission-pause`は新規受付を止め、確定済み内容の配信を続ける。`show-pause`はHTML・画像・音源も停止する。cache HIT、HEAD、304、旧workers.devからのredirectの前にも最新のShow判定を行う。
- domain変更は[専用保守](sqlite_custom_domains.md)でHTMLのcanonical／OGPとFeedを新originへ生成する。全Showの保守完了後も自動Resumeしない。code-only deployでdomainを変更しない。
- 保存済みHTMLや再生buffer、検索・SNSの第三者コピーを遠隔消去することはできない。

## RSS取り込み

download後、**最初の公開前**に取り込み先の`show.toml`へ`site_mode = "builtin"`を追加し、`site_url`を削除してレビューする。その後の`publish-rss-import`は同じ公開経路で各回のページも生成する。設定を変えなければ元RSSの外部サイトURLを維持する。公開開始後は凍結入力を変更せず、未知処理を別jobでやり直さない。

## Cloudflare Freeの前提と検証範囲

有料機能・CPU上限拡張・別Worker／生成用DOを追加しない。画像・音声の解析とupload検証は従来どおりCLI、HTML生成だけをShow DOに置く。管理者にWrangler・Node.js・別R2資格情報は不要。

無料で無制限の静的hostingではない。HTMLがCDN HITでも外側Worker・内側cache entrypointとShow DOの判定を使うため、それらの要求数、DO duration・SQL、R2 operation・履歴容量を**同一アカウントのFree枠へ合算**する。HTML履歴は自動削除しない。大量のRSS逐次公開では一覧の再生成が累積する。

ローカルのSQL/R2/cache/REST模擬試験・型検査・単体CLI buildは、Cloudflare FreeのHTTP CPU 10msやDO既定CPU上限への適合証拠ではない。実Cloudflareでの配備・CPU／要求数／duration／容量測定、Safari／Chrome実機での再生・シーク確認は別承認で行う。詳しい比較・予算・受け入れ条件は[設計](../design/show_website_plan.md)参照。
