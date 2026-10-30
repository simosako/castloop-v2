# castloop v2 デザインドキュメント

## 現行開発版：フェーズ1・2・3（簡素化アーキテクチャ）

2026-10-28〜10-29の簡素化（[全体見直し](../architecture_simplification_review_20261028.md)・[フェーズ1](../phase1_atomic_publication_and_ondemand_delivery_plan.md)・[フェーズ2](../phase2_direct_media_and_cli_simplification_plan.md)・[フェーズ3](../phase3_deploy_and_runtime_control_simplification_plan.md)）では、Podcast配信の本来の目的に合わせて全体を以下のシンプルな構造に刷新した。

- **同期アトミックな公開と直接素材配置**: CLIはローカル入力を検証し、変更された音源・画像だけを内容ハッシュ（SHA-256）のR2キーへ直接配置して、metadataと素材参照をJSONでShow DOへ送る。DOは素材の読取・コピーを行わず、必要なキャッシュパージ後に単一SQLiteトランザクションで公開内容・履歴・短縮ID・世代を一括確定する（同一内容なら`unchanged`）。失敗時は副作用を残さず、そのまま同じコマンドを再実行できる。
- **RSSフィード・番組サイトのオンデマンド生成**: Feed XMLと番組サイトHTMLはR2へ事前バッチ生成せず、配信リクエスト時にShow DOのSQLiteからオンデマンド描画してEdgeキャッシュに乗せる。
- **単発deployと稼働制御の簡素化**: `worker_version_id` のDB保存・一致強制、起動Probe Alarm、`admission_window_id`、および `show-pause` / `show-resume` 系コマンドを廃止した。登録したShowは即座に稼働し、配信を止めたい場合は既存のlifecycle操作（非公開化・復元）を使う。`castloop deploy` は事前停止やjournalなしの単発スクリプト更新であり、予約公開もそのまま維持される。DOのAlarmは予約公開（`dispatchDue`）のみに使用する。
- **変更前設定の保存と再実行可能な管理操作**: 初期化（`init`）や独自ドメイン変更（`domain`）は、途中の通信失敗で永久ロックするのではなく、変更前後の設定を保持し、APIで現状を確認しながら同じ目標状態へ再実行・継続できる設計とする。

内部queue/content形式は新規環境専用の**14/13**。配備は未実施で、旧形式からの変換・互換配備は提供しない。具体契約は[フェーズ1](../phase1_atomic_publication_and_ondemand_delivery_plan.md)・[フェーズ2](../phase2_direct_media_and_cli_simplification_plan.md)・[フェーズ3](../phase3_deploy_and_runtime_control_simplification_plan.md)、操作は[SQLiteガイド](../../docs/sqlite_sequential_development.md)を優先する。以下は簡素化前の導入履歴・旧契約であり、FIFO・job・staging・事前生成・Pause/Resume・2相更新・未知IOロックに関する記述は現行経路へ適用しない。

## 簡素化前の設計・導入履歴

現在のIssue #65／#70統合版は内部queue/content形式**11/11**・`static-show-v2`の新規環境専用。予約表とサイト改善を両方含むため、旧9/9・10/11等への互換配備・変換はしない。以下は各機能の導入段階の記録であり、現在の操作・形式は[サイト利用ガイド](../../docs/show_website.md)を優先する。本人によるサイト表示・再生・東京日付の確認は完了したが、統合版の実配備とnative Free性能は未確認である。

Issue #70の自動短縮URL版は内部queue/content形式10/11の新規環境専用。EpisodeページはShow直下の自動ハッシュURL一つだけとし、長いページ入口・`e/`・互換転送・DB変換は提供しない。HTTP(S)リンク復元とcopyrightフッター削除も含む。[URL設計](show_website_site_slug_proposal.md)・[サイト利用ガイド](../../docs/show_website.md)を優先する。

