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
| [独自ドメイン設計](custom_domain_plan.md) | 管理URL分離・正規URL切替・復旧 |
| [管理機能候補](podcast_management_features_draft.md) | 一覧の採用結果と未採用の候補 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

[archive/](archive/)には、初期レビュー、完了済みの検証計画・実装ログ・受け入れ記録、M6の部品ごとの開発記録、旧形式移行の検討を保存する。ファイル名は移動前と同じで、階層は増やさない。

通常の開発で一括して読む必要はない。判断の理由、過去の障害、検証証跡を調べるときだけ該当文書を参照する。本文の「未実装」「未公開」「資源を保持」は記録当時の状態であり、現在の仕様・残タスクやCloudflare資源の現状を示さない。

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
