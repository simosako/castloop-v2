# 設計文書の案内

現在の公開版はv0.3.0。まず[全体設計](initial_design.md)を読み、操作方法は[プロジェクトREADME](../README.md)と[独自ドメイン利用案内](../docs/custom_domains.md)を参照する。

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
| [公開受付のQueue移譲案](publication_queue_delegation_options.md) | CLIからの直接Queue送信、commit/claimの非HTTP化、token・queued receipt・pause/重複/保持の変更。レビュー用 |
| [独自ドメイン設計](custom_domain_plan.md) | 管理URL分離・正規URL切替・復旧 |
| [管理機能候補](podcast_management_features_draft.md) | 一覧の採用結果と未採用の候補 |
| [M7: RSS取り込み案](m7_rss_import_plan.md) | Issue #1への承認済み開発方針。実装中 |
| [M7: 公開所要時間の改善案](m7_publication_performance_plan.md) | Issue #10の120秒待機上限と重複I/Oの分析・レビュー用計画 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

[archive/](archive/)には、初期レビュー、完了済みの検証計画・実装ログ・受け入れ記録、M6の部品ごとの開発記録、旧形式移行の検討を保存する。ファイル名は移動前と同じで、階層は増やさない。

通常の開発で一括して読む必要はない。判断の理由、過去の障害、検証証跡を調べるときだけ該当文書を参照する。本文の「未実装」「未公開」「資源を保持」は記録当時の状態であり、現在の仕様・残タスクやCloudflare資源の現状を示さない。

試験環境の廃棄・保留の履歴は[2026-10-11の削除記録](archive/cloudflare_test_environment_cleanup_20261011.md)を参照する。

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
