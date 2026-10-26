# SQLiteのShow単位公開方式

現在のIssue #65／#70統合版は内部queue/content形式**11/11**の新規環境専用。予約表と自動短縮URLの両方を含み、旧9/9・10/11等のDBの変換・互換配備はしない。サイト識別は`static-show-v2`。[サイトガイド](show_website.md)を優先する。サービス設定version 2・metadata version 1・音源URLは維持する。以下の番号は各段階の履歴として区別する。

Issue #70/#71の開発版は内蔵番組サイトとEpisode別・日別の配信統計を追加し、CSSカスタマイズ対応後の内部queue/content形式を**9/10**、必須health/inspection識別を`website="static-show-v1"`と`delivery_statistics="episode-daily-v1"`にする新規環境専用。サイトは`create-show ID --site-mode builtin`で選び、明示公開でHTMLとFeedを確定する。任意のCSS 1ファイルはShow設定の`site_css_path`で指定する。統計の観測はGatewayの応答確定後（キャッシュヒット／ミス両対応）に行い、`ctx.waitUntil`で対象Show DOのSQLiteへ非同期記録する。統計機能の失敗が配信を止めることは構造的にない。保持日数はShowごとに`castloop stats-retention SHOW DAYS`で再配備なしに変更でき（既定400日）、期限を過ぎた日別行は1日1バッチで削除されつつ通算累計表へ合算される。照会は`castloop stats SHOW [--episode ID]`。第1段8/9を含む既存環境への互換配備・DB変換は行わない。下記の番号は機能導入時点の履歴として区別し、操作・無料枠の制限は[サイトガイド](show_website.md)と[配信統計ガイド](delivery_statistics.md)、判断の経緯は[サイト設計](../design/show_website_plan.md)と[統計設計](../design/episode_delivery_statistics_plan.md)を参照する。
Issue #65の予約公開は、Show DOの予約表と既存Alarmを使う。`preview-episode-schedule`／`schedule-episode`（Showは`preview-show-schedule`／`schedule-show`）でstage済みdraftをfuture UTCへ凍結し、`schedule-list`／`schedule-status`／`schedule-reschedule`／`schedule-cancel`／`schedule-reapprove`で管理する。予約はFIFOへ先に入らず、時刻到来時に既存jobとして投入される。Pause・受付停止・保守・runtime/base変更では`needs_approval`へ移り、明示再承認なしに実行しない。予約は`published_at`を変更しない。導入時の内部queue/content **9/9**の隔離したfresh環境で3 Episodeの予定前未配信・予定後配信を確認したが、Pause/再承認・取消・Alarm再配送・性能は未確認。現在の統合版は冒頭の11/11を使う。詳細は[管理用設定ガイド](admin_configuration.md)、[予約設計](../design/episode_scheduled_publication_plan.md)、[実機検証](../design/issue65_scheduled_publication_live_20261026.md)を参照する。

Issue #64の開発版は、内部queue/content形式**7/8**と必須`revision_history="sqlite-revisions-v1"`を使う新規環境専用。全文差分、Show/Episodeのrevision履歴、保持した素材による明示的な過去版採用を追加した。旧7/7を含めDB変換は行わない。[公開内容の確認ガイド](published_content_review.md)参照。既存の非公開化からの`restore`とは別操作である。

Issue #66の未リリース開発版は、公開受付と配信の停止を分ける。`show-admission-pause`は受付と素材アップロードだけを止め、公開済み内容の配信は続ける。`show-pause`は従来どおり両方を止める。配信だけ戻す`show-delivery-resume`と、操作結果を読む`show-control-status`を追加した。再開には既受付処理の終了・サーバーの動作確認済み・保守中でないことが必要。内部queue/content形式**7/7**と必須`availability_controls="show-admission-delivery-v1"`を使う新規環境専用で、旧形式を変換しない。[停止・再開の操作ガイド](show_availability.md)を優先する。Worker更新やドメイン変更は引き続き配信も停止して行う。

