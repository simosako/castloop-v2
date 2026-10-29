# 設計文書の案内

`castloop` の現在のアーキテクチャは、2026-10-28〜10-29に実施した全体簡素化（[フェーズ1](phase1_atomic_publication_and_ondemand_delivery_plan.md)・[フェーズ2](phase2_direct_media_and_cli_simplification_plan.md)・[フェーズ3](phase3_deploy_and_runtime_control_simplification_plan.md)・[フェーズ4](phase4_code_and_test_cleanup_plan.md)）に基づく新規環境専用の構成（内部 queue/content 形式 **14/13**、サービス設定 `schema_version = 2` / `storage_layout = "show-v1"`）である。

開発・保守時はまず **[全体設計（initial_design.md）](initial_design.md)** と **[AGENTS.md](../AGENTS.md)** を参照すること。過去の非同期ジョブ方式（v0.6.0〜v0.7.6）や Queue 方式（v0.5.x）の設計書・実機試験記録はすべて **[archive/](archive/)** に分離してあり、通常の開発で参照する必要はない。

---

## 1. 現行アーキテクチャ・全体設計（`design/`）

| 文書 | 内容・用途 |
| --- | --- |
| **[全体設計（initial_design.md）](initial_design.md)** | **最優先で参照する現在の全体構成・データ正本・公開/配信/管理仕様の要約** |
| [全体設計の見直しとシンプル化提案](architecture_simplification_review_20261028.md) | 旧アーキテクチャの複雑性の原因分析と、フェーズ1〜4の段階的刷新方針 |
| [フェーズ1：公開処理の同期アトミック化とオンデマンド配信](phase1_atomic_publication_and_ondemand_delivery_plan.md) | キャッシュパージ＋単一SQLiteトランザクションによる同期公開、RSS/WebサイトHTMLのオンデマンド生成、`blocked` 廃止 |
| [フェーズ2：直接アップロードと冪等な公開](phase2_direct_media_and_cli_simplification_plan.md) | コンテンツハッシュキーへの直接メディア配置、JSONメタデータ直接送信、同一内容 no-op、ジョブ台帳・操作5表・旧コマンドの廃止 |
| [フェーズ3：デプロイと稼働制御の簡素化](phase3_deploy_and_runtime_control_simplification_plan.md) | 単発 `deploy`、Pause/Resume 廃止と lifecycle（`unpublish`/`restore`）への統合、変更前設定保存による冪等なドメイン変更、Alarm の予約専用化 |
| [フェーズ4：全体コード・テスト見直しと残存複雑性の削減](phase4_code_and_test_cleanup_plan.md) | ステージング一時コピー・全量Readbackの撤去、R2スナップショット残骸削除、`stats-retention` 台帳廃止、ドメイン・初期化ジャーナル圧縮、旧試験スクリプト削除 |
| [Show単位のDO分離](do_show_separation_options.md) | 制御 DO（`service/<id>`）と Show DO（`show/<id>/<show>`）の分離契約 |

---

## 2. 個別機能の仕様・安全境界（`design/`）