Issue #70のCSSカスタマイズ開発版は内部queue/content形式**9/10**の新規環境専用。固定HTML＋標準デザイン1種類＋Show単位のCSS 1ファイルを提供する。CLIがCSSを検証してShow metadataへ同梱し、既存Show DOがHTMLへ事前に埋め込む。生成用サービスは追加しない。後続の[説明表示改善](show_website_description_display_plan.md)ではHTML解析用の`htmlparser2`を追加し、一覧のタグなし160文字から既存個別ページの全文へリンクする。全文は安全な段落・改行とHTTP(S)リンクで表示する。第1段8/9からの移行・互換配備はしない。[CSS採用方針](show_website_customization_options.md)と[利用ガイド](../../docs/show_website.md)を参照する。

Issue #70開発版は、Showごとに内蔵サイト／外部サイトを選択できる。内蔵HTMLは既存Show DOのAlarmで生成し、private R2の世代別snapshotへ保存する。`SiteCachedPages`とHTML専用Gatewayは既存media cacheから分離し、最新のShow判定を共有する。必要な両purge後、Feedとサイト全体の世代・ページ参照を同一transactionで確定する。内部queue/content形式は**8/9**、必須`website="static-show-v1"`の新規環境専用。下記の7/8以前の番号は各機能導入時点の履歴である。[サイト設計](show_website_plan.md)・[利用ガイド](../../docs/show_website.md)参照。Freeの実機性能・ブラウザ実機再生は未確認。
Issue #65開発版は、Show内の予約表と既存Alarmでfuture UTCのEpisode／Show公開を実行する。予約はFIFOへ先に入らず、到来時に同じShowの通常jobとして原子的に投入される。Pause・受付停止・保守・runtime／config／base変更では`needs_approval`へ移り、明示再承認なしに実行しない。予約実行日時は`published_at`と別で、後者を書き換えない。CLIは`preview-episode-schedule`／`schedule-episode`、`schedule-list`／`status`／`reschedule`／`cancel`／`reapprove`を提供する。内部queue/content形式は**9/9**、fresh環境専用で旧8/9を含む環境を変換しない。未来の`published_at`は予約ではなく、`preview-episode`の`future_published_at`警告と`publish-episode --allow-future-published-at`で即時公開を明示する。[予約設計](../episode_scheduled_publication_plan.md)・[管理用設定ガイド](../../docs/admin_configuration.md)参照。9/9環境で予定前未配信・予定後配信、Pause→再承認→公開、日時変更→取消、未来予約中の即時公開、直リンクの404/200を確認した。11/11統合版は新規の本人限定環境で予約3件・取消1件とAccess拒否を確認した。Alarm再配送・blocked・同時刻予約・性能は未確認（[9/9実機検証](issue65_scheduled_publication_live_20261026.md)、[11/11非公開実機検証](issue65_scheduled_publication_11_live_20261027.md)）。

Issue #64の開発版では、認証付きの公開済み全文・履歴取得とCLIの項目差分・ローカルRSS生成、保存済みrevisionの明示採用を追加した。Show内SQLiteに履歴2表を置き、R2の不変metadata・画像・音源と照合する。採用は新revisionとして保存・purge・SQL確定し、素材再uploadや過去履歴の上書きはしない。内部queue/content形式**7/8**、必須`revision_history="sqlite-revisions-v1"`の新規環境専用で旧環境は変換しない。[採用設計](../published_diff_and_revision_restore_plan.md)と[利用ガイド](../../docs/published_content_review.md)参照。実Cloudflareの配備・公開・性能確認は行っていない。

