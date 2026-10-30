# 保存構造と保持方針

保存場所は、ローカル編集元、R2の不変素材、DOごとの確定済みデータに分ける。キャッシュは再生成可能な配信用データであり、正本にはしない。

## ローカルワークスペース

```text
ワークスペース/
├── castloop.toml
├── castloop-admin.toml                 任意
├── .gitignore
├── .castloop/
│   ├── secrets.json
│   └── <記録種別>/...
└── <show_id>/
    ├── show.toml
    ├── episode-<episode_id>.toml
    ├── cover.jpg または cover.png
    └── カスタムCSS・任意の音声原本
```

Show/EpisodeのIDはディレクトリ・ファイル名と内容で一致させる。カバーとCSSはShowディレクトリ直下のファイル名で参照する。音声引数は絶対パス、またはShowディレクトリ基準の相対パスであり、必ずしもワークスペース内にあるとは限らない。

`castloop.toml` はサービスの配備先と公開オリジン、`castloop-admin.toml` はCLIの任意設定を持つ。管理者キーは `.castloop/secrets.json` の `CASTLOOP_ADMIN_KEY` に保存し、設定TOMLには入れない。

### ローカル記録

記録種別は `JOURNAL_FAMILIES` で定めた6種類だけを対象とする。`rss-import-downloads` 以外は `.castloop/<種別>/<service_id>/` に置く。

| 種別 | 主な内容 |
| --- | --- |
| `rss-import-downloads` | 取り込みディレクトリ内のRSS識別情報・素材完了記録。サービスIDで区切らない |
| `sqlite-initializations` | `initialize.json`。初期化対象、ソース・配備設定のハッシュ、配備証拠 |
| `sqlite-registrations` | `<show_id>.json`。Show登録ID、設定ハッシュ、登録確認済み範囲 |
| `sqlite-rss-imports` | `<import_id>.json`。取り込み元・入力ハッシュ、配置完了、公開手順位置 |
| `sqlite-domain-changes` | `<operation_id>.json`。変更前後設定、接続・配備証拠、継続位置 |
| `sqlite-client` | 既知の記録種別・バックアップ対象として列挙される。現行CLIにこの種別の記録を新規作成する処理はない |

記録はJSONを専用スキーマで検査する。通常ファイルと実ディレクトリを使い、一時ファイルの同期・rename・親ディレクトリの同期で置換する。同じ保存先を変更するCLIは1プロセスに限定する。ロックファイルは作らない。

RSS取り込みの出力は別のローカル構造を持つ。[RSS取り込み](../components/rss-import.md)を参照する。

## R2オブジェクト

1サービスで1個の非公開バケットを使う。

| キー | 内容 |
| --- | --- |
| `system/service.toml` | サービス設定 |
| `public/podcasts/<show_id>/audio/<sha256>.mp3` | 不変音声 |
| `public/podcasts/<show_id>/covers/<sha256>.jpg` または `.png` | 不変カバー |

キー中の `public/` は公開バケットを意味しない。実際の公開URLとR2キーは異なり、Show DOが返す承認済み参照をWorkerが解決する。

- 同じShow内の同じ内容は同じ素材キーを使う。Showをまたいだ共有キーにはしない。
- 新規または変更された素材だけを直接PUTする。更新済み参照と同じ素材には存在確認の通信もしない。
- Feed、HTML、メタデータのスナップショットはR2へ保存しない。
- 配置済み素材は、公開失敗・更新・配備を理由に削除しない。

## DO SQLite

| DO名 | 所有データ |
| --- | --- |
| `service/<service_id>` | Show登録簿、確定した独自ドメイン接続、サービス設定識別とドメイン変更記録 |
| `show/<service_id>/<show_id>` | Show登録情報、現在内容、履歴、公開可否、世代、短縮ID、予約・イベント、統計、設定識別とドメイン変更記録 |

表の名前にShow IDを持っていても、複数Showの公開データを1個のShow DOへ混在させない。制御DOにも共通初期化でコンテンツ表は作られるが、Show内容の保存・公開には使わない。物理的に作られる表と、業務データの所有範囲の違いは[SQLite表設計](sqlite.md)を参照する。

## 保持と復元の境界

| データ | 保持・削除の扱い |
| --- | --- |
| 公開済み音声・カバー | 不変保持。通常管理で削除しない |
| Show/Episode履歴 | 内容の更新や非公開化でも保持。過去版を新リビジョンとして採用できる |
| 非公開化済み内容 | 配信だけ止める。メタデータ・素材を消さない |
| 統計日別明細 | 保持期限を過ぎた分を順次整理し、累計は保持 |
| ローカル原本・管理記録 | 管理者が保全。配備やバックアップ復元で無関係な原本を消さない |
| キャッシュ | 消去・再生成可能。内容・公開可否の正本にはしない |

[ワークスペースバックアップ](../components/workspace-backup.md)はローカルだけを保存する。外部パスの音声、取り込み元、R2全体、DO SQLiteのエクスポートを含むものではない。メディアと履歴の保持も、アカウント・バケット全体の喪失に備えた別系統のバックアップを意味しない。

## 定義元

- [素材キー](../../packages/shared/src/sqlite-media.ts)、[DO名と振り分け](../../src/sqlite-show-routing.ts)
- [記録種別とディレクトリ](../../packages/cli/src/local-journal-path.ts)、[記録の書込み](../../packages/cli/src/local-journal-storage.ts)、[管理者キー](../../packages/cli/src/administrator-key.ts)
- [ワークスペース保護](../../packages/cli/src/workspace-protection.ts)、[バックアップ対象選別](../../packages/cli/src/backup-create.ts)
