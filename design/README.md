# 開発者向け設計ガイド

`design/` は、castloopの構成、処理の流れ、データ形式を説明する資料です。機能の実装や変更を始めるときに、各コンポーネントの役割と、整合性を保つ仕組みを確認できます。

操作方法は[利用ガイド](../docs/README.md)、開発環境の準備は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

## 初めに読む資料

次の順に読むと、全体像から個々の実装へ進めます。

1. [全体アーキテクチャ](architecture.md)：構成と役割、公開・配信の流れ。
2. [保存構造](data/storage.md)：ワークスペース、R2、Durable Objectsに保存するデータ。
3. [スキーマ](data/schemas.md)：設定、メタデータ、管理APIの形式と制約。
4. [SQLite表設計](data/sqlite.md)：各表の用途、列、関連、トランザクション。
5. 変更対象のコンポーネント設計。
6. [セキュリティ](security.md)と[テスト](testing.md)：認証、公開範囲、変更の確認方法。

## コンポーネント設計

| 資料 | 主な内容 |
| --- | --- |
| [CLI](components/cli.md) | 入力検証、プレビュー、素材アップロード、公開、サービス管理、診断 |
| [Show DO](components/show-do.md) | 番組ごとの公開処理、履歴、公開状態、予約、配信統計 |
| [制御DOと独自ドメイン](components/control-do.md) | Show登録、サービス全体の状態確認、ドメイン変更 |
| [公開配信とキャッシュ](components/delivery.md) | 公開ルート、配信可否の判定、RSS・HTML生成、HTTP応答、キャッシュ更新 |
| [RSS取り込み](components/rss-import.md) | 外部RSSの取得、ローカル保存、検査、順次公開 |
| [ワークスペースバックアップ](components/workspace-backup.md) | 保存対象、アーカイブ形式、暗号化、検証、復元 |

## 変更内容から探す

| 変更内容 | 関連する資料 |
| --- | --- |
| 公開・更新・非公開化・履歴の採用 | [CLI](components/cli.md)、[Show DO](components/show-do.md)、[スキーマ](data/schemas.md) |
| SQLiteの列や保存形式 | [表設計](data/sqlite.md)、[スキーマ](data/schemas.md)、その表を使うコンポーネント |
| Show登録・サービス設定 | [全体構成](architecture.md)、[制御DO](components/control-do.md)、[保存構造](data/storage.md) |
| 独自ドメイン・Worker配備 | [制御DO](components/control-do.md)、[CLI](components/cli.md)、[配信](components/delivery.md) |
| 予約・日時・配信統計 | [Show DO](components/show-do.md)、[表設計](data/sqlite.md)、[スキーマ](data/schemas.md) |
| RSS・サイト・音声・キャッシュ | [配信](components/delivery.md)、[セキュリティ](security.md) |
| RSS移行 | [RSS取り込み](components/rss-import.md) |
| ローカル記録・バックアップ | [保存構造](data/storage.md)、[バックアップ](components/workspace-backup.md) |

## 実装を調べるとき

各資料の末尾に、実装と関連テストへのリンクがあります。フィールドの正確な定義は共有スキーマ、表の定義は各実装のDDL（表を作成するSQL）を参照してください。動作を変える場合は、関連する設計資料と利用ガイドも更新します。

入力例は [examples/](../examples/README.md) にあります。[Showテンプレート](show-template.toml)と[Episodeテンプレート](episode-template.toml)では、任意項目も確認できます。CLIが生成する雛形は [input-templates.ts](../packages/cli/src/input-templates.ts)、例とスキーマの整合性確認は [doctor-templates.test.ts](../packages/cli/src/doctor-templates.test.ts) にあります。

## 関連資料

- [開発・CI・リリース](../docs/development/README.md)
- [エージェントの作業規則](../AGENTS.md)
- [過去の設計・検証記録](archive/README.md)

この設計ガイドはv0.8.2の実装を対象としています。形式の版番号は[スキーマ](data/schemas.md)にまとめています。
