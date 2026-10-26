# 設計文書の案内

Issue #65の予約公開とIssue #70の改善を統合した現在の内部queue/content形式は**11/11**、必須サイト識別は`static-show-v2`。新規環境専用であり、予約公開版9/9・サイト試験版10/11等からの変換・互換配備は行わない。以下の番号は各段階の履歴として区別する。合意したサイト機能と本人の画面確認は完了したが、統合版の実配備、native Free性能、スマートフォン／キーボードの実機確認は未完了である。

Issue #70の自動短縮URL版は内部queue/content形式**10/11**・サイト識別`static-show-v2`の新規環境専用。Show直下の自動16文字ハッシュだけをEpisodeページ入口とし、衝突時だけ延長する。HTTP(S)リンク表示とcopyrightフッター削除も実装した。[URL設計と実装](show_website_site_slug_proposal.md)・[利用ガイド](../docs/show_website.md)を参照する。旧9/10等のDBは変換・互換配備しない。

Issue #70のCSSカスタマイズ開発版は内部queue/content形式**9/10**の新規環境専用。固定HTML＋標準デザイン1種類＋任意CSS 1ファイルを接続した。後続の[説明表示改善](show_website_description_display_plan.md)ではHTML解析用の`htmlparser2`を追加し、タグなし抜粋と安全な段落・改行表示を実装した。サイトフレームワーク・生成用サービスは追加しない。[CSS採用方針と実装状況](show_website_customization_options.md)・[利用ガイド](../docs/show_website.md)を参照する。以下の8/9等は各段階時点の番号であり、旧環境への互換配備は行わない。

Issue #70開発版の第1段は、内蔵番組サイトの全公開経路・CLI・HTML専用Gateway/CDN cacheを接続した最小限実装。内部queue/content形式は**8/9**、必須`website="static-show-v1"`の新規環境専用で旧環境は変換しない。[サイト設計](show_website_plan.md)と[利用ガイド](../docs/show_website.md)参照。下記の7/8等は各リリース・機能導入時点の番号。専用環境で本人の3 Episode再生を確認したが、native Free性能は未確認で、当時は見栄え等を後続とした。

Issue #65開発版は、Show内予約表と既存Alarmによるfuture UTCの予約公開を実装した。予約はFIFOを先に占有せず、Pause・受付停止・保守・runtime/base変更では`needs_approval`へ移る。CLIは予約preview、作成、一覧、詳細、日時変更、取消、再承認を提供する。内部queue/content形式は**9/9**（queue `9` は予約表を含む）、fresh環境専用で旧8/9を変換しない。[予約設計](episode_scheduled_publication_plan.md)と[管理用設定ガイド](../docs/admin_configuration.md)参照。隔離したfresh環境で3 Episodeの予定前未配信・予定後配信を確認した。Pause/再承認・取消・Alarm再配送・性能は未確認（[実機検証](issue65_scheduled_publication_live_20261026.md)）。

v0.7.5はIssue #64の公開済み差分・revision履歴・過去版採用を追加する。内部queue/content形式**7/8**の新規環境専用で、v0.7.4の7/7を含む既存環境は変換しない。[リリースノート](../docs/release-v0.7.5.md)と[公開内容の確認ガイド](../docs/published_content_review.md)を優先し、以下の旧形式・開発時点の記録と区別する。実CloudflareでのCPU・無料枠適合は未検証である。

Issue #66の未リリース開発版は[受付停止と配信停止の分離](show_admission_delivery_separation_plan.md)を採用し、内部queue/content形式を**7/7**にした。変更番号と操作ID別の結果保存、GETによる結果照会を実装した。ローカル693試験・型検査・Linux単体CLIとオフライン試験が成功。実Cloudflare操作は未実施で、旧形式は変換しない。Worker更新中の配信継続は対象外であり、以下のIssue #68の6/7環境での実機結果を新機能の実証へ流用しない。[停止・再開の利用ガイド](../docs/show_availability.md)参照。