| 文書 | 内容・用途 |
| --- | --- |
| [Episode予約公開の設計](episode_scheduled_publication_plan.md) | Show DO 内の予約テーブルと Alarm による未来 UTC 公開、ベース変更時の `needs_approval` 遷移、未来 `published_at` の警告 |
| [公開済み内容との差分確認とリビジョン履歴・過去版採用](published_diff_and_revision_restore_plan.md) | 公開済みメタデータの全文取得・ローカル差分表示、メディア再アップロードなしの過去リビジョン復元 |
| [Episode別・日別の配信統計の設計](episode_delivery_statistics_plan.md) | 音声配信の観測分類（`initial_downloads`, `equivalent_full_downloads`, Bot 分離）、PII 非保持、保持日数変更と通算累計（`lifetime`）保持 |
| [管理ワークスペースのバックアップ・検証・復元](workspace_backup_restore_plan.md) | パスフレーズ暗号化アーカイブ（`.clbk`）のフォーマット、1パスハッシュ記録、復元プレビューと安全条件 |
| [RSS取り込みの設計](m7_rss_import_plan.md) | 既存 Podcast RSS からのメタデータ・メディア取得と新規 Show としての順次公開 |
| [エージェントによるPodcast管理の設計](agent_integration_plan.md) | 単一バイナリでのスキーマ・テンプレート・Skill 出力、`--json` 応答封筒（`agentEnvelope`）、オフライン検証と `doctor` |
| [Show/Episodeの項目別入力上限](show_episode_input_limits.md) | タイトル・説明文・カテゴリ等の入力サイズ上限と保存済み履歴の読み取り境界 |
| [管理者キーの照合](admin_authentication.md) | タイミング安全な管理者キー認証と診断ログのプライバシー制約 |
| [REST URLの構築](rest_url_construction.md) | Cloudflare REST API 呼び出し時のパス要素エンコードと R2 キー区切り保持の不変条件 |
| [記録保持・安全方針](m6_review_queue.md) | 公開済みメディア・履歴の不変保持と、物理削除を行わない安全方針 |
| [非公開の番組サイト画面確認・実機試験手順](show_website_private_trial_plan.md) | 実機テスト環境を作る際の Cloudflare Access 保護・未認証拒否確認の必須手順 |

入力テンプレート: [Show テンプレート](show-template.toml)、[Episode テンプレート](episode-template.toml)

---

## 3. 利用ガイド（`docs/`）

- [SQLite開発・運用ガイド](../docs/sqlite_sequential_development.md): 初期化（`init`）、公開（`publish-*`）、ライフサイクル（`unpublish`/`restore`）、デプロイ（`deploy`）の基本操作
- [内蔵番組サイト利用ガイド](../docs/show_website.md): `site_mode = "builtin"`、短縮 URL、カスタム CSS、`site_timezone`
- [管理用設定と予約公開ガイド](../docs/admin_configuration.md): `castloop-admin.toml` と `schedule-*` コマンド
- [公開内容の確認・リビジョン復元ガイド](../docs/published_content_review.md): `diff-*`, `export-*`, `list-*-revisions`, `revision-execute`
- [配信統計利用ガイド](../docs/delivery_statistics.md): `stats`, `stats-retention`
- [SQLite独自ドメイン操作ガイド](../docs/sqlite_custom_domains.md): `domain add|remove|continue|status|list`
- [リモート診断・検証ガイド](../docs/observability.md): `diagnose`, `verify`
- [ワークスペースバックアップ利用ガイド](../docs/workspace_backup.md): `backup-create`, `backup-verify`, `backup-restore`
- [エージェント向けCLI利用ガイド](../docs/agent_usage.md): `schema`, `template`, `validate`, `doctor`, `export-skill`
- [RSS移行ガイド](../docs/rss_migration.md): `import-rss`, `publish-rss-import`

---

## 4. アーカイブ（`design/archive/`）

`design/archive/` には、現行の簡素化アーキテクチャ（フェーズ1〜4）によって置き換えられた旧設計書、過去のリリース時点の全体設計スナップショット、および各マイルストーン・Issue の実機検証記録を保存している。**これらは歴史的経緯や過去の測定値の記録であり、現行コードの仕様や実環境操作の許可ではない。**

- **旧バージョンの全体設計スナップショット**:
  - [v0.7.6以前の全体設計（非同期FIFOジョブ・R2ステージング・R2スナップショット時代）](archive/initial_design_v076.md)
  - [v0.5.2以前の全体設計（Cloudflare Queues方式時代）](archive/initial_design_v052.md)
  - [旧AGENTS.mdの保存規約・マイルストーン履歴（2026-10-17）](archive/agent_storage_and_milestones_20261017.md)