Issue #68の未リリース開発版はFeed世代の共通予約採番を導入し、内部queue/content schema **6/7**と必須health識別`feed_generation_allocator="reservation-v1"`・`domain_changes="sqlite-domain-change-v1"`を使う。旧5/6等の環境への移行・互換配備は行わず、対応版でfresh initする。独自domainは[専用ガイド](sqlite_custom_domains.md)を参照する。通常公開のFIFOは変更せず、cover世代はFeed世代と別に維持する。実機確認・配備の承認は含まない。

2026-10-21、Show更新の追補: v0.7.0は世代別Feed/cover保存（healthの`feed_storage`と`cover_storage`が共に`immutable-generation-v1`）、`publication_read_boundary="show-episode-v1"`と内部queue/content schema **5/6**を必要とする。Episode更新の4/5、追加専用の3/4や固定Feed方式の既存show-v1環境も互換更新・移行の対象外であり、新規環境を使う。対応CLIは形式識別の欠落・旧値・未知値をprepare/配備前に拒否する。[Show更新設計と境界](../design/show_update_feed_availability_plan.md)参照。

2026-10-20、Issue #48の新layout専用ガイド。**v0.7.0リリース。配布済みv0.6.2とは非互換**であり、以下の操作にはv0.7.0のCLI/Workerが必要。サービス設定に`storage_layout = "show-v1"`を必須とし、旧設定は副作用前に拒否する。既存設定への追記、旧DO/DB/journalの変換・移行・資源採用は行わない。[採用設計](../design/do_show_separation_options.md)参照。

`sqlite-sequential-v1`方式の操作ガイド。v0.6.0ではサービス設定version 2のみを扱い、`init`のflag省略時もSQLiteになる。`--publication-protocol sqlite-sequential-v1`は省略可能な既存指定として維持する。新たなschema選択オプションは設けない。
既存Queueサービスや旧journalを変換するマイグレーション機能は提供しない。version 1設定は副作用前に拒否し、利用者は対応するv0.5.xのCLI/Workerを保持する。
旧版v0.5.2は方式の明示指定が必要である。[同版ガイド](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/sqlite_sequential_development.md)を参照する。v0.6.2の操作記録は[リリースノート](release-v0.6.2.md)、v0.6.1の入力上限は[リリースノート](release-v0.6.1.md)、v0.6.0の変更と検証は[リリースノート](release-v0.6.0.md)と[隔離環境の回帰試験](../design/archive/schema_v1_removal_live_test.md)を参照する。

2026-10-17の[36件規模の確認](../design/archive/sqlite_size36_measurement_20261017.md)では、Episode公開36件とmetadata-only更新10回を完了した。
status GET切断による中断後は成功済み15 jobを照合し、未開始分だけ継続した。通常HTTP CPU最大3/5ms、公開probe 60/60を保存ログへ対応付け、ready/paused/drainedで終了した。
これは中断を挟む短尺音源試験であり、全負荷のFree適合・Issue #13恒久解消や大容量公開を保証しない。
初回purge blocked・旧試験の欠測は[先行測定](../design/archive/sqlite_sequential_measurement_20261016.md)、
互換更新・正式RSSの受け入れは[追加確認](../design/archive/sqlite_followup_verification_20261016.md)に区別して残している。
現行リリースは[v0.7.0リリースノート](release-v0.7.0.md)、過去の変更は[v0.6.2](release-v0.6.2.md)、[v0.6.1](release-v0.6.1.md)、[v0.6.0](release-v0.6.0.md)、[v0.5.2](release-v0.5.2.md)、[v0.5.1](release-v0.5.1.md)、[v0.5.0](release-v0.5.0.md)を参照。

## 対応範囲

