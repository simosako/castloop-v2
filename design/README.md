# 設計文書の案内

現在の公開版はv0.5.1。まず[全体設計](initial_design.md)を読み、操作方法は[プロジェクトREADME](../README.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、[RSS移行案内](../docs/rss_migration.md)を参照する。既存schema-version-1は[Queue方式ガイド](../docs/queue_service.md)を使い、SQLiteへ自動変換しない。v0.5.1の変更点は[v0.5.1リリースノート](../docs/release-v0.5.1.md)、通常HTTPの10ms達成範囲・未対応機能・Issue #13の残る制限は[v0.5.0リリースノート](../docs/release-v0.5.0.md)で確認する。

## 開発時に参照する文書

| 文書 | 用途 |
| --- | --- |
| [エージェント向け共通ルール](../AGENTS.md) | 常時必要な開発・安全ルールと作業別の参照先。検討履歴は必要なときだけ読む |
| [管理者キーの照合](admin_authentication.md) | ネイティブ比較、非同期認証、互換環境と診断の制約 |
| [Cloudflare資源の棚卸し・削除候補](cloudflare_cleanup_inventory_20261017.md) | 2026-10-17の調査時点の一覧。[承認済み削除結果](archive/cloudflare_test_environment_cleanup_20261017.md)では最新SQLite環境だけを保持し、旧環境と試験用ドメインを廃棄済み |
| [全体設計](initial_design.md) | 現在の構成・仕様・未提供機能 |
| [Lifecycle設計](m6_content_lifecycle_plan.md) | 非公開化・復元・削除の状態と安全条件 |
| [新規初期化](m6_fresh_initialization.md) | 新規資源と稼働判定の責務 |
| [互換更新](m6_compatible_updates.md) | pause・処理終了確認・配備・検証 |
| [完了応答喪失の照合](m6_completion_recovery.md) | 確認済み完了の復旧条件と限界 |
| [単一PUT・U1](m6_upload_recovery_options.md) | 採用方式と未検証の仮定 |
| [REST URLの構築](rest_url_construction.md) | パス要素のエンコード、R2 keyの区切り保持と単一PUTの不変条件 |
| [承認済み方針](m6_review_queue.md) | 記録保持・安全条件・開発範囲 |
| [publication停止の診断とtoken保全](publication_execution_recovery.md) | Show/Episodeの停止経路・開始/終了ログ・DLQ根拠の解放の撤回・読み取り調査 |
| [HTTP commitのCPU削減・責務分離](http_publication_commit_optimization_plan.md) | 承認済みのQueue検証集約、受付/失敗通知の契約、残る固定負担と実装後の測定 |
| [HTTP受付の固定負担改善計画](http_acceptance_fixed_cost_optimization_plan.md) | 818c642後のservice snapshot共有・同一loopback probe・現在値と再parseの分離。レビュー用の次改修案 |
| [公開受付のQueue移譲案](publication_queue_delegation_options.md) | 段階A/Bの先行比較。現在の承認済み開発は案Cの限定commandへ進んだ |
| [Queue commit段階A](publication_queue_commit_stage_a.md) | 開発中のcommit intent/MAC、execution所有、queued journal、重複・応答喪失・保持の実装契約と試験 |
| [Queue commitの実機測定](publication_queue_commit_measurement_20261015.md) | 7公開成功、HTTP commitなし、Queue CPUと残るclaim/status/staging HTTPのFree目標未達 |
| [現行HTTPの順序・CPU整理](http_execution_cpu_breakdown_20261015.md) | staging/publicationの呼び出し順、要求全体CPU、共通guardとfinish/statusの処理内容、未測定の内部CPU |
| [管理処理の非同期化・構成比較](async_management_architecture_options.md) | 案Cの実装/テスト承認と他案の比較。資源/権限変更・配備は別承認 |
| [案C: Queue/R2管理経路](async_management_implementation.md) | 開発中のstart/complete/publish、署名済みgrant/result、async admission、journal・未知IO・回帰試験 |
| [案Cの実機測定](async_management_measurement_20261015.md) | 隔離配備と7公開成功、管理HTTPなし、Queue CPU、feed最大11msと総wall増加の制限 |
| [公開feedのCPU調査](feed_delivery_cpu_investigation_20261015.md) | 11msの観測範囲、毎回の設定/状態検証、ローカルprofileと安全条件を維持する改善候補 |
| [配信判定の事前生成](public_delivery_projection.md) | 管理側のstrict検証と原子的metadata生成、通常HTTPのHEAD-only判定、互換更新時の準備と旧移行の分離 |
| [配信判定事前生成の実機測定](public_delivery_projection_measurement_20261015.md) | 同一feedの配備前後比較、metadata-only公開後の確認、CPUの帰属とtail識別子の補正 |
| [通常規模36件の連続公開測定](normal36_publication_measurement_20261015.md) | 29件完了、30件目R2事前照合で停止。Queue/HTTP CPUと未完了範囲 |
| [試験通知・R2読取診断](trial_notifications_and_r2_read_diagnostics.md) | tmux独立監視と同一OpenCode sessionへの通知、一時GETの有限再試行、診断のallowlist |
| [SQLite逐次公開の実装計画](sqlite_sequential_publication_implementation_plan.md) | 一意upload→DO SQLite FIFO→Alarm。実DO入口・fresh init/readiness・正式CLI・配信接続のローカル実装と残る実機/P6の範囲 |
| [SQLite方式の操作・制限](../docs/sqlite_sequential_development.md) | v0.5.0のschema version 2明示init、公開・pause/resume、未知IOの保全、未対応操作と実機未検証の範囲（v0.5.1の検証強化を含む） |
| [SQLite実機受け入れ・測定](sqlite_sequential_measurement_20261016.md) | 新規隔離環境の段階試験、初回REST応答形の修正、既知の配備を再送しない検証継続と測定範囲 |
| [SQLite追加受け入れ・観測改善](sqlite_followup_verification_20261016.md) | canceled/read timeoutと公開失敗の分離、CPU/jobログ欠測の明示、正式RSS・互換更新の確認順序 |
| [DO・CPUログ欠測の調査](sqlite_tail_missing_logs_investigation_20261017.md) | DO実行のGraphQL照合、paused GETでのtail比較、反映待ち仮説と未確定の配送原因、観測開始・終了条件の不足 |
| [36件規模の再試験・CPU測定](sqlite_size36_measurement_20261017.md) | status GET切断と有限retry修正、未開始分だけ継続して36 Episode＋更新10回完了。probe CPU 60/60、通常HTTP最大3/5ms、最終pause |
| [制御状態の保存先・公開方式の再検討](control_plane_storage_reconsideration_20261016.md) | R2/DO/D1の比較履歴。DO＋Queuesと全面的な公開先切替を必須とした案は最新計画で修正 |
| [独自ドメイン設計](custom_domain_plan.md) | 管理URL分離・正規URL切替・復旧 |
| [管理機能候補](podcast_management_features_draft.md) | 一覧の採用結果と未採用の候補 |
| [M7: RSS取り込み案](m7_rss_import_plan.md) | Issue #1への承認済み開発方針と実装経緯。v0.4.0の利用案内はdocs/rss_migration.md |
| [M7: 公開所要時間の改善案](m7_publication_performance_plan.md) | Issue #10の120秒待機上限と重複I/Oの分析・レビュー用計画 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

[archive/](archive/)には、初期レビュー、完了済みの検証計画・実装ログ・受け入れ記録、M6の部品ごとの開発記録、旧形式移行の検討を保存する。ファイル名は移動前と同じで、階層は増やさない。

通常の開発で一括して読む必要はない。判断の理由、過去の障害、検証証跡を調べるときだけ該当文書を参照する。本文の「未実装」「未公開」「資源を保持」は記録当時の状態であり、現在の仕様・残タスクやCloudflare資源の現状を示さない。

[旧AGENTS.mdの保存規約・マイルストーン](archive/agent_storage_and_milestones_20261017.md)には、常時読み込む指示から切り出した判断・進捗・実機測定の記録を保存した。内容は切り出し前のままであり、古い承認を再実行の許可にしたり、当時の未実装事項を現在の作業一覧にしたりしない。今後の進捗・測定・個別承認も対応する設計／証跡文書へ記録し、AGENTS.mdには時系列で追記しない。

試験環境の廃棄履歴は[2026-10-17の削除記録](archive/cloudflare_test_environment_cleanup_20261017.md)を参照する。以前の廃棄・保留は[2026-10-11の削除記録](archive/cloudflare_test_environment_cleanup_20261011.md)に残す。

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