- **フェーズ1〜4で置き換えられた旧SQLite設計・検討記録**:
  - 旧逐次公開・操作記録・復旧・稼働制御: [SQLite逐次公開計画](archive/sqlite_sequential_publication_implementation_plan.md)、[操作記録テーブル設計](archive/sqlite_operation_records_schema.md)、[中断操作の確認・再開案](archive/sqlite_operation_recovery_options.md)、[操作再開ガイド（旧）](archive/sqlite_operation_recovery.md)、[受付停止と配信停止の分離](archive/show_admission_delivery_separation_plan.md)、[停止・再開ガイド（旧）](archive/show_availability.md)、[Worker更新の検証続行](archive/sqlite_worker_update_recovery.md)、[blocked診断・復旧案（未実装）](archive/publication_blocked_recovery_plan.md)、[単一PUT・U1](archive/m6_upload_recovery_options.md)
  - 旧R2スナップショット・サイト・ドメイン初期計画: [Episode追加中のFeed継続](archive/episode_add_feed_availability_plan.md)、[Episode更新中のFeed継続](archive/episode_update_feed_availability_plan.md)、[Show更新中のFeed継続](archive/show_update_feed_availability_plan.md)、[番組サイト初期設計](archive/show_website_plan.md)、[CSSカスタマイズ比較](archive/show_website_customization_options.md)、[説明文表示改善](archive/show_website_description_display_plan.md)、[短縮URL提案](archive/show_website_site_slug_proposal.md)、[公開日タイムゾーン](archive/show_website_timezone_plan.md)、[独自ドメイン初期計画](archive/sqlite_custom_domains_plan.md)、[独自ドメインP0確認](archive/sqlite_custom_domains_p0.md)、[ドメインenvironmentレビュー](archive/sqlite_custom_domain_environment_review.md)、[ドメイン応答ログ調査](archive/sqlite_domain_response_logging.md)、[リモート診断・監視初期計画](archive/remote_diagnostics_and_monitoring_plan.md)、[v0.6.0 Queue削除計画](archive/schema_v1_removal_plan.md)、[コードレビュー（2026-10-21）](archive/code_review_20261021.md)、[レビュー修正（2026-10-22）](archive/code_review_fixes_20261022.md)
- **過去の実機検証・環境クリーンアップ記録**:
  - 試験環境の削除・保持環境廃棄の記録: [2026-10-29 main-head実機テスト環境削除](archive/cloudflare_main_smoke_cleanup_20261029.md)、[保持環境`sq16r-6ec01dc6`の廃棄](archive/sq16r_environment_decommission_20261029.md)、[2026-10-17一括削除](archive/cloudflare_test_environment_cleanup_20261017.md)、[2026-10-17棚卸し](archive/cloudflare_cleanup_inventory_20261017.md)、[Issue #24削除](archive/cloudflare_issue24_cleanup_20261018.md)、[Issue #40削除](archive/cloudflare_issue40_cleanup_20261019.md)、[Issue #48削除](archive/cloudflare_issue48_cleanup_20261021.md)、[2026-10-22削除](archive/cloudflare_review_test_cleanup_20261022.md)
  - 機能別の過去実機試験: [予約公開 11/11非公開検証](archive/issue65_scheduled_publication_11_live_20261027.md)、[予約公開 9/9検証](archive/issue65_scheduled_publication_live_20261026.md)、[CLI実データ検証](archive/issue65_cli_real_data_verification_20261024.md)、[サイトtimezone検証](archive/show_website_timezone_trial_verification_20261027.md)、[サイト短縮URL検証](archive/show_website_short_url_trial_verification_20261026.md)、[サイト説明文検証](archive/show_website_description_trial_verification_20261026.md)、[サイトCSS検証](archive/show_website_css_large_trial_verification_20261026.md)、[サイト初回検証](archive/show_website_private_trial_verification_20261025.md)、[配信統計実機検証](archive/episode_delivery_statistics_live_20261025.md)、[リモート診断実機検証](archive/remote_diagnostics_live_verification_20261025.md)、[独自ドメイン2 Show検証](archive/sqlite_custom_domain_two_show_verification_20261024.md)、[独自ドメイン反復検証](archive/sqlite_custom_domain_iterative_verification_20261024.md)、[独自ドメイン初回/再試験](archive/sqlite_custom_domain_live_verification_20261024.md)