- 1サービスにつき所属・共有更新の制御DO、Showごとに独立したSQLite-backed DO。明示公開をShow内FIFOで一件ずつAlarm実行する。異なるShowのIO待機は並行できる。
- Show登録、Show/Episodeのローカル作成、素材upload、公開、status、pause/resume、fresh init。
- metadata-onlyは既存音源を再利用。audio-onlyはmetadataのbaseも照合する。
- GET/HEAD/Range/条件付き応答は既存配信部品を利用し、外側gatewayが毎回DOの最新配信判定を見る。
- `list-shows`/`list-episodes`はSQLiteの20件ずつの一覧。`--json`、`--include-deleted`、`--cursor`に対応し、R2のmetadata列挙はしない。cursorはruntimeと検索条件へ束縛する。ローカルだけのdraftは含めない。
- `list-shows`は全体Pauseを判定しない。サービス一覧応答の`state`は`null`（未集約）とし、CLIもopen/pausedを表示しない。全Showの状態集約には`service-status`、対象Showには`show-status`を使う。`list-episodes`のstate/`Show admission`は対象Showだけの状態で、一覧を操作の許可根拠にはしない。
- Show/Episodeの非公開化・保存済みsnapshotの復元は、preview→hash確認→`lifecycle-execute`で同じFIFOへ送る。
- レビュー済みのローカルRSS取り込みは`publish-rss-import DIRECTORY`でShow→Episodeの順に公開できる。
- 同じconfig/SQLite schema/namespaceのcode-only更新を`deploy`で扱う。全Showを個別に明示Pause/drainし、固定した対象集合へのprepare/activation/probe後も各Showはpausedを維持する。
- v0.6.2から[操作記録・再開・取消](sqlite_operation_recovery.md)を提供する。対応WorkerのDO SQLiteに記録し、条件を満たす未公開staging素材だけを明示的に削除できる。v0.7.0ではremote照会に`--show`が必要である。旧版v0.6.1以前の機能とは区別する。
- 初期化はworkers.devだけで行う。開発版は完了後に[1サービス1専用subdomain](sqlite_custom_domains.md)を接続できる。**物理削除、既存移行、公開jobのretry/releaseは未対応**。旧方式へfallbackしない。

## 初期化

次は管理者が新環境の作成・配備を承認した場合の操作例。隔離試験への承認を、既存サービスや別環境の変更許可として流用しない。

```sh
castloop init ./new-service \
  --service-id my-service --bucket-name UNIQUE-PRIVATE-BUCKET \
  --account-id ACCOUNT_ID --workers-subdomain YOUR_SUBDOMAIN \
  --operation-id INIT_UUID
```

`UNIQUE-PRIVATE-BUCKET`は実際には小文字の有効なR2 bucket名へ置き換える。
Cloudflare認証は`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`だけを使う。
tokenには資源作成・Worker配備・R2操作・DO namespace確認に必要な権限が必要だが、自動拡張しない。
Wrangler、Node.js、別R2 credential、Queues/D1/DLQは不要。

`castloop.toml`はschema version 2。管理秘密鍵と凍結journalはgit-ignoredな`.castloop/`へ保存する。
初期化はresource/APIの設定・version/ETag/namespace/単一100%配備を照合し、
さらに**実DOのSQL、Alarm、R2設定読取、同versionのcache ownerとpurge**を確認する。
REST設定を読んだだけではreadyにしない。完了時はpausedのまま。

```sh
cd new-service
castloop service-status
```

全体Pause/Resumeコマンドはない。`service-status`のstate/drainedはShow照会の集約snapshotであり、全体windowはnull。更新ロックや未登録uploadの不存在・回復権限を示さない。ShowごとのResume UUIDは**新しい受付window**であり、init UUIDやPause UUIDとは別にする。

## Show/Episodeの公開

```sh
castloop create-show my-show --site-url https://YOUR_REAL_WEBSITE/
castloop show-status my-show
castloop show-resume my-show NEW_WINDOW_UUID
# Edit my-show/show.toml and place its JPEG/PNG cover file.
castloop update-show my-show
castloop publish-show my-show

cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first

# Scheduled publication: stage first, preview, then approve the exact hash.
castloop preview-episode-schedule first --workspace .. --show my-show \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-episode first --workspace .. --show my-show \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH --json
castloop schedule-status my-show SCHEDULE_UUID --json
```

