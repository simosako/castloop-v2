# 設計文書の案内

現在の公開版はv0.4.0。まず[全体設計](initial_design.md)を読み、操作方法は[プロジェクトREADME](../README.md)、[RSS移行案内](../docs/rss_migration.md)、[独自ドメイン利用案内](../docs/custom_domains.md)を参照する。FreeのHTTP CPU目標未達・Issue #13の残る制限は[リリースノート](../docs/release-v0.4.0.md)で確認する。

## 開発時に参照する文書

| 文書 | 用途 |
| --- | --- |
| [全体設計](initial_design.md) | 現在の構成・仕様・未提供機能 |
| [Lifecycle設計](m6_content_lifecycle_plan.md) | 非公開化・復元・削除の状態と安全条件 |
| [新規初期化](m6_fresh_initialization.md) | 新規資源と稼働判定の責務 |
| [互換更新](m6_compatible_updates.md) | pause・処理終了確認・配備・検証 |
| [完了応答喪失の照合](m6_completion_recovery.md) | 確認済み完了の復旧条件と限界 |
| [単一PUT・U1](m6_upload_recovery_options.md) | 採用方式と未検証の仮定 |
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
| [独自ドメイン設計](custom_domain_plan.md) | 管理URL分離・正規URL切替・復旧 |
| [管理機能候補](podcast_management_features_draft.md) | 一覧の採用結果と未採用の候補 |
| [M7: RSS取り込み案](m7_rss_import_plan.md) | Issue #1への承認済み開発方針と実装経緯。v0.4.0の利用案内はdocs/rss_migration.md |
| [M7: 公開所要時間の改善案](m7_publication_performance_plan.md) | Issue #10の120秒待機上限と重複I/Oの分析・レビュー用計画 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

[archive/](archive/)には、初期レビュー、完了済みの検証計画・実装ログ・受け入れ記録、M6の部品ごとの開発記録、旧形式移行の検討を保存する。ファイル名は移動前と同じで、階層は増やさない。

通常の開発で一括して読む必要はない。判断の理由、過去の障害、検証証跡を調べるときだけ該当文書を参照する。本文の「未実装」「未公開」「資源を保持」は記録当時の状態であり、現在の仕様・残タスクやCloudflare資源の現状を示さない。

試験環境の廃棄・保留の履歴は[2026-10-11の削除記録](archive/cloudflare_test_environment_cleanup_20261011.md)を参照する。

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
