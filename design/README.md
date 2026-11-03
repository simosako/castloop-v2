# 開発者向け設計ガイド

`design/` は、castloopの現行設計を確認するための文書を整理した場所です。構成、処理の流れ、データ形式、現在適用する契約や検証方法を説明します。機能の実装や変更を始めるときに、各コンポーネントの役割と、整合性を保つ仕組みを確認できます。

操作方法は[利用ガイド](../docs/README.md)、開発環境の準備は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

## 現行設計と作業記録の分け方

`archive/` 以外の設計文書は、現在の仕組みを理解できるように保ちます。Issueの調査、改善案の比較、実装計画、対応・作業・検証の記録は、設計に至る経緯として [archive/](archive/README.md) に保存します。

開発中にこれらの文書を一時的に `archive/` の外へ置くことはできますが、push・PR作成前にアーカイブへ移します。その際、採用した内容を現行の設計文書へ反映し、移動した文書のリンクとアーカイブ索引を更新します。現行設計の案内は設計本文へ、判断の経緯の案内はアーカイブへ向けます。

## 初めて全体を理解する場合

次の順に読むと、全体像から個々の実装へ進めます。特定の変更を行う場合は、後述の「変更内容から探す」から該当する箇所へ進んでください。

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

技術分野別の参照先はこの表にまとめています。まず変更対象の文書の該当する節を読み、別の契約にも影響する場合だけ追加の文書を参照してください。実装前には、変更に関係する[開発上の制約](../docs/development/constraints.md)も確認します。

| 変更内容 | 関連する資料 |
| --- | --- |
| 全体構成・簡素化 | [全体アーキテクチャ](architecture.md)、変更対象のコンポーネント設計 |
| CLI操作・公開 | [CLI](components/cli.md)、[初回公開ガイド](../docs/getting_started.md)、[更新ガイド](../docs/publishing.md) |
| 制御DOの保存表とランタイム構成 | [制御DOの設計](components/control-do.md)、[保存表の配置](data/sqlite.md#配置と表一覧) |
| 公開・更新・非公開化・履歴の採用 | [CLIの公開処理](components/cli.md#素材のアップロードと公開)、[Show DOの確定処理](components/show-do.md#公開を確定するまで)、[公開要求](data/schemas.md#公開非公開化再公開履歴採用) |
| SQLiteの列や保存形式 | [表設計](data/sqlite.md)、[スキーマ](data/schemas.md)、その表を使うコンポーネント |
| Show登録・サービス設定 | [全体構成](architecture.md)、[制御DO](components/control-do.md)、[保存構造](data/storage.md) |
| Show間の分離 | [DOの役割](architecture.md#サービスの構成)、[制御DO](components/control-do.md)、[Show DO](components/show-do.md) |
| 独自ドメイン・Worker配備 | [ドメイン変更](components/control-do.md#独自ドメインとサービス設定)、[CLIの配備](components/cli.md#初期化とworker配備)、[配信](components/delivery.md)、[独自ドメイン利用ガイド](../docs/custom_domains.md) |
| ライフサイクル・削除・保持 | [公開状態](components/show-do.md#公開状態と再公開)、[保持方針](data/storage.md#データの保持)、[セキュリティ](security.md) |
| 予約・日時 | [予約公開](components/show-do.md#予約公開)、[管理者の設定](data/schemas.md#castloop-admintoml)、[予約の保存表](data/sqlite.md#予約とイベント) |
| 配信統計 | [配信統計](components/show-do.md#配信統計)、[統計の保存表](data/sqlite.md#配信統計)、[API](data/schemas.md#照会予約統計ドメイン変更) |
| RSS・サイト・音声・キャッシュ | [配信](components/delivery.md)、[セキュリティ](security.md) |
| RSS移行 | [RSS取り込み](components/rss-import.md)、[RSS移行ガイド](../docs/rss_migration.md) |
| ローカル記録・バックアップ | [保存構造](data/storage.md)、[バックアップ](components/workspace-backup.md) |
| 認証・入力検証 | [認証と保護](security.md)、[スキーマ](data/schemas.md)、[CLIの入力](components/cli.md#入力の読み取り) |
| ローカル検証・テスト追加 | [基本チェック](testing.md#変更後の基本チェック)、[関連テスト](testing.md#変更箇所ごとのテスト) |
| 実機試験の実施・再現 | [共通の保護条件](security.md#非公開の実機試験)、試験目的に合う手順。新規サービスでの3件公開には[標準シナリオ](live-trial.md)を使う |
| 実環境の操作・試験記録の整理 | [実環境操作の承認と保護対象](live-operations.md) |

## 実装を調べるとき

各資料の末尾に、実装と関連テストへのリンクがあります。フィールドの正確な定義は共有スキーマ、表の定義は各実装のDDL（表を作成するSQL）を参照してください。動作を変える場合は、関連する設計資料と利用ガイドも更新します。

入力例は [examples/](../examples/README.md) にあります。[Showテンプレート](show-template.toml)と[Episodeテンプレート](episode-template.toml)では、任意項目も確認できます。CLIが生成する雛形は [input-templates.ts](../packages/cli/src/input-templates.ts)、例とスキーマの整合性確認は [doctor-templates.test.ts](../packages/cli/src/doctor-templates.test.ts) にあります。

## 関連資料

- [開発・CI・リリース](../docs/development/README_ja.md)
- [エージェントの作業規則](../AGENTS.md)
- [過去の設計・検証記録](archive/README.md)

この設計ガイドはv0.8.8の実装を対象としています。形式の版番号は[スキーマ](data/schemas.md)にまとめています。
