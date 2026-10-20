# 設計文書の案内

開発版はIssue #48のShow分離layoutを採用し、サービス設定version 2に`storage_layout="show-v1"`を必須とする。旧layoutは維持・移行せず、新規環境だけを扱う。Pause/ResumeはShow単位。[採用設計](do_show_separation_options.md)と[現行構成](initial_design.md)を優先する。以下のリリース案内は配布済み版の履歴であり、新layoutの実機検証ではない。

v0.6.0はサービス設定version 2（SQLite）のみを扱い、`init`も既定でSQLiteを作る。リリースの取得と実環境への配備は別操作。まず[全体設計](initial_design.md)を読み、操作は[README](../README.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、[RSS案内](../docs/rss_migration.md)を参照する。既存version 1サービスはv0.5.xと[Queue専用ガイド](../docs/queue_service.md)を使い、移行機能は提供しない。[v0.6.2変更点](../docs/release-v0.6.2.md)、[v0.6.1変更点](../docs/release-v0.6.1.md)、[v0.6.0変更点](../docs/release-v0.6.0.md)、[旧版v0.5.2](../docs/release-v0.5.2.md)を区別する。

## 開発時に参照する文書

| 文書 | 用途 |
| --- | --- |
| [エージェント向け共通ルール](../AGENTS.md) | 常時必要な開発・安全ルールと作業別の参照先。検討履歴は必要なときだけ読む |
| [管理者キーの照合](admin_authentication.md) | ネイティブ比較、非同期認証、互換環境と診断の制約 |
| [全体設計](initial_design.md) | 現在の構成・仕様・未提供機能 |
| [v0.6.0のQueue方式コード削除計画](schema_v1_removal_plan.md) | Issue #24。v0.5.xのschema version 1機能は維持し、v0.6.0以降はSQLite単独化。削除範囲・共用処理の分離・検証・既存環境の保全 |
| [SQLite単独化の実環境回帰試験](schema_v1_removal_live_test.md) | Issue #24。既存MP3を用いる隔離環境での段階試験と結果 |
| [SQLite単独化後のテスト責務監査](sqlite_test_responsibility_audit.md) | Issue #34。残存テストの責務対応、統合範囲と保持する安全回帰、ローカル試験時間の比較 |
| [旧Lifecycle設計と共通安全条件](m6_content_lifecycle_plan.md) | Queueの履歴。保持・削除の安全条件は維持するが、現行SQLiteの操作はSQLiteガイドを使う |
| [単一PUT・U1](m6_upload_recovery_options.md) | 採用方式と未検証の仮定 |
| [REST URLの構築](rest_url_construction.md) | パス要素のエンコード、R2 keyの区切り保持と単一PUTの不変条件 |
| [承認済み方針](m6_review_queue.md) | 記録保持・安全条件・開発範囲 |
| [SQLite逐次公開の実装計画](sqlite_sequential_publication_implementation_plan.md) | 一意upload→DO SQLite FIFO→Alarm。実DO入口・fresh init/readiness・正式CLI・配信接続のローカル実装と残る実機/P6の範囲 |
| [SQLite方式の操作・制限](../docs/sqlite_sequential_development.md) | 既定のschema version 2 init、公開・pause/resume、限定検証続行、未知IO保全と未対応機能 |
| [SQLite Worker更新の検証続行](sqlite_worker_update_recovery.md) | Issue #11/#33の現行経路。PUT成功checkpoint、配備後GET失敗の明示続行、旧journalと未知IOの境界（v0.5.2で提供） |
| [中断した操作の確認・再開・取消](sqlite_operation_recovery_options.md) | Issue #40。方式の比較、採用したDO SQLite案、再開・取消・未公開素材削除の設計。利用は[操作ガイド](../docs/sqlite_operation_recovery.md)を参照 |
| [サーバー側の操作記録の保存先比較](sqlite_operation_record_storage_options.md) | Issue #40。保存先の比較、DO SQLiteの無料枠と容量試算、記録の保持・整理・警告方針 |
| [操作記録のIDとテーブル設計](sqlite_operation_records_schema.md) | Issue #40。作業と要求の区別、セッションを省く理由、要求元と時刻の記録、DO SQLiteのDDLと検索例 |
| [操作記録と再開機能の確認結果](sqlite_operation_records_verification.md) | Issue #40。CLI/SQL/模擬R2の回帰、強制終了時のプロセス排他、記録量の小規模確認と実機確認の範囲 |
| [操作記録の小規模実機確認](sqlite_operation_records_live_verification_20261019.md) | Issue #40。正常公開、成功応答の保存前後でのSIGKILL、再開と再送拒否、配信ハッシュと最終paused状態 |
| [M7: RSS取り込み案](m7_rss_import_plan.md) | Issue #1への承認済み開発方針と実装経緯。現行の利用方法はRSSガイドを使う |
| [RSS lookupのBun互換性調査](rss_lookup_bun_compatibility.md) | Issue #32。Bun 1.4.2のIPv4/IPv6・HTTP/HTTPSとcompile fixtureでは現行経路の形式不一致を再現せず。正式配布CLIの受け入れ試験とは区別する |
| [Show/Episodeの項目別入力上限](show_episode_input_limits.md) | Issue #31。Apple基準・大きめ解釈の新規入力上限、保存履歴の無制限読取維持、検証範囲 |
| [Show単位のDO分離](do_show_separation_options.md) | Issue #48。Show単位DO/Pause/Resume、全体Pause廃止、所属・共有更新の制御DOを採用。旧版互換・移行不要。実装・ローカル検証は承認済み、実機操作は別承認 |
| [Show分離のローカル検証](do_show_separation_verification.md) | Issue #48。458テスト成功、型検査・Linux CLI build成功。独立SQLite/Alarm、blocked・個別Resume・共有更新の部分成功/応答喪失・native版反映待ち、正式CLI walkthrough。実機未確認 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

v0.6.0のQueueコード削除に伴い、次をv0.5.x以前の履歴へ分離した。保存した契約や過去の承認は、現行SQLiteの新機能・移行・復旧・実環境操作の許可ではない。

- [v0.5.2全体設計](archive/initial_design_v052.md)
- [Queue非同期管理](archive/async_management_implementation.md)、[公開停止診断・解放撤回](archive/publication_execution_recovery.md)
- [Queue新規初期化](archive/m6_fresh_initialization.md)、[互換更新](archive/m6_compatible_updates.md)、[完了照合](archive/m6_completion_recovery.md)
- [R2配信判定projection](archive/public_delivery_projection.md)、[独自ドメイン](archive/custom_domain_plan.md)

[archive/](archive/)には、初期レビュー、完了済みの検証計画・実装ログ・受け入れ記録、M6の部品ごとの開発記録、旧形式移行の検討を保存する。ファイル名は移動前と同じで、階層は増やさない。

通常の開発で一括して読む必要はない。判断の理由、過去の障害、検証証跡を調べるときだけ該当文書を参照する。本文の「未実装」「未公開」「資源を保持」は記録当時の状態であり、現在の仕様・残タスクやCloudflare資源の現状を示さない。

[旧AGENTS.mdの保存規約・マイルストーン](archive/agent_storage_and_milestones_20261017.md)には、常時読み込む指示から切り出した判断・進捗・実機測定の記録を保存した。内容は切り出し前のままであり、古い承認を再実行の許可にしたり、当時の未実装事項を現在の作業一覧にしたりしない。今後の進捗・測定・個別承認も対応する設計／証跡文書へ記録し、AGENTS.mdには時系列で追記しない。

試験環境の廃棄履歴は[2026-10-17の削除記録](archive/cloudflare_test_environment_cleanup_20261017.md)を参照する。以前の廃棄・保留は[2026-10-11の削除記録](archive/cloudflare_test_environment_cleanup_20261011.md)に残す。削除前の資源一覧は[2026-10-17の棚卸し](archive/cloudflare_cleanup_inventory_20261017.md)に残す。

Issue #24の初回・再試験環境2件は[2026-10-18の廃棄記録](archive/cloudflare_issue24_cleanup_20261018.md)を参照する。保持環境`sq16r-6ec01dc6`とローカル原本・journal・証跡は削除対象外。

Issue #40の専用試験環境は[2026-10-19の削除記録](archive/cloudflare_issue40_cleanup_20261019.md)を参照する。保持環境とローカル原本・操作記録・証跡は維持している。

### 2026-10-18にアーカイブした文書

完了済みの検討・測定・Issue対応の記録であり、現行仕様の契約ではない。過去の判断理由や測定値を調べるときだけ参照する。

Queue非同期化・HTTP受付の検討と測定：

- [管理処理の非同期化・構成比較](archive/async_management_architecture_options.md) — 案Cの実装/テスト承認と他案の比較。資源/権限変更・配備は別承認
- [案Cの実機測定](archive/async_management_measurement_20261015.md) — 隔離配備と7公開成功、管理HTTPなし、Queue CPU、feed最大11msと総wall増加の制限
- [公開受付のQueue移譲案](archive/publication_queue_delegation_options.md) — 段階A/Bの先行比較。現在の承認済み開発は案Cの限定commandへ進んだ
- [Queue commit段階A](archive/publication_queue_commit_stage_a.md) — commit intent/MAC、execution所有、queued journal、重複・応答喪失・保持の実装契約と試験
- [Queue commitの実機測定](archive/publication_queue_commit_measurement_20261015.md) — 7公開成功、HTTP commitなし、Queue CPUと残るclaim/status/staging HTTPのFree目標未達
- [HTTP commitのCPU削減・責務分離](archive/http_publication_commit_optimization_plan.md) — 承認済みのQueue検証集約、受付/失敗通知の契約、残る固定負担と実装後の測定
- [HTTP受付の固定負担改善計画](archive/http_acceptance_fixed_cost_optimization_plan.md) — 818c642後のservice snapshot共有・同一loopback probe・現在値と再parseの分離。レビュー用の次改修案
- [現行HTTPの順序・CPU整理](archive/http_execution_cpu_breakdown_20261015.md) — staging/publicationの呼び出し順、要求全体CPU、共通guardとfinish/statusの処理内容、未測定の内部CPU
- [公開feedのCPU調査](archive/feed_delivery_cpu_investigation_20261015.md) — 11msの観測範囲、毎回の設定/状態検証、ローカルprofileと安全条件を維持する改善候補
- [配信判定事前生成の実機測定](archive/public_delivery_projection_measurement_20261015.md) — 同一feedの配備前後比較、metadata-only公開後の確認、CPUの帰属とtail識別子の補正

通常規模の公開試験と試験運用の診断：

- [通常規模36件の連続公開測定](archive/normal36_publication_measurement_20261015.md) — 29件完了、30件目R2事前照合で停止。Queue/HTTP CPUと未完了範囲
- [試験通知・R2読取診断](archive/trial_notifications_and_r2_read_diagnostics.md) — tmux独立監視と同一OpenCode sessionへの通知、一時GETの有限再試行、診断のallowlist

SQLite実機受け入れ・測定・調査：

- [SQLite実機受け入れ・測定](archive/sqlite_sequential_measurement_20261016.md) — 新規隔離環境の段階試験、初回REST応答形の修正、既知の配備を再送しない検証継続と測定範囲
- [SQLite追加受け入れ・観測改善](archive/sqlite_followup_verification_20261016.md) — canceled/read timeoutと公開失敗の分離、CPU/jobログ欠測の明示、正式RSS・互換更新の確認順序
- [DO・CPUログ欠測の調査](archive/sqlite_tail_missing_logs_investigation_20261017.md) — DO実行のGraphQL照合、paused GETでのtail比較、反映待ち仮説と未確定の配送原因、観測開始・終了条件の不足
- [36件規模の再試験・CPU測定](archive/sqlite_size36_measurement_20261017.md) — status GET切断と有限retry修正、未開始分だけ継続して36 Episode＋更新10回完了。probe CPU 60/60、通常HTTP最大3/5ms、最終pause
- [SQLite更新復帰の実機検証](archive/sqlite_update_recovery_verification_20261018.md) — Issue #11/PR #37。新規隔離環境で2箇所のGET故障注入、native反映待機後の明示続行、同一code更新2回のETag分離と再配備なしの完了。公開0件、最終ready/paused/drained

supersededの比較案・草案と完了済みIssue対応：

- [制御状態の保存先・公開方式の再検討](archive/control_plane_storage_reconsideration_20261016.md) — R2/DO/D1の比較履歴。DO＋Queuesと全面的な公開先切替を必須とした案は最新計画で修正
- [管理機能候補](archive/podcast_management_features_draft.md) — 一覧の採用結果と未採用の候補
- [M7: 公開所要時間の改善案](archive/m7_publication_performance_plan.md) — Issue #10の120秒待機上限と重複I/Oの分析・レビュー用計画
- [CLI source完了順序](archive/cli_upload_source_completion.md) — Issue #30のローカル再現、Content-LengthとEOFの競合修正・回帰試験
- [Worker tailのheartbeat試験](archive/worker_tail_heartbeat_tests.md) — Issue #29のevent loop遅延再現、期限判定とnative ping/pong疎通の分離、欠測判定を維持する回帰試験

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