未リリースのIssue #68開発では、fresh専用の内部queue/content形式を6/7へ変更し、SQLite独自subdomainと旧workers.dev公開URLのredirectを追加する。旧5/6環境の移行・採用はしない。[反復試験](sqlite_custom_domain_iterative_verification_20261024.md)の応答修正後、[第9環境の2 Show総合機能試験](sqlite_custom_domain_two_show_verification_20261024.md)で公開・独自origin配信・redirect・個別Pause・更新/復元・通常deploy・切断復帰・履歴保持を確認した。両Show paused/ready/drainedで終了。RSS・故障注入・内部cache状態・性能/全Free適合等の未確認範囲は同記録と[計画](sqlite_custom_domains_plan.md)で区別する。

v0.7.2はエージェント向けCLIと管理者Skillを追加したrelease。Worker・永続形式はv0.7.1から変更しない。[リリースノート](../docs/release-v0.7.2.md)と[利用ガイド](../docs/agent_usage.md)を参照する。Cloudflare実機検証は今回の変更範囲では省略し、ローカル回帰と単体バイナリで確認する。

v0.7.1はv0.7.0と同じ永続形式・互換境界で、レビュー修正を含むpatch release。[変更点と検証の限界](../docs/release-v0.7.1.md)を参照する。配布・インストールと実環境への配備は別操作である。

v0.7.0はIssue #48のShow分離layoutを採用し、サービス設定version 2に`storage_layout="show-v1"`を必須とする。旧layoutは維持・移行せず、新規環境だけを扱う。Pause/ResumeはShow単位。[採用設計](do_show_separation_options.md)と[現行構成](initial_design.md)を優先する。v0.6.2以前のリリース案内は配布済み版の履歴であり、新layoutの実機検証ではない。