Issue #66の未リリース開発版では、Showの状態を`open / admission_paused / paused`に分ける。`admission_paused`は新しい公開依頼と素材アップロードを止め、既存の検証条件を満たす公開済み内容は配信する。`paused`は受付と配信を両方止める従来の意味を維持する。停止・再開ごとの変更番号と操作ID別の適用結果を同じShow内で保存し、古い確認結果による再開を拒否する。応答喪失後は結果のGET照会だけを行う。内部queue/content形式**7/7**と必須`availability_controls="show-admission-delivery-v1"`を使う新規環境専用。Worker更新中の配信継続や旧環境の変換は提供しない。[採用設計](show_admission_delivery_separation_plan.md)と[操作ガイド](show_availability.md)を優先し、下記のリリース時点の2状態・6/7形式の記述と区別する。

Issue #68の未リリース開発版: [独自ドメイン計画](sqlite_custom_domains_plan.md)に沿い、Feed世代を公開jobのFIFO sequenceから独立した共通予約表で採番する。内部queue/content schemaは**6/7**、healthの必須`feed_generation_allocator="reservation-v1"`を用いるfresh環境専用。cover世代は引き続きShow公開job sequenceで、Feed世代から推測しない。旧5/6を含む環境の移行・互換配備は提供しない。CLI/REST連携は[専用ガイド](../../docs/sqlite_custom_domains.md)を参照し、実機未確認・未承認と区別する。

DO側のdomain変更は専用prepare/activate/status/finalizeと`domain_changes="sqlite-domain-change-v1"`で識別する。全Showをpaused/drainedで保守拘束し、所属を固定して新configへ配備した後、全対象native確認・不変Feed再生成/purge・readinessを経て明示finalizeする。全体Pauseや自動Resumeは追加しない。独自originの管理APIは404、旧workers.devの許可済み公開URLは明示Resume後だけFeed 301/cover・audio 307とする。同対象への外部ツールの並行DNS/接続変更は想定外として制約を記録する。

2026-10-21追補: [Show更新中のFeed継続配信設計](show_update_feed_availability_plan.md)を実装した。Episode追加・更新に加え、公開済みShowのmetadata/cover/同時更新でも旧Feed・画像・承認済み音源を配信する。Feed/Show/cover世代と対象種別のguardを保存・照合し、不変cover snapshotと新metadata/Feedをpurge後に原子的に切り替える。内部queue/content schema **5/6**、healthの必須`feed_storage`/`cover_storage`は`immutable-generation-v1`、`publication_read_boundary="show-episode-v1"`を使う新規環境専用。第1・第2段階を含む旧環境の移行・互換配備は提供しない。

更新日: 2026-10-21。**v0.7.0の仕様**。v0.6.2の公開・操作記録機能をShow単位DOへ分離し、Pause/ResumeをShow単位に変更する。配布済みv0.6.2の旧layoutとは非互換で、移行・旧版サポートは提供しない。設計と検証範囲は[採用設計](../do_show_separation_options.md)、過去のリリースは[v0.6.2](../../docs/release-v0.6.2.md)を参照。
操作は[README](../../README.md)、詳細は[SQLiteガイド](../../docs/sqlite_sequential_development.md)、[文書索引](../README.md)を参照する。

## リリース境界

