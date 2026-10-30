# 入力例

ここには、現行CLIが受け付ける入力形式の最小例を置いています。**そのまま公開するための素材ではありません。** 実際の作業は [create-show / create-episode](../docs/getting_started.md) で作成したTOMLを編集し、生成済みのID・GUID・公開日時を例の値で上書きしないでください。

| ファイル | 用途 |
| --- | --- |
| [show.toml](show.toml) | 内蔵サイトを使う番組の最小例。`image_path` のカバーは別途用意 |
| [episode.toml](episode.toml) | Episodeメタデータの最小例。初回公開のMP3はコマンド引数で指定 |
| [show-site.css](show-site.css) | 内蔵サイトの色・幅などの変更例。利用する場合はShow TOMLと同じ場所に置き、`site_css_path = "show-site.css"` を指定 |

外部サイトを使う場合は `site_mode = "external"` と実際の `site_url` を指定します。内蔵サイト専用の `site_timezone`・`site_css_path` は外してください。内蔵サイトでは `site_url` を指定しません。

任意項目の説明付き例は [Showテンプレート](../design/show-template.toml)・[Episodeテンプレート](../design/episode-template.toml)、正確な条件は[スキーマ](../design/data/schemas.md)を参照してください。設計用テンプレートも説明用で、CLIがこれらのファイルを読み込んで雛形を生成するわけではありません。

## CLIから確認する

```sh
castloop template show
castloop template episode
castloop template service-config
castloop template admin-config
castloop validate show examples/show.toml --json
castloop validate episode examples/episode.toml --json
```

上の検査例はリポジトリのルートで実行します。素材や公開先の状態までは確認しないため、成功しても公開可能とは限りません。編集した実ファイルの確認方法は[公開・更新](../docs/publishing.md)、CSSは[番組サイト](../docs/show_website.md)を参照してください。

`template service-config` は形式の例で、サービスや管理キーを作りません。サービス作成には `init` を使い、例の設定で既存のCloudflare資源を採用しないでください。