v0.6.0はサービス設定version 2（SQLite）のみを扱い、`init`も既定でSQLiteを作る。リリースの取得と実環境への配備は別操作。まず[全体設計](initial_design.md)を読み、操作は[README](../README.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、[RSS案内](../docs/rss_migration.md)を参照する。既存version 1サービスはv0.5.xと[Queue専用ガイド](../docs/queue_service.md)を使い、移行機能は提供しない。[v0.7.0変更点](../docs/release-v0.7.0.md)、[v0.6.2変更点](../docs/release-v0.6.2.md)、[v0.6.1変更点](../docs/release-v0.6.1.md)、[v0.6.0変更点](../docs/release-v0.6.0.md)、[旧版v0.5.2](../docs/release-v0.5.2.md)を区別する。

## 開発時に参照する文書

| 文書 | 用途 |
| --- | --- |
| [エージェント向け共通ルール](../AGENTS.md) | 常時必要な開発・安全ルールと作業別の参照先。検討履歴は必要なときだけ読む |
| [管理者キーの照合](admin_authentication.md) | ネイティブ比較、非同期認証、互換環境と診断の制約 |
| [全体設計](initial_design.md) | 現在の構成・仕様・未提供機能 |
| [公開済み内容との差分確認とrevision履歴・過去版採用](published_diff_and_revision_restore_plan.md) | Issue #64・1A〜5A採用。全文取得と差分、確認hash、素材再uploadなしの過去版採用。内部7/8の新規環境専用。[利用ガイド](../docs/published_content_review.md) |
| [番組サイト・Episodeページの設計](show_website_plan.md) | Issue #70第1段・案Bとサイト方式の2択を採用。事前HTML生成・専用Gateway/cache・Show DOの原子的切替・CLI・全公開経路を接続。内部8/9の新規環境専用。§13でローカル・小規模実機検証と未確認範囲を区別する |
| [番組サイトのカスタマイズ方式の比較・採用方針](show_website_customization_options.md) | Issue #70後続。Bを採用しローカル実装。Free枠内の運用と単純さを優先し、新たな外部依存・生成用サービスは追加しない。比較、CLI／DOの分担、保存・CSPと§12の検証範囲を整理する |
| [説明文の抜粋・全文表示の改善案](show_website_description_display_plan.md) | Issue #70後続・個別ページ方式を実装し、本人から表示・全文への導線が正常との報告あり。§6.1〜6.2に生成範囲とFree制約、§11にparser選択・20/100/1,000件の確認。§12のHTTP(S)リンク復元・フッター削除は短縮URL版の新規非公開環境へ配備済み |
| [Episodeページの自動短縮URL設計・実装](show_website_site_slug_proposal.md) | Show直下の自動16文字ハッシュ・衝突時だけ延長・公開後固定を実装。中間のe/・長いページ入口・互換性・移行は不要。内部ID・音源URLは維持し、管理者の設定を増やさない。内部10/11の新規環境向け |
| [公開日表示のタイムゾーン](show_website_timezone_plan.md) | 案Aを採用。Showの任意site_timezone、未設定UTC、公開時点の夏時間を反映した日付・UTC差を事前HTMLへ出力。管理用timezone・RSS日時とは分離し、新しい依存や閲覧時処理は追加しない。[本人限定環境での確認](show_website_timezone_trial_verification_20261027.md)で東京設定を検査し、本人から日付表示の確認報告あり。native Free性能は未確認 |
| [自動短縮URL・リンク表示版の非公開実機試験](show_website_short_url_trial_verification_20261026.md) | 旧専用環境の退避・削除、新規本人限定環境への通常音源3件公開、全量音源照合・短いリンクと安全な本文リンク・フッター非表示・公開前後の未認証30要求拒否。823回帰成功。本人による画面確認済み。native Free性能は未確認 |
| [非公開の番組サイト画面確認・実機試験案](show_website_private_trial_plan.md) | Issue #70。コンテンツパスのAccess保護。[初回結果](show_website_private_trial_verification_20261025.md)は本人の短尺3件再生成功。初回環境を明示承認で削除し、[標準デザイン・通常サイズ3件](show_website_css_large_trial_verification_20261026.md)も本人の再生報告あり。同環境を[説明文表示改善版へ更新](show_website_description_trial_verification_20261026.md)し、未認証拒否・生成HTML、本人による表示と全文への導線を確認。CPU測定は未確認。テスト非公開の共通指示はAGENTS.mdに記載 |
| [Episode予約公開の設計・開発計画](episode_scheduled_publication_plan.md) | Issue #65の採用方針と実装範囲。Show内予約表とAlarm、既定UTC・任意管理zone、日時identity、停止・再承認、CLI/API、内部9/9。fresh環境で3件確認、Pause/再承認等は未確認 |
| [公開受付停止と配信停止の分離設計](show_admission_delivery_separation_plan.md) | Issue #66・全項目承認済み。3状態、停止・再開、変更番号と操作結果の保存・GET照会を実装。再開は処理終了を待ち、受付停止ではuploadも止める。内部形式7/7の新規環境専用。Worker更新中の配信継続は対象外 |
| [管理用設定と予約公開](../docs/admin_configuration.md) | Issue #65。任意のcastloop-admin.toml、schema/template/validate/doctor、オフライン日時preview、stage済みdraftの予約preview・作成・一覧・詳細・変更・取消・再承認 |
| [Issue #65 CLI基盤の実データ検証](issue65_cli_real_data_verification_20261024.md) | 指定サンプル3＋36 Episode、約1.50GB、単体バイナリ162試験が期待どおり。原本不変。ptrace制約で通信観測は欠測、Cloudflare予約実行は未実装・未試験 |
| [Issue #65 予約公開のCloudflare実機検証](issue65_scheduled_publication_live_20261026.md) | fresh環境で3 Episodeを約3分間隔に予約。予定前のFeed未配信、予定後の追加、`publication_state=succeeded`、dispatch時刻を確認。Pause/再承認・取消・Alarm再配送・性能は未確認 |
| [SQLite独自ドメイン対応計画](sqlite_custom_domains_plan.md) | Issue #68。開発版のCLI/REST/DO接続、Cloudflare DNS前提、管理/公開origin分離、redirect、個別停止と設定・Feed切替、ローカル検証範囲 |
| [独自ドメインP0・API条件の確認](sqlite_custom_domains_p0.md) | 公開Attach/Detachを採用。外部同時変更は想定外という制約を記録し、保留解消・開発継続。HTTP/identity/Feed採番の契約 |
| [SQLite独自ドメイン操作](../docs/sqlite_custom_domains.md) | 開発版のadd/list/status/continue/remove、必要権限、停止と再開、中断・切断時の制約 |
| [SQLite独自ドメイン実機確認](../docs/sqlite_custom_domain_live_acceptance.md) | 新規隔離環境と専用hostnameでの確認手順と2 Showの結果参照。新しい実環境操作へ過去承認を流用しない |
| [SQLite独自ドメイン初回実機・停止記録](sqlite_custom_domain_live_verification_20261024.md) | 2 Showの通常公開・Pause、API応答/opaque ID修正、未知接続非採用、保守拘束付きの最終停止状態と未試験範囲 |
| [SQLite独自ドメイン再試験・停止記録](sqlite_custom_domain_live_retest_20261024.md) | 別hostname・fresh環境でもreceipt検証で停止。原因未確定、初回環境保持、履歴hash保持、値を出さないfield診断の追加 |
| [environment診断とreceipt契約の追加レビュー](sqlite_custom_domain_environment_review.md) | 第3環境の停止記録と提案履歴。ログ調査を優先した経緯 |
| [ログ付き再試験と修正](sqlite_custom_domain_iterative_verification_20261024.md) | PUT空文字・DELETE空本文を特定/修正。第8環境でShow 0件のadd/remove完了、旧unknown/lock保持と未試験範囲 |
| [独自ドメイン2 Show総合実機確認](sqlite_custom_domain_two_show_verification_20261024.md) | 第9環境で公開/配信/301・307/個別Pause/更新・復元/接続維持deploy/切断復帰が成功。最終Pause、8履歴object保持、旧8環境不変と検証限界 |
| [独自domain応答検証ログと調査](sqlite_domain_response_logging.md) | 既存stderrは空で元PUTは欠測。CLIへHTTP/body/JSON/schemaの段階とenvironment固定分類を追加。秘密非出力・非再送のローカル回帰 |
| [エージェントによるPodcast管理の改善案](agent_integration_plan.md) | Issue #5。単一バイナリでのschema・雛形・Skill配布、明示対象指定、オフライン検証、doctor、承認と中断対応。MCPは不採用 |
| [リモート診断・監視の設計案](remote_diagnostics_and_monitoring_plan.md) | Issue #67。diagnose/progress/verify/watchの4コマンド提案、scope付き検査分類、CLI完結の終端報告、段階実装。レビュー済み、段階A〜D実装済み。[利用方法](../docs/observability.md)。[実機確認記録](remote_diagnostics_live_verification_20261025.md) |
| [Episode別・日別の配信統計の設計案](episode_delivery_statistics_plan.md) | Issue #71。観測点、指標定義、Range/HEAD/bot/revisionの扱い、未計測と0の区別、PII非保持、Show DO SQLite集計、保持日数設定（`stats-retention`）と通算累計保持（案8-α-2＋案8-A）。実装済み。[実機確認記録](episode_delivery_statistics_live_20261025.md) |
| [エージェント向けCLIの利用方法](../docs/agent_usage.md) | v0.7.2。Skill export、JSON外枠、明示対象、ローカルpreviewと入力照合、診断・検証範囲 |
| [コード全体レビュー（2026-10-21）](code_review_20261021.md) | セキュリティ・容量境界・重複・効率・テストの評価。再現済みの不具合と改善候補、検証範囲 |
| [レビュー修正とPR（2026-10-22）](code_review_fixes_20261022.md) | R1〜R10の対応範囲・commit/PR依存順・全体検証・残る走査コストと実機未確認範囲 |
| [レビュー修正の小規模実機確認](archive/code_review_fixes_live_verification_20261022.md) | 新規隔離2 Show・3 Episode、11 job成功と最終Pause。tail欠測・canceled Alarm・観測未完了を機能結果と区別 |
| [レビュー実機確認の観測調査](archive/review_observation_investigation_20261022.md) | 音源UUID秘匿化と相関条件の不適合、元の欠測HTTPの保存ログ回収、成功後の重複Alarm取消仮説と未解決の診断欠落 |
| [リリースCIのAction固定](../docs/ci_security.md) | 不変SHA・upstream確認・権限維持・手動更新の方針 |
| [Zodセキュリティ更新](../docs/zod_security_update_20261025.md) | Issue #78。Zod 4.6.7への限定更新、ローカル検証、CLI/Worker反映と既存環境の互換境界 |
| [v0.6.0のQueue方式コード削除計画](schema_v1_removal_plan.md) | Issue #24。v0.5.xのschema version 1機能は維持し、v0.6.0以降はSQLite単独化。削除範囲・共用処理の分離・検証・既存環境の保全 |
| [単一PUT・U1](m6_upload_recovery_options.md) | 採用方式と未検証の仮定 |
| [REST URLの構築](rest_url_construction.md) | パス要素のエンコード、R2 keyの区切り保持と単一PUTの不変条件 |
| [承認済み方針](m6_review_queue.md) | 記録保持・安全条件・開発範囲 |
| [SQLite逐次公開の実装計画](sqlite_sequential_publication_implementation_plan.md) | 一意upload→DO SQLite FIFO→Alarm。実DO入口・fresh init/readiness・正式CLI・配信接続のローカル実装と残る実機/P6の範囲 |
| [SQLite方式の操作・制限](../docs/sqlite_sequential_development.md) | 既定のschema version 2 init、公開・pause/resume、限定検証続行、未知IO保全と未対応機能 |
| [SQLite Worker更新の検証続行](sqlite_worker_update_recovery.md) | Issue #11/#33の現行経路。PUT成功checkpoint、配備後GET失敗の明示続行、旧journalと未知IOの境界（v0.5.2で提供） |
| [操作記録のIDとテーブル設計](sqlite_operation_records_schema.md) | Issue #40。作業と要求の区別、要求元と時刻の記録、Show DO SQLiteの現行DDLと検索例 |
| [M7: RSS取り込み案](m7_rss_import_plan.md) | Issue #1への承認済み開発方針と実装経緯。現行の利用方法はRSSガイドを使う |
| [Show/Episodeの項目別入力上限](show_episode_input_limits.md) | Issue #31。Apple基準・大きめ解釈の新規入力上限、保存履歴の無制限読取維持、検証範囲 |
| [Show単位のDO分離](do_show_separation_options.md) | Issue #48。Show単位DO/Pause/Resume、全体Pause廃止、所属・共有更新の制御DOを採用。旧版互換・移行不要 |
| [Episode追加中のFeed継続配信](episode_add_feed_availability_plan.md) | Issue #50第1段階の設計。世代別Feedと原子的な切替、blockedで旧内容を配信、世代蓄積の保持方針。schema 3/4・固定coverは第1段階時点の記録 |
| [Episode更新中のFeed継続配信](episode_update_feed_availability_plan.md) | metadata-only/audio-only/同時更新で旧Feed・旧MP3を継続配信。base revision/lifecycle guard、blockedの隔離条件。schema 4/5は第2段階時点の記録 |
| [Show更新中のFeed継続配信（第3段階）](show_update_feed_availability_plan.md) | v0.7.0〜v0.7.2のschema 5/6・必須health識別。coverの不変object、Feed/画像の原子切替、共通guardとblocked条件。開発版の6/7採番はIssue #68計画を参照 |

入力例は[Show](show-template.toml)と[Episode](episode-template.toml)。

## アーカイブ

レビュー修正の実機試験環境`rv22-8988de53`は[2026-10-22の削除記録](archive/cloudflare_review_test_cleanup_20261022.md)を参照する。Worker・専用namespace・R2全39オブジェクトとbucketを削除し、保持サービス・元の証跡・非公開退避は維持した。観測の未解決事項を解消済みへ変更したものではない。

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

Issue #48の初回停止・2 Show試験・空cache診断の3 Worker、2 bucket、2 namespaceは[2026-10-21の削除・私有証跡保持記録](archive/cloudflare_issue48_cleanup_20261021.md)を参照する。保持サービス`sq16r-6ec01dc6`は変更せず、一次証拠はGit対象外で保持している。

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

### 2026-10-21にアーカイブした文書（v0.7.0リリース後の整理）

v0.7.0のリリースに伴い、完了済みIssueの検証・実機確認記録と比較検討をarchiveへ移した。現行の契約・操作は上表の設計書と各ガイドが担う。過去の障害理由、観測条件、測定値を調べるときだけ参照する。

検証・実機確認の記録：

- [SQLite単独化の実環境回帰試験](archive/schema_v1_removal_live_test.md) — Issue #24。短尺3件＋通常音源36件の公開、全音源照合、Worker更新後の保持、保存ログのCPU観測条件
- [SQLite単独化後のテスト責務監査](archive/sqlite_test_responsibility_audit.md) — Issue #34。v0.6.0基準commitでの残存テストの責務対応、統合範囲と保持した安全回帰
- [操作記録と再開機能のローカル確認](archive/sqlite_operation_records_verification.md) — Issue #40。CLI/SQL/模擬R2の回帰、強制終了時のプロセス排他、記録量の小規模確認
- [操作記録の小規模実機確認](archive/sqlite_operation_records_live_verification_20261019.md) — Issue #40。正常公開、成功応答の保存前後でのSIGKILL、再開と再送拒否、配信ハッシュと最終paused状態
- [Show分離のローカル検証](archive/do_show_separation_verification.md) — Issue #48。独立SQLite/Alarm、blocked・個別Resume・共有更新の故障注入、正式CLI walkthrough
- [Show分離の実機確認（初回）](archive/do_show_separation_live_verification_20261020.md) — Issue #48。初期化のcache purge確認でblockedとなった初回停止と停止証跡の記録
- [purge障害の切り分けとShow分離の再試験](archive/do_show_separation_live_retest_20261021.md) — Issue #48。2 Show・6 Episode公開、個別Pause/Resume・配信確認が成功。初回purge障害の根本原因は未確定
- [Show分離後のWorker更新の実機確認](archive/do_show_separation_worker_update_live_20261021.md) — Issue #48。既存データを保持するcode-only更新が成功。native反映待ち後、再配備せず明示verifyで全DOのprobe・保守解除を完了
- [Episode追加中のFeed継続配信の実機確認](archive/episode_add_feed_live_verification_20261021.md) — Issue #50。前後ともrunningの16取得組で旧Feed 200/304・未公開音源404、新世代切替・snapshot保持・最終Pause
- [Episode更新中のFeed継続配信の実機確認](archive/episode_update_feed_live_verification_20261021.md) — 3種類の更新で更新中の旧Feed配信、完了後の切替・旧新音源hash・最終Pauseを確認
- [Show更新中のFeed継続配信の実機確認](archive/show_update_feed_live_verification_20261021.md) — 3種類のShow編集と追加metadata観測が成功。旧Feed 200/304、画像の旧hashまたはHEAD/ETag、13 snapshot保持、最終Pause

比較・検討と旧設計：

- [中断した操作の確認・再開・取消](archive/sqlite_operation_recovery_options.md) — Issue #40。方式比較と採用したDO SQLite案の設計。利用は[操作ガイド](../docs/sqlite_operation_recovery.md)、表構成は[現行DDL](sqlite_operation_records_schema.md)を参照
- [サーバー側の操作記録の保存先比較](archive/sqlite_operation_record_storage_options.md) — Issue #40。保存先の比較、DO SQLiteの無料枠と容量試算、記録の保持・整理・警告方針
- [RSS lookupのBun互換性調査](archive/rss_lookup_bun_compatibility.md) — Issue #32。Bun 1.4.2のIPv4/IPv6・HTTP/HTTPSとcompile fixtureでは現行経路の形式不一致を再現せず。正式配布CLIの受け入れ試験とは区別する
- [旧M6 Lifecycle設計](archive/m6_content_lifecycle_plan.md) — Queue時代の停止・削除設計。共通の保持・不可逆削除の安全条件は[承認済み方針](m6_review_queue.md)とSQLiteガイドが現行

あわせて、本文をv0.6.0整備時にarchiveへ移していた7件の案内スタブ（async_management_implementation、custom_domain_plan、m6_compatible_updates、m6_completion_recovery、m6_fresh_initialization、public_delivery_projection、publication_execution_recovery）をdesign/直下から削除し、参照リンクをarchiveへ付け替えた。

現在の仕様を変更したら直下の文書を更新する。完了した開発記録はarchiveへ移し、参照リンクも更新する。未解決の制約や承認済みの安全条件を、単に開発が完了したという理由でアーカイブしない。