- v0.6.0以降はサービス設定`schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`のみを扱う。
- 本リリースはさらに`storage_layout = "show-v1"`を必須とする。省略した旧設定は管理要求・配備・鍵/journal作成前に拒否する。既存設定へ追記して移行する手順ではなく、新規環境専用である。
- `castloop init`の既定はSQLite。従来の`--publication-protocol sqlite-sequential-v1`も省略可能な指定として受け付ける。
- v0.5.xでは従来のQueue/R2方式を維持するが、v0.6.0向けコードと配布物から旧専用CLI／Worker／schema／テストを削除した。
- 旧version 1設定は管理操作・配備・鍵作成前に拒否する。専用移行機能、旧journal変換、既存資源採用、fallbackを提供しない。
- Show／Episode／revisionとSQLite要求等の独立した`schema_version = 1`はそのまま維持する。サービス設定versionと混同しない。
- v0.5.2までの設計・開発履歴は[保存版](initial_design_v052.md)、削除範囲は[Issue #24計画](schema_v1_removal_plan.md)を参照する。

## 構成とデータの正

Podcastを管理者自身のCloudflareアカウントへ配備する。1サービスにつき1 private R2 bucket、1 public Worker、所属・共有更新の制御DOを使用し、Showごとに独立したSQLite-backed DOを持つ。複数Showを同じbucketにID別で保存し、Cloudflare Queues／DLQ／D1は使用しない。

```text
CLI: ローカルTOMLと素材の検証 → 一意のR2 keyへupload → 全量readback/hash/size/identity確認
  → 明示publishで要求を凍結しDOへ送信
Show DO: SQLiteへ受付・順序を原子的に保存 → Show内のAlarmがFIFOで一件ずつ実行
  → 検証 → 不変音源/revision・current/feed/cover保存 → cache purge → SQL完了
Gateway: 対象Show DOの最新の小さい配信判定 → 同versionのcache owner → R2 streaming
制御DO: Show永久予約・登録、所属一覧、共有Worker更新の対象集合と途中状態
```

ローカルTOMLは編集元、R2はpayloadと公開snapshot、SQLiteは制御状態・content index・受付順・job結果の正本とする。R2をlock/status/progress DBとして使わない。

### WorkerとCLI

- 正式Worker入口は`src/sqlite-worker.ts`。`SqlitePublicationService`がDO、`SqliteCachedAssets`がnamed cache owner。
- Issue #70ではHTML専用のnamed cache owner `SiteCachedPages`を追加する。既存class・binding・compatibility dateは変更しない。
- 同じnamespace/class内の`service/<service_id>`を制御DO、`show/<service_id>/<show_id>`をShow DOとする。永続bindingでShowを固定し、異なるShowの公開・操作登録を拒否する。binding/export/cache名とcompatibility dateは維持する。
- Bunで構築する単一実行ファイルにSQLite Workerのみを埋め込む。source modeは`packages/cli/src/index.ts`。
- 管理者環境にWrangler／Node.js／Bun／ffprobe／別R2資格情報を要求しない。Linux x86-64が配布・実機検証対象。
- Cloudflare REST管理は`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を用いる。別の管理鍵とjournalをgit-ignoredな`.castloop/`へ保存し、TOMLやGitに秘密を入れない。

## 公開と不変条件

- createはローカル作成／Show登録、updateは素材保存だけ。**明示publish以外は公開しない**。
- 素材ごとに一意upload ID/keyを使用し、公開前に現在のローカル入力と確認済みreceiptを照合する。要求・request/job ID・hashを送信前に凍結する。
- MP3は300,000,000 bytes以下、JPEG/PNGカバーは5MB以下。CLIでMP3/duration・source EOF・全量readback/hash/size/ETag/versionを検証する。
- 新公開音源はstreamのままR2 bindingへSHA-256付きで保存する。不変音源とrevision履歴は通常更新で上書き・削除しない。metadata-onlyは既存音源を再利用する。
- GUID、permalink意味、公開日時を維持する。未来日時は予約公開を意味しない。Showの公開済み画像拡張子変更は非対応。
- strict Zod・`@iarna/toml`を使い、XML 1.0で禁止された文字・不正UTF-8を拒否する。`castloop.toml`は通常ファイル・1〜16,384 bytes・最終要素symlink拒否で読む。

## 受付・逐次実行・失敗

- SQLiteのsequenceで順序を決める。受付とAlarm予約、成功とcontent更新・次回起動をそれぞれ短いstorage transactionで保存し、外部IOをtransactionに入れない。
- runtime/config/window、Show/Episodeの世代・baseを正確に照合する。stale入力、同IDで異なる要求、古い受付windowを拒否する。
- `queued`は受付のみ、`succeeded`はそのjobの全保存・purge・SQL完了。global quiescenceや回復権限の証明ではない。
- `failed`は副作用前の確定入力/base失敗。`blocked`は途中停止・不明IO等であり対象Showの後続FIFOを止める。Show更新・Episode追加/更新で確定Feed/Show/cover世代・要求hash・対象種別と対象未登録または更新元revision/lifecycleの保存根拠が一致し、検証済みflagと許可reasonが成立する場合だけ旧公開内容の読取を継続する。Show更新は旧coverのkey/size/SHA-256もHEAD照合してから検証済みにする。それ以外は配信503。他Showの通常操作・Pause/Resume・新Show登録を止めない。
- 再起動／Alarm再配送で残ったrunningを再実行せずblockedとして保全する。経過時間・HEAD不在・空queueで解放せず、未知PUT/POSTを再送しない。blockedのretry/releaseは未提供。
- サイト生成は最大20 HTML・4,000,000 bytesの有限batchで進める。正常完了と次回Alarm予約を保存したbatch間のrunningだけを再開できる。実行中の中断・未知IOと区別し、Feed／音源／purgeの再送を許可する仕組みにはしない。domain保守も同じHTML生成部品と専用の完了markerを使う。
- 管理GETだけは有限の一時エラーretryを行う。status待機は最大300 GET・5分経過後に新規GETを始めない。開始済みIOとcleanupのsettlementを待つ。
- 診断は固定のallowlistコード・許可した識別子だけを保存し、本文・メール・秘密・任意例外文を運用記録へ入れない。

## 配信とキャッシュ

公開URLは`/podcasts/<showId>/feed.xml`、`cover.jpg|png`、`episodes/<episodeId>/<revisionId>.mp3`。Issue #70の内蔵方式では`/podcasts/<showId>/`、`page/<n>/`（n≥2）、`episodes/<episodeId>/`も配信する。system／staging／metadata／世代別snapshot・内部索引は配信しない。

- gatewayはpublic pathから対象Show DOへ直接到達し、毎回その最新scalar判定でready・Pause・保守拘束・Show/Episode状態・承認音源を確認する。制御DOへの毎回の照会や判定のTTL cacheは行わない。
- paused/readiness不一致・保守拘束は503、unpublishedは404。Show更新・Episode追加/更新のrunning/条件を満たすblockedでは、保存した保護根拠が成立すれば旧Feed・承認済みcover/audioを配信する。初回Show公開、lifecycleの実行中／blocked、要求破損や保護根拠不一致は503。SQLiteの削除状態に対するgateはあるが物理削除操作は未提供。
- 許可した要求のみ同version cache ownerへ送り、認証header／cookie／queryを転送しない。
- GET／HEAD／単一Range／ETag・日付条件付き応答を維持する。外向け成功応答は再検証必須、非公開／停止／エラーはno-store。内部cache tagを外へ出さない。
- cache propsのgenerationを分離し、遅い旧cache fillを新feedへ使わない。必要なpurgeが成功するまで公開完了にしない。
- FeedのR2読取先は`public/podcasts/<showId>/feeds/<feed_generation>.xml`、coverは`public/podcasts/<showId>/covers/<cover_generation>.jpg|png`で、HEAD/GETとも許可された同世代に固定する。cover世代をFeedやShow状態世代から推測せず、Episode公開・Show復元では保存済みcoverを維持する。世代を指定する公開URLは設けず、旧snapshotを自動削除しない。確定Feed/coverの欠落を検出したら503でfallbackしない。
- 公開cover URLは固定。切替をまたぐ別HTTP要求では旧Feedと新画像になる場合がある。画像だけの編集ではFeed bytes/ETagが変わらず304となり得る。同じ画像でもShow publishごとに新snapshotを保存する。

## 管理と運用

- fresh initは未使用資源のみ。制御DOのREST/runtime/SQL/Alarm/R2/cache/purgeを確認する。Show登録は他Showのjobを参照せず、予約と送信開始を保存してから対象Showを初期化する。Showはpausedでprobeし、明示Resumeを待つ。
- `show-pause`は対象Showの配信と新規受付を閉じ、既受付jobだけdrainする。`show-resume`は同Showがpaused/drained/readyかつ保守拘束外のとき新windowで再開する。全体Pause/Resumeは設けない。
- `service-status`のstate/drainedはShow照会の集約であり非原子的なsnapshot。全体windowはnull。通常操作の許可や更新ロックの根拠にはしない。
- deployは同じconfig/schema/namespaceのcode-only更新。各Showを明示Pause/drainし、制御DOで所属集合を固定する。Show別prepareとResume禁止を原子的に保存し、全件確認後だけ配備へ進む。全Showと制御DOのactivation/probe完了後に保守拘束を解除し、Showはpausedを維持する。部分成功・未知応答の再送や自動rollbackはしない。
- `update-service-verify`はPUT成功checkpoint／配備receiptと凍結入力を照合して、既知配備の検証と未開始のactivation/probeだけを明示続行する。旧receipt-free journal・未知activationを推測で昇格しない。[更新契約](sqlite_worker_update_recovery.md)参照。
- `init-reconcile`／`update-service-reconcile`は正確な完了済みserver証拠との読取照合のみ。initの限定検証続行もresource／配備／要求済みsetupを繰り返さない。
- Show一覧はregistryのkeyset paginationと対象ページのShow照会、Episode一覧は対象ShowのSQLで20件ずつ返す。照会失敗・登録途中を不存在へ変換しない。非公開化／復元は同じShowのFIFOへ送る。
- RSSはdownload→ローカルreview→新規Showへの逐次公開。GUID・日時を維持するが、subscriber／旧ホスト移行やservice schema変換は行わない。

## 操作記録（Issue #40）

操作・要求・素材・履歴と形式管理の5表は対象Show DOに置く。CLIはupload前に操作を登録し、PUT開始、成功応答、検証、下書き登録を記録する。公開の受付・実行・完了履歴は同じShowのキュートランザクションへ接続する。content/queue/操作記録の表形式は新Show内で再利用し、旧DBの読取・変換は行わない。

管理要求は`X-Castloop-Show-Id`で対象を明示する。remote操作記録コマンドは`--show SHOW`を必須とし、操作の横断索引・全Show operation-listは設けない。ローカル要求journalへShow経路も凍結する。`job-status`とlifecycle照会は保存済み要求のShowから経路を決める。

一覧・詳細・容量表示は読取専用。成功応答があるuploadと完了済み公開は結果を照合して続行する。取消後の未使用staging素材は、利用禁止を原子的に確定してから、プレビューと確認hashに従って削除する。必要な記録は保持し、容量を50/70/85%で警告する。

詳しくは[操作記録の設計](sqlite_operation_records_schema.md)と[利用方法](sqlite_operation_recovery.md)を参照する。旧版v0.6.1以前や、以下の過去の実機測定とは区別する。

## 未提供機能と検証の限界

物理delete、既存サービス移行、blocked retry/release、未登録uploadの一般cleanup、予約配信、音源変換、統計は提供しない。独自domainの開発版対応は本書冒頭と専用ガイドの範囲に限る。旧Queueのdomain／deleteを代替として呼び出さない。

過去のSQLite36件＋更新10回・通常HTTP最大3/5ms・probe60/60は[保存した負荷の結果](sqlite_size36_measurement_20261017.md)。今回の削除版のnative性能や全Free適合を示すものではない。300MB新経路・実機purge rate-limit retry・#13恒久解消・万能復旧は保証しない。

コード変更・試験完了はCloudflareの配備・resume／公開・資源削除・domain／権限／課金変更の許可ではない。保持環境と私有journal／素材／証跡を保全する。

## 開発確認

`npm ci`、`npm run check`、`bun test`、`npm run build:cli -- linux-x64`を用いる。新たなlint等は追加しない。模擬SQL/Alarm/R2/Cache/RESTと、Cloudflare nativeのoutput gate・再配送・purgeを区別する。