- `create-*`は公開しない。`update-*`は一意のR2 keyへのuploadとreceipt保存を行い、公開はしない。v0.7.0では送信前にサーバーへ操作と素材を登録し、素材ごとの開始許可・成功応答・検証・下書き登録を記録する。
- 新Showは独立DOのSQL/Alarm/R2/cache probeをpausedで完了する。`show-pause SHOW PAUSE_UUID`は同Showの新規受付・配信を閉じ、既受付jobは取り消さずdrainする。別Showのblocked/pausedでも健全なShowは個別にResumeでき、新Showも登録できる。
- MP3上限は300,000,000 bytes。MP3解析・サイズ・全量readback/hash・ETag/versionを確認した素材だけを公開manifestへ登録する。
- 新規metadata入力にはApple基準の項目別上限を適用する（Show説明4000 UTF-8 bytes、Episode説明10000文字、title/author等255文字、site_urlは2048文字）。HTML tagは除外して測り、文字はUnicode code pointで数える。超過分は切り詰めず、項目名付きで拒否する。保存済みsnapshot/revisionの読取・復元は上限なしで維持する（[入力上限の仕様](../design/show_episode_input_limits.md)）。
- Feed全体には別の容量制限がある。公開後のEpisode一覧は最大10,000件・revision JSON合計2,000,000 Unicode code points（SQLite `length`相当、最大8MB換算）で、生成時の保守的32MB換算予算も検査する。追加・更新・復元で超える要求は公開書込前に`validation_failed`とし、後続jobを止めない。RSS公開の事前検証も同じ予算定義を使い、未確定revisionの付加fieldと公開URLを保守的に見積もる。Show非公開化はFeedを生成せず、Episode一覧を読み込まない。
- upload sourceは最終bytesを転送する前にEOFまで確認する。HTTP 200だけでは成功にせず、receiptと全量readback検証を維持する（[Issue #30の調査・修正](../design/archive/cli_upload_source_completion.md)）。
- 初回Episodeにはmetadataと音源が両方必要。その後はmetadata-only/audio-onlyが可能。
- `publish-*`は要求をローカルへ凍結してDOへ送信し、完了を最大300回・新規poll開始5分まで待つ。
- `schedule-*`はstage済みdraftをfuture UTCへ凍結し、`scheduled`を受付として返して終了する。予約はFIFOを先に占有せず、到来時に既存jobとして投入される。`schedule-status`の`state`と`publication_state`を分け、`dispatched`や`queued`を公開成功と扱わない。Pause／受付停止／保守／runtime・base変更後は`needs_approval`となり、`schedule-reapprove`なしに実行しない。予約は`published_at`を変更しない。
- `accepted/queued`は公開成功ではない。`succeeded`は保存・purge・SQL完了記録が成功した**その操作**の結果。
- 公開済みShowへの新規Episode追加中は、確定済みの旧Feedと承認済みcover/audioを読み取れる。新Feedは別のprivate R2 objectへ保存し、必要なpurgeとSQL完了後に切り替える。公開URLは変わらず、未完了の新音源は直リンクでも配信しない。世代別Feedは蓄積し、自動削除しない。
- 既存Episodeのmetadata-only/audio-only/同時更新中も旧Feedと承認済み旧音源を読み取れる。開始時のbase revision・lifecycle世代を照合し、新音源承認とFeedの切替は必要なpurge後の同一transactionで確定する。通常更新後も旧MP3を保持する。metadata-onlyは同じ音源URLを利用する。
- 公開済みShowのmetadata/cover/同時更新中も旧Feed・旧画像・承認済み音源を読み取れる。`update-show`はmetadataと画像を組でstageするだけで、`publish-show`後の保存検証・purge成功まで公開内容は変わらない。coverもprivateな世代別objectへ保存し、Feed・metadata・画像参照を同時に切り替える。画像が同じでも新snapshotを保存し、旧画像は自動削除しない。公開済み画像の拡張子変更は拒否する。
- 公開cover URLは変わらない。切替をまたぐ別HTTP要求では、旧Feedの画像URLが新画像を返す場合がある。画像だけの編集ではFeed bytes/ETagは同じまま304になり得る。Show復元は保存済み画像世代を検証して再利用する。
- Show初回公開には旧Feedがない。非公開化・復元の実行中、Pause/readiness不一致/保守拘束は503のまま。隔離を確認できるblockedで旧内容を配信しても、後続FIFO停止・Resume/共有配備禁止・未知IO保全は変わらない。
- SQLite cache ownerはtag/prefixを1回のpurgeへまとめる。明確なrate-limit拒否だけは同じrunning実行内で12秒間隔・最大6 attemptsを行い、保存をやり直さない。未知応答・恒久拒否は停止する。この有限待機はblocked jobのretry/release機能ではない。
- 凍結後は素材を変更しない。次の編集では、既知の完了/確定入力失敗を確認・archiveして別draft IDに進む。

## 互換Worker更新

```sh
castloop show-pause my-show PAUSE_OPERATION_UUID
# Repeat show-pause for every other Show, each with a fresh UUID.
castloop service-status
# Confirm every Show is paused, drained and ready.
castloop deploy --operation-id UPDATE_UUID
castloop service-status
castloop show-resume my-show NEW_WINDOW_UUID
```

未完了job、blocked、未確認runtime、設定変更、別namespace、古いcontent schemaがある場合は配備へ進まない。
更新専用手順が制御DOで所属集合を固定し、各Showでpaused/drained確認とResume禁止の保守拘束を原子的に保存する。全Showの準備を確認するまで配備しない。各Showと制御DOで新versionのAlarm/R2/cache owner/purgeを再検証し、全件成功後に保守拘束を解く。各Showはpausedのままで、再開は個別に明示する。部分prepare/activation/probe/解除や応答不明は完了扱いせず、該当要求を再送しない。準備途中の失敗で既に拘束されたShowが残る場合も、自動解放・rollbackはしない。
R2 payloadの書換えやresource作成は行わない。キューがdrainedでも未登録uploadがないとは判断せず、物理削除の許可に使わない。

unknownな準備/配備/activationを再送しない。配備receiptと正確なsetup完了を読取確認できる場合だけ、次を使える。

```sh
castloop update-service-reconcile UPDATE_UUID
```

これはGETによる照合とローカル記録の確定だけで、未知deployの採用・再配備・probeの再実行・強制解放を行わない。
独自ドメインや設定変更、schema変換はこの更新コマンドの対象外。

RESTの配備成功直後でも、DOがしばらく旧versionで応答する場合がある。
CLIは一致するprepared状態の旧versionだけを有限回GETで観測し、記録済み新versionになるまでactivationしない。
v0.5.2のCLIでは、この待機や配備成功後のREST GET失敗で停止した場合、次で検証を続けられる。

```sh
castloop update-service-verify UPDATE_UUID
```

対象は`deploy_acknowledged`（PUT成功応答を保存済み）、`deployed`（配備ID/versionも保存済み）、`verified`（REST照合済み）のみ。
これは読み取り専用ではない。凍結source/config/metadata、成功応答のETag、単一100%配備、version、namespace、正確なサーバー側prepared状態を再照合し、新native versionで**初回activation/probeだけ**を行う。
配備・準備・R2 uploadは繰り返さない。検証のGETが再び失敗してもcheckpointを保持する。
`prepare_requested`/`deploy_requested`の未知応答や`activation_requested`には使えず、完了後はpausedのまま。

新規のSQLite更新journalはformat `schema_version=2`で、PUT成功を最初のGETより前に永続保存する。更新固有のコメントを送信sourceへ加え、そのsource hashと応答ETagを束縛する。
同じ組み込みcodeの別更新でもETagを区別するためで、Workerの動作・service config・metadataの変更ではない。
旧SQLite journalの`deployed`/`verified`は元のsource hash/receiptのまま検証できるが、receiptのない旧`deploy_requested`を推測で昇格しない。
このjournal format、serviceのschema version 2、旧Queue更新journalのversion 2は別の概念であり、Queue/R2の旧upload-only journalを復旧する修正ではない。
設計・互換性・検証範囲は[SQLite更新復帰の契約](../design/sqlite_worker_update_recovery.md)を参照。v0.5.1配布済みCLIの続行対象は`verified`だけで、v0.5.2は`deploy_acknowledged`／`deployed`／`verified`を対象に加える。

## ローカルRSS取り込みの公開

既存の`import-rss`で作ったローカル取り込みをレビューした後、サービスrootで実行する。

```sh
castloop publish-rss-import ./reviewed-import
```

既存/削除済みShowを採用せず、新しいShowを作成し、そのShowだけを明示的にResumeして順次公開する。`publish-rss-import`はこの新Showの作成・再開・公開を含む操作であり、他Showを再開しない。初期化・再開の開始をjournalへ保存し、未知応答なら再実行せず停止する。元のGUID・permalink属性・公開日時を保持し、音源は新しいサービスへ保存する。
途中のEpisodeも完了ごとに公開され、全件一括の原子公開ではない。最後にpublic feedのmetadata・件数・identity・内部音源URLを照合する。
subscriber移行や旧ホスト撤去の完了を意味しない。

再実行は完了済みの公開を繰り返さない。保存済みpublication jobがある公開途中停止は、**そのjob IDのstatusを読むだけ**で照合・待機する。
v0.7.0の新形式では、PUT成功を保存済みのuploadは検証・下書き登録から続行できる。登録・ローカル配置も完了記録と保存内容が一致すれば結果を再利用する。未確認のupload/登録/ローカルinstallは自動再実行しない。[中断後の手順](sqlite_operation_recovery.md)を参照する。
公開前にstaged receiptをレビュー済みmetadata/cover/audioと照合し、事前検証後の素材差し替えも拒否する。

## 非公開化・復元

サービスrootで、例えば次のように操作する。

```sh
castloop preview-episode-lifecycle my-show first unpublish > plan.json
# Review the target, action and request_sha256 in plan.json.
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm
castloop job-status JOB_UUID
```

Show単位は`preview-show-lifecycle my-show unpublish`、復元は`restore`を指定する。
previewは読取だけ。`lifecycle-execute`の`queued`は完了ではなく、同じjobの`succeeded`まで確認する。
非公開化は全revisionの直リンクを止め、Episodeだけの場合はfeedからも除外する。payloadは削除しないため、ストレージ使用量は減らない。
Show停止は子Episodeの状態を上書きしない。Show復元でも個別停止Episodeは復活しない。
復元はGUID・日時・音源URL・revisionを変えず、未公開のローカル編集も取り込まない。
Episodeの停止/復元世代を照合するため、一度停止・復元を挟んだ古いdraftが同じrevisionを根拠に公開されることはない。

## 異常時

既存Episode更新のblockedも、開始時の確定Feed/Show世代・要求hash・公開中の対象revision/lifecycle世代が一致し、旧content/mediaの検証済みflagと許可reasonが成立する場合だけ旧内容を配信する。以下の「新規追加のみ」の制限をこの条件で拡張する。job・後続FIFO停止、Resume/共有更新拒否、未知IO保全は変えない。

```sh
castloop job-status JOB_UUID
castloop service-status
```

応答不明でもPUT/POSTを自動再送せず、同じupload keyや別jobへ置換しない。
管理APIの読み取りGETは、一時的な通信・本文読取エラー、408/429/500/502/503/504だけを**初回を含め最大3試行**する。
1試行は最大10秒、試行開始の総予算は30秒で、待機は通常250ms→500ms。`Retry-After`が長い場合は予算内だけ尊重する。
開始済みIOと応答cleanupの終了を待ち、時間切れだけで旧IOを切り離して次を始めない。
401/403等の恒久拒否、JSON/schema・identity不一致、不正header、サイズ超過、cleanup失敗は再試行しない。
公開完了待機では、再試行も既存の最大300 GETに数え、5分を過ぎて新しいGETを開始しない。進行中のGETには別のtimeoutがある。
これはstatus/health等の読み直しであり、公開・登録・pause/resume・配備のPOST、素材PUT、POST形式の一覧要求を再送する機能ではない。
再試行診断は固定reason・HTTP status・回数・経過時間・対象URLのhashのみで、鍵・URL・本文や任意例外文は出さない。

cache purgeの未確認結果は再送せず、診断の`failure_kind`でAPI例外（`call_threw`）と不正な成功応答（`invalid_acknowledgement`）を区別する。例外文は記録せず、`exception_kind`の固定分類だけを残す。不正応答は`result_kind`と`success_kind`に型だけを記録し、本文・任意のfieldは記録しない。分類が`internal_error`でも、purge未実行や再送の安全性を意味しない。

初期化/更新probeの失敗ログ`sqlite_runtime_setup / runtime_probe_failed`には、`probe_stage`（`target`、`admission`、`config_read`、`config_validate`、`cache_describe`、`cache_validate`、`cache_purge`、`commit`）とservice ID・実行Worker version・config hash・操作IDを記録する。再発時は秘密鍵を共有せず、次を読み取りで保全する。

1. 同じ操作のローカルjournal、`service-status`と対象Showの`show-status`。blockedや未確認要求は再送しない。
2. 発生区間・対象Worker/versionに絞った保存ログ。`sqlite_runtime_setup`の操作IDと`probe_stage`を確認する。
3. `cache_purge`段階なら近接する`sqlite_cache_purge`の対象Show・reason・attempt・will_retry・failure/exception/型分類を確認する。probe用Show IDは`probe-`＋操作IDの先頭8文字。platformのDO ID・trace/span・時刻も併せて照合し、先頭8文字だけで要求を同一視しない。

任意例外文・stack・応答本文・秘密値をログへ追加しない。保存ログの欠測や分類`other`なら原因未確定として扱う。この追加診断は、変更を含むCLI/Workerを次に配備してから有効になる。

ローカル実機試験用の観測guardは、runtime outcomeが`ok`でもHTTP 4xx/5xx、現行管理APIの固定エラーevent、failed/blocked操作、未認識ログを失敗として後続mutationを止める。任意ログ原文は保持しない。期待する404等の負の試験をguardの正常系へ混ぜない。これは将来の試験の停止基準であり、過去の実機記録を再分類した結果ではない。

既に凍結した`publish-*`を再度呼んだ場合も、同じ要求のstatus確認だけを行う。
`failed`は公開書込前の確定的な入力/base失敗、`blocked`は途中停止・書込不明・purge失敗等であり、同Showの後続を停止する。新規Episode追加で開始時に保存した確定世代・要求hash・対象未登録の保護根拠が成立する場合だけ、blocked後も旧Feedと承認済みcover/audioの読取を継続する。要求破損・根拠不一致・その他のblockedは503。Feedが読めてもjobの成功・復旧・drainedを意味しないので、管理statusで異常を確認する。別Showの通常操作・再開・登録は妨げないが、共有Worker更新はdrainできないため拒否する。
時間経過やHEAD不在で解除しない。blockedのretry/releaseは提供していない。

初期化では、R2/Worker作成・PUT・配備・公開設定の各要求前にjournalを保存する。
途中停止後の`init`はmutationを繰り返さない。
`init-reconcile INIT_UUID`は、配備receiptと正確なsetup identityが保存され、
**サーバーで既にready/paused/drainedの完了を読取確認できる場合だけ**ローカル記録を確定する。
未知deployの探索・採用・再配備や強制掃除を行うコマンドではない。

配備とworkers.dev有効化が応答確認済みで、REST検証だけが停止し、setupをまだ送っていない場合は、次の明示操作で検証と初回setupだけを続けられる。

```sh
castloop init-continue-verification INIT_UUID
```

対象は元journalの`access_enabled`/`verified`だけ。凍結source/config/metadata hashが一致し、native setupが存在せずpaused/drainedの場合に限定する。
resource作成・設定PUT・配備・access変更は再送しない。`setup_requested`やblockedのprobeを再試行するコマンドでもない。

公開済みShow/Episodeの物理削除と、未登録uploadの一般的な整理は未実装。v0.7.0の削除機能は、サーバーに登録した一意のstaging keyでPUT成功と未使用を確認できる素材に限定する。空のキューを根拠にbucketやprefixを削除しない。

## 検証の限界

Episode更新の[2026-10-21小規模実機確認](../design/archive/episode_update_feed_live_verification_20261021.md)では、新規隔離環境の1 Show・2短尺Episodeでmetadata-only/audio-only/同時更新に成功した。前後ともrunningの16取得組で旧Feed200/304・候補音源404、完了後の切替・旧新音源hashと最終Pauseを確認した。nativeのblocked故障注入・再配送・CPU/負荷は未試験。旧形式の保持環境は変更していない。

Issue #50の[2026-10-21小規模実機確認](../design/archive/episode_add_feed_live_verification_20261021.md)では、世代別Feed方式の新規隔離環境で1 Show・2短尺Episodeの正常公開、追加中の旧Feed200/304・未公開音源404（前後ともrunningの16取得組）、成功後の新Feed切替、世代別snapshot保持、音源hash/HEAD/Range/304、最終Pauseを確認した。環境はready/paused/drainedで保持している。blocked時の継続配信は故障注入しておらず、ローカル回帰と区別する。負荷・CPUや完全なcache hit/missの実証ではない。

ローカルではBun SQLite、模擬R2/Cache/Cloudflare REST、実CLI entrypointの独立processによるwalkthroughを用いる。Show分割版の[初回実機試行](../design/archive/do_show_separation_live_verification_20261020.md)は初期化のcache purge確認でblockedとなったが、[新規環境再試験](../design/archive/do_show_separation_live_retest_20261021.md)で2 Show・6 Episodeの公開、個別Pause/Resume、feed/cover/audio配信とSHA-256・HEAD・Range・304を確認した。[2026-10-21のcode-only更新](../design/archive/do_show_separation_worker_update_live_20261021.md)もnative反映待ちから正式verifyで再配備せず続行し、全DOのprobe・保守解除・既存データ保持・個別Resume・更新後公開を確認した。最後は両Showをpaused/ready/drainedにした。初回purge障害の根本原因、native同時IO性能・300MBは未確認。以下の過去の実機結果を新layoutの証拠へ流用しない。
Worker/DO classは実platform型で型検査・browser bundle化し、Linux単体CLIにはSQLite Workerだけを埋め込む。v0.6.0整理後は[新規隔離環境](../design/archive/schema_v1_removal_live_test.md)で短尺3件＋通常音源36件の公開・全音源hash/Range/304・lifecycle・Worker更新後の保持を確認した。保存ログの追加照会では通常Workerの外側/cache HTTP最大3/5msを確認したが、全invocation回収や将来負荷を保証しない。
**模擬storageのtransaction/AlarmとCloudflare実機のoutput gate・再配送、模擬purgeと実Workers Cache purgeは区別する。**
小容量・36件公開・正式RSS・互換更新の実機機能確認は通過した。最新継続試験は公開probe 60/60と通常HTTP/cache/DO/Alarmの各区分の数値CPUを取得したが、platform上の全invocation回収の証明ではない。
新経路の300MB実機公開と実機purge rate-limit retryは未確認。Issue #13恒久解消と、未試験経路・将来負荷を含む全Free適合は保証しない。
