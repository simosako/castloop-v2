# RSS取り込みの設計

RSS取り込みは、外部Podcastのメタデータと素材をローカルへ保存し、内容を確認した後、新規Showとして公開する機能である。元サービスの変更、旧Feedのリダイレクト、購読者の移行完了までは行わない。

## 入出力と段階

| 処理 | 入力 | 出力・副作用 |
| --- | --- | --- |
| `import-rss --dry-run` | 新規Show ID、RSS URL | 件数、音声申告サイズ、必須項目不足、警告。Cloudflareを変更しない |
| `import-rss --output` | 同上、保存先 | RSSスナップショット、TOML、素材、ダウンロード完了記録 |
| `publish-rss-import` | 保存済み取り込みディレクトリ、サービス設定 | 新規Show登録、素材配置、ShowとEpisodeの順次公開、結果Feedの照合 |

ダウンロードと公開を分離する。TOMLの修正は公開前に行い、元のGUID・公開日時等の同一性は保持する。

## 外部取得

RSS URLと素材URLはHTTP(S)に限定し、認証情報、フラグメント、独自ポート、localhostを拒否する。DNSの全結果が公開アドレスであることを検査し、検査したアドレスへ接続する。リダイレクトごとに再検査し、HTTPSからHTTPへの変更を拒否する。リダイレクトは最大5回。

圧縮応答は受け付けず、申告サイズと実際の読取量を検査する。RSSと保存済みXMLは8 MiB、カバーは5,000,000 bytes、音声1本は300,000,000 bytesまで。取得結果は空でないこと、宣言された長さと一致することを確認する。

## ローカル保存

```text
取り込みディレクトリ/
├── source.xml
├── import.json
├── show.toml
├── cover.bin・cover.jpg または cover.png
├── episode-<episode_id>.toml
├── <episode_id>.mp3
└── .castloop/rss-import-downloads/
    ├── control.json
    ├── cover.json
    └── <episode_id>.json
```

制御記録は取り込みUUID、Show ID、要求URL、最終URL、RSSハッシュを保持する。素材の完了記録は保存先・長さ・SHA-256を持つ。一時ファイルへ保存・同期した後に配置し、ディレクトリも同期する。

再実行では保存済みRSSと完了素材を照合して再利用する。完了記録のない既存素材、変更された完了素材、異なるURL・Showの記録を黙って採用しない。生成済みTOMLはダウンロードの再実行で上書きしないため、公開前の編集を保持できる。

## 公開前の検査

公開処理は、Show登録やメディアPUTより先に全入力を検査する。

- RSSスナップショットと制御記録の一致
- Show/Episodeの形式、項目別入力上限、カバー形式
- 元RSSに対するEpisode ID、GUID、permalink指定の意味、公開日時の維持
- ダウンロード記録に対する音声のサイズ・ハッシュ一致とMP3解析
- 公開後の全体読取・描画予算。取り込みでは付加されるリビジョン情報等も保守的に見積もる

タイトルや説明等は編集できるが、制約超過を自動的に切り詰めない。未来の `published_at` を含む場合は、即時公開を認める明示指定が必要になる。

## 順次公開と再実行

ワークスペース側の `sqlite-rss-imports/<service_id>/<import_id>.json` に、設定・取り込み元・全入力のハッシュ、配置完了、公開手順の位置を保存する。記録のスキーマ版は3で、状態は `ready` / `publishing` / `completed`。

1. 新規Showであることを確認し、通常の `create-show` を呼ぶ。
2. 検査済みのTOML・カバー・CSSをShowディレクトリへ配置する。
3. Showを公開し、Episodeを公開日時・IDの順に1件ずつ公開する。
4. 各成功結果を確認して手順位置を進める。
5. 公開Feedを取得し、GUID・日時・音声URL等を照合して完了にする。

**バッチ全体はアトミックではない。** 中断前に成功したShow/Episodeは公開されたまま残る。再実行時は同じ取り込み記録を使い、通常公開の同一内容判定を利用する。入力・設定・取り込み元を途中で変えたり、既存Showへ追記するために記録を流用したりしない。

配置完了が記録される前に中断した場合は、確認済み取り込み元から生成ファイルを配置し直す。公開開始後も、配置済みメタデータと素材を承認済み入力に照合する。音声は取り込み元パスから読むため、公開完了までは元ディレクトリを保持する。

ローカル取り込みディレクトリはサービス設定を持たず、ワークスペースバックアップの対象ではない。元の編集・素材・記録は別途保全する。

## 定義元と関連テスト

- [取得先と通信制約](../../packages/cli/src/rss-import-download.ts)、[RSS解析](../../packages/cli/src/rss-import-feed.ts)、[ローカル保存](../../packages/cli/src/rss-import-local.ts)
- [公開前検査](../../packages/cli/src/rss-import-preflight.ts)、[順次公開](../../packages/cli/src/sqlite-rss-publication.ts)、[Feed照合](../../packages/cli/src/rss-publication-content.ts)
- [取得テスト](../../packages/cli/src/rss-import-download.test.ts)、[ローカル保存テスト](../../packages/cli/src/rss-import-local.test.ts)、[事前検査テスト](../../packages/cli/src/rss-import-preflight.test.ts)、[順次公開テスト](../../packages/cli/src/sqlite-rss-publication.test.ts)
- 操作方法：[RSS移行ガイド](../../docs/rss_migration.md)
