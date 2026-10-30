# 開発者向け設計文書

`design/` はcastloopの現行構造・処理・データと、変更時に守る契約を説明する開発者向け文書である。過去の計画を順に読む必要はなく、以下の文書を入口とする。

対象は **v0.8.0**、サービス設定 `schema_version = 2` / `show-v1`、内部queue/content形式 **14/13**。現行コードの照合基準は `750133d`。操作手順は [README](../README.md) と `docs/`、開発環境は [CONTRIBUTING.md](../CONTRIBUTING.md)、エージェントの作業規則は [AGENTS.md](../AGENTS.md)を参照する。

## 読み始める順序

1. [全体アーキテクチャ](architecture.md)：構成、責務、データの正本、主要フロー。
2. [保存構造](data/storage.md)：ローカル・R2・DOごとの配置と保持方針。
3. 変更対象のコンポーネント設計と、必要な表・スキーマ。
4. [セキュリティ](security.md)と[テスト](testing.md)：変更・検証の境界。

各文書から定義元のコードと関連テストを参照できる。新しい動作や未実装の案は現行仕様と混在させない。

## コンポーネント設計

| 文書 | 内容 |
| --- | --- |
| [CLI](components/cli.md) | 入力検証、プレビューと承認、素材配置、公開、初期化・コード配備、JSON応答・診断 |
| [Show DO](components/show-do.md) | アトミック公開、現在内容と履歴、公開可否、世代、予約とAlarm、配信統計 |
| [制御DOと独自ドメイン](components/control-do.md) | Show登録・一覧、設定変更、各DOの確定範囲、ローカルとの同期 |
| [公開配信とキャッシュ](components/delivery.md) | 公開ルート、公開可否判定、キャッシュ属性、RSS・HTML生成、HTTP条件、パージ |
| [RSS取り込み](components/rss-import.md) | 外部取得、ローカル保存、公開前検査、順次公開と進捗 |
| [ワークスペースバックアップ](components/workspace-backup.md) | 対象選別、暗号化形式、整合性検査、復元の条件と範囲 |

## データ・横断的な契約

| 文書 | 内容 |
| --- | --- |
| [保存構造と保持方針](data/storage.md) | ディレクトリ、6種類のローカル記録、R2キー、DO別の所有データ |
| [SQLite表設計](data/sqlite.md) | 全表の配置・列・主キー・制約・インデックス・関連と更新単位 |
| [スキーマ](data/schemas.md) | 設定、Show/Episode、管理API、保存記録、版、入力・全体上限 |
| [セキュリティと安全境界](security.md) | 認証、機密情報、公開経路、外部取得、非公開実機試験 |
| [テストと検証](testing.md) | ローカル・結合・バイナリ・実機の責務と、検証から言える範囲 |

## 変更内容から探す

| 変更内容 | 読む文書 |
| --- | --- |
| 公開・更新・非公開化・履歴採用 | [CLI](components/cli.md)、[Show DO](components/show-do.md)、[スキーマ](data/schemas.md) |
| SQLiteの列や保存形式 | [表設計](data/sqlite.md)、[スキーマ](data/schemas.md)、その表を所有するコンポーネント |
| Show分離・登録・サービス設定 | [全体構成](architecture.md)、[制御DO](components/control-do.md)、[保存構造](data/storage.md) |
| 独自ドメイン・コード配備 | [制御DO](components/control-do.md)、[CLI](components/cli.md)、[配信](components/delivery.md) |
| 予約・日時 | [Show DO](components/show-do.md)、[スキーマ](data/schemas.md) |
| RSS・サイト・音声・キャッシュ | [配信](components/delivery.md)、[Show DO](components/show-do.md)、[セキュリティ](security.md) |
| 統計・保持期限 | [Show DO](components/show-do.md)、[表設計](data/sqlite.md) |
| RSS移行 | [RSS取り込み](components/rss-import.md)、[スキーマ](data/schemas.md) |
| バックアップ・ローカル記録 | [バックアップ](components/workspace-backup.md)、[保存構造](data/storage.md) |

## 利用ガイドとの分担

利用ガイドは「どう操作するか」、設計文書は「なぜその境界があり、どこで何を確定するか」を扱う。コマンドの全引数や長い操作例は利用ガイドとCLIのヘルプを参照し、設計本文へ重複掲載しない。

- 基本操作：[SQLite開発・運用](../docs/sqlite_sequential_development.md)
- 機能操作：[予約](../docs/admin_configuration.md)、[内容確認・履歴](../docs/published_content_review.md)、[サイト](../docs/show_website.md)、[独自ドメイン](../docs/sqlite_custom_domains.md)、[統計](../docs/delivery_statistics.md)
- 管理支援：[RSS移行](../docs/rss_migration.md)、[バックアップ](../docs/workspace_backup.md)、[診断](../docs/observability.md)、[エージェント利用](../docs/agent_usage.md)
- 入力例：[Showテンプレート](show-template.toml)、[Episodeテンプレート](episode-template.toml)。実際の入力形式はCLIの `template` / `schema` / `validate` で確認する。

## 文書の更新

動作を変更するときは、該当コンポーネントと必要なデータ設計を同じ変更で更新する。表の列・制約と要求の正確な形式はリンク先のDDL・スキーマへ照合し、説明との不一致を黙って仕様として採用しない。実装済みの動作、設計上の制約、実機で確認した範囲は区別して記載する。

## 履歴資料

再編前の全体設計、機能計画、比較検討、実装・検証・環境廃棄の記録は [archive/ の索引](archive/README.md)から参照する。現行仕様を理解するためにこれらを読む必要はない。

履歴内の比較案・未実装項目・過去の試験は現行契約として適用せず、現在の実行環境や操作許可も示さない。実機試験の制約は[セキュリティ](security.md)、検証範囲は[テスト](testing.md)を参照する。
