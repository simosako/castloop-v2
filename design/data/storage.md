# 保存構造と保持方針

castloopは、編集元をローカルワークスペース、音声・画像をR2、確定した公開内容をDurable Objects（DO）のSQLiteに保存します。本書ではそれぞれの配置と保持方針を説明します。

## ローカルワークスペース

```text
ワークスペース/
├── castloop.toml                       サービス設定
├── castloop-admin.toml                 CLIの任意設定
├── .gitignore
├── .castloop/
│   ├── secrets.json                    管理者キー
│   └── <記録種別>/...
└── <show_id>/
    ├── show.toml
    ├── episode-<episode_id>.toml
    ├── cover.jpg または cover.png
    └── カスタムCSS・音声原本など
```

Show/EpisodeのIDは、ディレクトリ・ファイル名とTOML内の値を一致させます。カバーとCSSはShowディレクトリ直下のファイル名で参照します。音声のパス引数は、絶対パスまたはShowディレクトリ基準の相対パスです。

`castloop.toml` は配備先と公開オリジン、`castloop-admin.toml` はタイムゾーンなどのCLI設定を持ちます。管理者キーは `.castloop/secrets.json` の `CASTLOOP_ADMIN_KEY` に保存します。

### 操作の進捗記録

CLIは、複数の手順を持つ操作について、対象・入力ハッシュ・確認済みの進捗をJSONで保存します。再実行時は記録と現在の状態を照合します。

`rss-import-downloads` は取り込みディレクトリ内、それ以外はワークスペースの `.castloop/<種別>/<service_id>/` に配置します。

| 種別 | ファイルと内容 |
| --- | --- |
| `sqlite-initializations` | `initialize.json`。初期化対象、ソース・配備設定のハッシュ、配備情報 |
| `sqlite-registrations` | `<show_id>.json`。Show登録ID、設定ハッシュ、登録の進捗 |
| `sqlite-rss-imports` | `<import_id>.json`。取り込み元、入力ハッシュ、ファイル配置と公開の進捗 |
| `sqlite-domain-changes` | `<operation_id>.json`。変更前後の設定、接続・配備情報、進捗 |
| `rss-import-downloads` | RSS識別情報、素材の保存先・ハッシュ・完了記録 |

記録種別は `JOURNAL_FAMILIES` で定義します。同定義には `sqlite-client` も含まれ、バックアップの対象として認識します。現行CLIが作成する記録は上表の5種類です。

記録の書き込みは、一時ファイルへの保存、ファイル同期、rename、親ディレクトリの同期の順に行います。同じ保存先を変更するCLIは1プロセスで実行します。RSS取り込みのファイル構成は[RSS取り込み](../components/rss-import.md)を参照してください。

## R2オブジェクト

1サービスにつき1個の非公開バケットを使います。

| キー | 内容 |
| --- | --- |
| `system/service.toml` | サービス設定 |
| `public/podcasts/<show_id>/audio/<sha256>.mp3` | 音声 |
| `public/podcasts/<show_id>/covers/<sha256>.jpg` または `.png` | カバー画像 |

素材のキーはShow IDと内容のSHA-256で決まります。同じShow内で同じ素材を使う場合は、同じキーを参照します。内容を変えるとキーが変わり、元の素材は残ります。

公開URLはR2キーとは別の形式です。WorkerがShow DOの承認済み参照を使ってR2オブジェクトを取得します。キーの `public/` は保存先の接頭辞で、バケット自体は非公開です。

CLIは新規・変更された素材を直接アップロードし、現在の参照と一致する素材は再利用します。RSSとHTMLはSQLiteから生成します。

## DOごとの所有データ

| DO名 | 保存するデータ |
| --- | --- |
| `service/<service_id>` | Show登録簿、独自ドメイン接続、サービス設定の識別情報、ドメイン変更記録 |
| `show/<service_id>/<show_id>` | Show登録情報、現在内容、履歴、公開状態、世代、短縮ID、予約・イベント、統計、設定識別情報、ドメイン変更記録 |

各DOのSQLiteは独立しています。Show IDを含む列も、そのDOに対応するShowのデータを保存します。

共通の初期化処理により、制御DOにも内容・予約の表が作られます。実際の公開データを書き込むのはShow DOです。表の配置と使用範囲は[SQLite表設計](sqlite.md)で確認できます。

## データの保持

| データ | 保持方針 |
| --- | --- |
| アップロード済み音声・カバー | 内容を固定して保持。公開失敗・更新・配備後も残す |
| Show/Episodeの履歴 | 更新・非公開化後も保持。過去版の採用に使う |
| 非公開化済み内容 | メタデータと素材を保持し、配信を停止する |
| 統計の日別明細 | 保持期限を過ぎた行を累計へ合算し、明細を削除する |
| ローカル原本・管理記録 | 管理者が保管・バックアップする |
| キャッシュ | 必要に応じて消去し、保存データから再生成する |

[ワークスペースバックアップ](../components/workspace-backup.md)は、ローカルの管理ファイルを保存する機能です。R2・DOのデータやワークスペース外の原本は、別に保管対象を決めます。

## 実装

- [素材キー](../../packages/shared/src/sqlite-media.ts)、[DO名と振り分け](../../src/sqlite-show-routing.ts)
- [記録種別](../../packages/cli/src/local-journal-path.ts)、[記録の書き込み](../../packages/cli/src/local-journal-storage.ts)、[管理者キー](../../packages/cli/src/administrator-key.ts)
- [ローカル保護設定](../../packages/cli/src/workspace-protection.ts)、[バックアップ対象選別](../../packages/cli/src/backup-create.ts)
