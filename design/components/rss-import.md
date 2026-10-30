# RSS取り込みの設計

RSS取り込みは、外部PodcastのRSSと素材をローカルへ保存し、内容を確認・編集した後に新規Showとして公開する機能です。取得、事前検査、順次公開の3段階に分けています。利用者向けの手順は[RSS移行ガイド](../../docs/rss_migration.md)を参照してください。

## 処理の構成

| 処理 | 入力 | 出力 |
| --- | --- | --- |
| `import-rss --dry-run` | 新規Show ID、RSS URL | 件数、申告音声サイズ、不足項目、警告 |
| `import-rss --output` | 同上、保存先 | RSSスナップショット、TOML、素材、ダウンロード記録 |
| `publish-rss-import` | 取り込みディレクトリ、サービス設定 | Show登録、素材アップロード、Show・Episodeの公開、公開Feedの確認結果 |

ダウンロード後にTOMLを編集し、公開処理へ進みます。タイトルや説明は修正できます。EpisodeのGUID・公開日時など、元の番組との同一性を表す値は保持します。

## RSSと素材の取得

外部URLへの通信では、取得先とサイズを制限します。内部ネットワークへの接続を防ぐため、URL検査とDNS検査を組み合わせます。

1. HTTP(S) URLを解析し、認証情報・フラグメント・独自ポート・localhostを拒否します。
2. DNSの全結果が公開アドレスであることを確認し、検査したアドレスへ接続します。
3. リダイレクト先でも同じ検査を行います。最大5回とし、HTTPSからHTTPへの変更を拒否します。
4. 圧縮されていない本文を読み、申告サイズと実際の読み取り量を確認します。

| 対象 | 上限 |
| --- | --- |
| RSS・保存済みXML | 8 MiB |
| カバー | 5,000,000バイト |
| 音声1本 | 300,000,000バイト |

空の取得結果や、宣言された長さと異なる結果はエラーにします。

## ローカルへの保存

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

`control.json` には取り込みUUID、Show ID、要求URL、最終URL、RSSハッシュを保存します。素材の完了記録には、保存先・サイズ・SHA-256を持たせます。ファイルは一時ファイルへの書き込みと同期後に配置し、ディレクトリも同期します。

再実行時は保存済みRSSと完了記録を照合し、確認できた素材を再利用します。既存素材に完了記録がない場合や、記録と素材が一致しない場合はエラーにします。生成済みTOMLは保持するため、ダウンロードの再実行後も編集内容が残ります。

## 公開前の一括検査

Show登録や素材アップロードを始める前に、全入力を検査します。

- RSSスナップショットと制御記録の一致
- Show/Episodeの形式、項目別上限、カバー形式
- 元RSSに対するEpisode ID・GUID・permalink指定・公開日時の維持
- ダウンロード記録と音声サイズ・ハッシュの一致、MP3の解析結果
- 公開後の一覧読み取りとRSS描画のサイズ制限

描画サイズは、公開時に追加されるリビジョン情報も含めて見積もります。制限を超えた入力はエラーとして返します。未来の `published_at` を含む場合は、即時公開を認める明示指定を求めます。

## 順次公開

公開の進捗は、ワークスペースの `.castloop/sqlite-rss-imports/<service_id>/<import_id>.json` に保存します。記録には設定・取り込み元・全入力のハッシュ、ファイル配置の完了、公開位置を持たせます。状態は `ready` / `publishing` / `completed` です。

1. 対象が新規Showであることを確認し、`create-show` で登録します。
2. 検査したTOML・カバー・CSSをShowディレクトリへ配置します。
3. Showを公開し、Episodeを公開日時・IDの順に1件ずつ公開します。
4. 各結果を確認して、進捗記録を更新します。
5. 公開Feedを取得し、GUID・日時・音声URLなどを照合して完了にします。

公開の確定単位は1件ずつです。途中で中断した場合、それまでに成功したShow/Episodeは公開済みとして残ります。

## 中断後の再実行

同じ取り込みディレクトリ、サービス設定、入力で再実行します。進捗記録と公開済み内容を照合し、同一内容の公開は通常の公開処理の `unchanged` 判定を使います。

ファイル配置の完了を記録する前に中断した場合は、取り込み元から配置し直します。公開開始後も、配置済みメタデータと素材を承認済み入力に照合します。音声は取り込み元のパスから読むため、完了までそのディレクトリを保持します。

取り込みディレクトリはワークスペースとは別に保存・保管します。進捗記録の形式は[スキーマ](../data/schemas.md)、ワークスペースとの関係は[保存構造](../data/storage.md)を参照してください。

## 実装と関連テスト

- 取得と保存：[通信](../../packages/cli/src/rss-import-download.ts)、[RSS解析](../../packages/cli/src/rss-import-feed.ts)、[ローカル保存](../../packages/cli/src/rss-import-local.ts)
- 公開：[事前検査](../../packages/cli/src/rss-import-preflight.ts)、[順次公開](../../packages/cli/src/sqlite-rss-publication.ts)、[Feed照合](../../packages/cli/src/rss-publication-content.ts)
- テスト：[取得](../../packages/cli/src/rss-import-download.test.ts)、[保存](../../packages/cli/src/rss-import-local.test.ts)、[事前検査](../../packages/cli/src/rss-import-preflight.test.ts)、[順次公開](../../packages/cli/src/sqlite-rss-publication.test.ts)
