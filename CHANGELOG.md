# 変更履歴

版ごとの変更の入口です。詳細・互換性・検証範囲は各リリースノートを参照してください。**過去版の機能や手順が現行版でも使えるとは限りません。** 現在の使い方は[利用ガイド](docs/README.md)、実装の構造は[設計文書](design/README.md)で説明しています。

## 未リリース

- なし。

## リリース一覧

バージョン番号はGitHub Releaseへのリンク、ノートはその版の記録です。旧版ノートは[アーカイブ](docs/archive/releases/README.md)に保存しています。

| 版 | 主な変更 | リリースノート |
| --- | --- | --- |
| [v0.8.2](https://github.com/simosako/castloop-v2/releases/tag/v0.8.2) | リリース手順の整理 | [ノート](docs/release-v0.8.2.md) |
| [v0.8.1](https://github.com/simosako/castloop-v2/releases/tag/v0.8.1) | 公開チェックと中断時RSS再実行の簡素化、ヘルプ・同梱Skill・ガイドの現行動作への整合 | [ノート](docs/archive/releases/release-v0.8.1.md) |
| [v0.8.0](https://github.com/simosako/castloop-v2/releases/tag/v0.8.0) | 同期・アトミック公開、素材の直接配置、RSS・サイトの要求時生成、管理処理の簡素化 | [ノート](docs/archive/releases/release-v0.8.0.md) |
| [v0.7.6](https://github.com/simosako/castloop-v2/releases/tag/v0.7.6) | 内蔵番組サイト、予約公開、暗号化ワークスペースバックアップ | [ノート](docs/archive/releases/release-v0.7.6.md) |
| [v0.7.5](https://github.com/simosako/castloop-v2/releases/tag/v0.7.5) | 公開内容の比較、リビジョン履歴・過去版採用、RSSプレビュー | [ノート](docs/archive/releases/release-v0.7.5.md) |
| [v0.7.4](https://github.com/simosako/castloop-v2/releases/tag/v0.7.4) | 診断・配信確認、公開可否制御、管理用タイムゾーン、macOS・Windows配布、Zod脆弱性対応 | [ノート](docs/archive/releases/release-v0.7.4.md) |
| [v0.7.3](https://github.com/simosako/castloop-v2/releases/tag/v0.7.3) | SQLiteサービスの独自サブドメイン対応 | [ノート](docs/archive/releases/release-v0.7.3.md) |
| [v0.7.2](https://github.com/simosako/castloop-v2/releases/tag/v0.7.2) | エージェント向けCLI仕様・スキーマ・Skill、入力検証とプレビュー承認 | [ノート](docs/archive/releases/release-v0.7.2.md) |
| [v0.7.1](https://github.com/simosako/castloop-v2/releases/tag/v0.7.1) | 入力・描画上限、記録・照会・安全境界の修正 | [ノート](docs/archive/releases/release-v0.7.1.md) |
| [v0.7.0](https://github.com/simosako/castloop-v2/releases/tag/v0.7.0) | Show単位のDO分離と `show-v1`、更新中のFeed配信継続 | [ノート](docs/archive/releases/release-v0.7.0.md) |
| [v0.6.2](https://github.com/simosako/castloop-v2/releases/tag/v0.6.2) | サーバー側操作記録、アップロード再開、操作取消・ステージング整理 | [ノート](docs/archive/releases/release-v0.6.2.md) |
| [v0.6.1](https://github.com/simosako/castloop-v2/releases/tag/v0.6.1) | Show・Episodeメタデータの項目別入力上限 | [ノート](docs/archive/releases/release-v0.6.1.md) |
| [v0.6.0](https://github.com/simosako/castloop-v2/releases/tag/v0.6.0) | SQLite専用化、旧Queue方式の削除 | [ノート](docs/archive/releases/release-v0.6.0.md) |
| [v0.5.2](https://github.com/simosako/castloop-v2/releases/tag/v0.5.2) | SQLite Worker更新・アップロード・REST管理の修正 | [ノート](docs/archive/releases/release-v0.5.2.md) |
| [v0.5.1](https://github.com/simosako/castloop-v2/releases/tag/v0.5.1) | RSS入力・ローカル設定読取の堅牢化、コード整理 | [ノート](docs/archive/releases/release-v0.5.1.md) |
| [v0.5.0](https://github.com/simosako/castloop-v2/releases/tag/v0.5.0) | SQLite Durable Object方式の追加 | [ノート](docs/archive/releases/release-v0.5.0.md) |
| [v0.4.0](https://github.com/simosako/castloop-v2/releases/tag/v0.4.0) | RSS移行、公開性能・停止診断、Worker更新の継続 | [ノート](docs/archive/releases/release-v0.4.0.md) |
| [v0.3.0](https://github.com/simosako/castloop-v2/releases/tag/v0.3.0) | 旧Queue方式の独自ドメイン対応 | [ノート](docs/archive/releases/release-v0.3.0.md) |
| [v0.2.1](https://github.com/simosako/castloop-v2/releases/tag/v0.2.1) | Show・Episode一覧 | [ノート](docs/archive/releases/release-v0.2.1.md) |
| [v0.2.0](https://github.com/simosako/castloop-v2/releases/tag/v0.2.0) | 非公開化・復元・削除を含むライフサイクル操作 | [ノート](docs/archive/releases/release-v0.2.0.md) |
| [v0.1.2](https://github.com/simosako/castloop-v2/releases/tag/v0.1.2) | MVPの不具合修正 | [ノート](docs/archive/releases/release-v0.1.2.md) |
| [v0.1.1](https://github.com/simosako/castloop-v2/releases/tag/v0.1.1) | MVPのパッチリリース | [ノート](docs/archive/releases/release-v0.1.1.md) |
| [v0.1.0](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0) | Linux単一バイナリによる初版MVP | [ノート](docs/archive/releases/release-v0.1.0.md) |
