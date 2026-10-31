# 利用資料のアーカイブ

旧版の操作手順、リリースノート、導入時の検証記録を保存します。**現行版の手順ではなく、記載された承認も新しい実環境操作の許可ではありません。** 本文の「現在」「次に行う」は当時を指します。

現行の操作は[利用ガイド](../README.md)、設計・開発経緯の履歴は[設計アーカイブ](../../design/archive/README.md)から参照してください。履歴中の利用ガイドへの相対リンクは現行ガイドにつながる場合があります。当時の手順を厳密に確認する場合は、その版のGitタグを参照します。

## 旧版の操作・試験資料

| 資料 | 保存している内容 | 現行の参照先 |
| --- | --- | --- |
| [Queue方式サービス](queue_service.md) | schema version 1、v0.5.2のCLI・Worker向け操作 | [サービス作成](../getting_started.md) |
| [Linuxでの簡易確認](linux_smoke_test.md) | v0.1.2の計画・旧実装の試験結果 | [インストール](../installation.md)、[テスト設計](../../design/testing.md) |
| [独自ドメインの実機確認](sqlite_custom_domain_live_acceptance.md) | 内部形式6/7の手順・結果 | [独自ドメイン](../custom_domains.md) |
| [Zod更新](zod_security_update_20261025.md) | 2026-10-25の依存更新・検証 | [開発資料](../development/README.md) |
| [バックアップの導入時検証](workspace_backup_verification_20261026.md) | 旧版で確認した対象・結果・未確認範囲 | [バックアップ](../workspace_backup.md) |
| [CLI・CIの導入時確認](cli_verification_notes.md) | バイナリ配布・エージェント・Action固定の確認記録 | [インストール](../installation.md)、[CI保守](../development/ci_security.md) |
| [RSSの性能測定上の注意](rss_performance_notes.md) | ガイドにあった過去の測定値と観測条件 | [RSS取り込み](../rss_migration.md)、[テスト設計](../../design/testing.md) |

## リリース履歴

[旧版リリースノートの一覧](releases/README.md)と[CHANGELOG](../../CHANGELOG.md)を参照してください。現行版の [v0.8.2ノート](../release-v0.8.2.md) は、リリースCIの参照先として `docs/` 直下に維持しています。

古い資源名・保存形式・試験結果を、現行版での再利用や互換配備の根拠にしないでください。ローカルテスト、実機確認、未測定事項は当時の条件で区別して保存します。
