# 設計・検証の履歴資料

このディレクトリには、置き換えられた設計、導入時の計画・比較検討、実装ログ、実機検証と環境廃棄の記録を保存する。**現行設計の入口は [design/README.md](../README.md)** であり、通常の開発で履歴を通読する必要はない。

本文中の「現行」「現在」「次の作業」や承認は、その資料の記載時点を指す。検証結果は当時の版・環境・測定経路に限られ、新しい実環境操作の許可や現在の性能保証にはならない。過去の未完了項目を現在の作業一覧として扱わない。

旧版の操作ガイド・配布ノート・ガイドから分離した検証記録は [docs/archive/](../../docs/archive/README.md) にまとめている。

## 再編前の設計と現行の参照先

| 履歴資料 | 現行の参照先 |
| --- | --- |
| [全体設計の要約](initial_design.md)、[全体簡素化レビュー](architecture_simplification_review_20261028.md) | [全体アーキテクチャ](../architecture.md) |
| [フェーズ1](phase1_atomic_publication_and_ondemand_delivery_plan.md) | [Show DO](../components/show-do.md)、[公開配信](../components/delivery.md) |
| [フェーズ2](phase2_direct_media_and_cli_simplification_plan.md) | [CLI](../components/cli.md)、[Show DO](../components/show-do.md) |
| [フェーズ3](phase3_deploy_and_runtime_control_simplification_plan.md) | [CLI](../components/cli.md)、[制御DO・独自ドメイン](../components/control-do.md) |
| [フェーズ4](phase4_code_and_test_cleanup_plan.md) | [保存構造](../data/storage.md)、[バックアップ](../components/workspace-backup.md)、[テスト](../testing.md) |
| [Show単位DOの検討](do_show_separation_options.md) | [全体構成](../architecture.md)、[制御DO](../components/control-do.md) |
| [管理認証](admin_authentication.md) | [セキュリティ](../security.md) |
| [REST URL構築](rest_url_construction.md) | [CLIの通信契約](../components/cli.md#通信失敗とローカル記録) |
| [項目別入力上限](show_episode_input_limits.md) | [スキーマ](../data/schemas.md) |
| [エージェント連携の計画](agent_integration_plan.md) | [CLI](../components/cli.md)、[JSON出力スキーマ](../data/schemas.md#cliのjson出力) |
| [予約公開計画](episode_scheduled_publication_plan.md) | [Show DOの予約公開](../components/show-do.md#予約公開) |
| [配信統計計画](episode_delivery_statistics_plan.md) | [Show DOの統計](../components/show-do.md#配信統計)、[表設計](../data/sqlite.md) |
| [差分確認・過去版採用計画](published_diff_and_revision_restore_plan.md) | [CLI](../components/cli.md)、[Show DO](../components/show-do.md) |
| [RSS取り込み計画](m7_rss_import_plan.md) | [RSS取り込み](../components/rss-import.md) |
| [バックアップ計画](workspace_backup_restore_plan.md) | [バックアップ](../components/workspace-backup.md) |
| [M6承認済み方針](m6_review_queue.md) | [保存・保持方針](../data/storage.md)、[安全境界](../security.md) |
| [非公開実機試験案](show_website_private_trial_plan.md) | [非公開実機試験の条件・手順](../security.md#非公開の実機試験) |

これらは本文の履歴を保存するために移動した資料であり、名前や見出しが現行の機能に似ていても新設計の代わりにはしない。

## 版別・機能別の履歴

- 全体設計：[v0.5.2以前](initial_design_v052.md)、[v0.7.6以前](initial_design_v076.md)
- 基盤の検討：[SQLite逐次公開](sqlite_sequential_publication_implementation_plan.md)、[操作記録](sqlite_operation_records_schema.md)、[Show分離の検証](do_show_separation_verification.md)
- 機能導入：[内蔵サイト](show_website_plan.md)、[独自ドメイン](sqlite_custom_domains_plan.md)、[診断・監視](remote_diagnostics_and_monitoring_plan.md)
- エージェント規則の履歴：[保存規約・マイルストーンのスナップショット](agent_storage_and_milestones_20261017.md)

## 実機検証と環境廃棄

必要な対象の記録だけを参照する。履歴に載る環境が現在も存在するとは限らず、廃棄済みの資源名を再利用しない。

- 実機検証：[予約9/9](issue65_scheduled_publication_live_20261026.md)、[予約11/11](issue65_scheduled_publication_11_live_20261027.md)、[サイト初回](show_website_private_trial_verification_20261025.md)、[配信統計](episode_delivery_statistics_live_20261025.md)、[独自ドメイン2 Show](sqlite_custom_domain_two_show_verification_20261024.md)
- 環境廃棄：[2026-10-29 mainスモーク環境](cloudflare_main_smoke_cleanup_20261029.md)、[保持サービス廃棄](sq16r_environment_decommission_20261029.md)、[2026-10-17クリーンアップ](cloudflare_test_environment_cleanup_20261017.md)

その他の記録はファイル名と各資料からの参照でたどる。測定値・進捗ログ・一度限りの承認は履歴資料に保存し、現行設計本文や `AGENTS.md` に時系列で積み上げない。
