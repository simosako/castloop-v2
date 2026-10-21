# Issue #48: DOをShow単位で分離する検討

更新日: 2026-10-20。Issue #48への採用設計。**Show単位DO、Show単位Pause/Resume、全体Pauseの廃止、旧版互換・移行不要、および実装・ローカル検証は管理者承認済み。Cloudflareへの配備・資源変更・既存環境の削除は対象外。** v0.6.2の旧構成とは区別する。

実装・ローカル検証は完了。結果と未確認範囲は[検証記録](archive/do_show_separation_verification.md)を参照する。[初回の実機試行](archive/do_show_separation_live_verification_20261020.md)は初期化probeで停止したが、診断改善後の[新規環境再試験](archive/do_show_separation_live_retest_20261021.md)で2 Show・6 Episodeの公開、個別Pause/Resume、配信確認に成功した。[2026-10-21の共有Worker更新](archive/do_show_separation_worker_update_live_20261021.md)も、native反映待ちの明示verifyを経て全DOのprobe・解除・データ保持・更新後公開を確認した。初回purge障害の根本原因とnative同時IO性能は未確認。

## 1. 結論

- Issueの「基本的には複数のShowにまたがった操作というのは無い」という認識は、**コンテンツの業務操作について基本的に妥当**である。公開・更新・非公開化・復元はShow内で完結し、複数Showを一括して原子的に変更する業務操作はない。
- Worker更新、一覧等のサービス共通機能は存在するが、通常のPause/Resumeと受付windowはShow単位とする。サービス全体のopen/pausedという運用状態は設けない。
- **Show単位DO＋小さいサービス制御DO（案C）を採用する。** Show内の公開・操作記録を同じトランザクションに保つ。全Showの停止は個別Pauseの組み合わせであり、全体Resumeは作らない。
- 1 DO内のShow単位隔離（案B）は代替候補とし、Cの前に必ず実装する段階とはしない。Bにも配信判定・Alarm予約・登録条件等の変更が必要であり、「索引変更だけで安全」「主要リスクをすべて解消」とは評価しない。
- **まだ本番活用していないため、旧版の維持・互換対応・マイグレーション機能は不要**とする。新layoutだけを扱う構成を設計し、2 layout併存や旧版サポートの費用を採否判断に含めない。既存の試験環境・データ・証跡の保全は、旧版の製品サポートとは区別する。

旧稿の「Issueの前提は誤り」「案Bを先行採用し、DO分割は却下」という評価は、本稿で置き換える。GitHubへ既に投稿された旧評価は本ファイルの更新では変わらず、本稿を最新の検討内容とする。

## 2. 変更前のv0.6.2と、分離する責務

変更前のv0.6.2は1サービスにつき1 SQLite-backed Durable Objectで、DO名は `service/<service_id>` 固定だった。以下は分割の理由を示す旧構成の整理であり、新構成は6節を参照する。

| 対象 | 現状 | 分離の観点 |
| --- | --- | --- |
| content index | Show/Episode/本文/mediaを `show_id` で識別（`src/sqlite-publication-content.ts`） | Show内の参照・世代・GUID一意性をShow DO内で完結させる |
| 公開payloadとstaging | `public/podcasts/<showId>/...`、`staging/uploads/<showId>/...` | 既存のShow別キー構造を活用できる。分割を理由にpayloadを移動しない |
| 公開queue | `publication_one_active` がサービス全体でrunning/blockedを1件に制限 | これは現実装の結合であり、業務上のShow横断要件ではない |
| 配信 | public pathはShow別。ただし `delivery()` は全Showのactiveから先頭1行だけを読む | 対象Showだけの判定へ変更が必要。複数activeを許して現行SQLを流用してはならない |
| キャッシュ無効化 | `invalidate({showId})`、必要に応じてEpisodeも指定 | 対象はShow別。ただしpurgeのアカウント共通制限は残る |
| 操作記録 | `operations` は `show_id` を持ち、関連5表が同じDO内にある | Showの公開受付・状態変更と操作記録の原子的な更新を維持する |

論理的なShow識別が済んでいることは分割の足掛かりであり、DO境界での分離が不要な証拠ではない。一方、DO分割で共有Worker・R2 bucket・サービス制御・アカウント上限まで独立するわけでもない。

## 3. 業務操作、共通管理、実装上の結合を区別する

| 区分 | 対象 | 評価・設計課題 |
| --- | --- | --- |
| Show内の業務操作 | Show/Episodeの公開・更新・非公開化・復元、素材管理と操作の再開・取消 | 同じShowのqueue、content、操作記録を同じDOに置くのが自然。Show間の原子的な一括変更は不要 |
| Show内の運用管理 | pause/resume、受付window、runtime/config identity | 対象Show DO内で受付と閉鎖を原子的に判断する。通常操作ではサービス共通の受付許可を取得しない |
| サービス共通管理 | Worker更新、prepare→activation→probe、drain | 共有Workerの更新である以上、対象Show集合を確定した集約・部分失敗・中断続行が必要 |
| サービス共通の照会 | Show一覧、サービスstatus | registryとShow別状態の取得方法を設計する。すべての照会に全Showへのfan-outが必須とは限らない |
| サービス共通の照会 | 全Showのoperation-list、Show指定なしのoperation-status | Show別の正本と、横断検索・operation IDの経路解決を分ける。旧CLI/APIの互換維持は要求せず、新CLI/APIの仕様を決める |
| Show内の配信条件 | Showのopen/paused、readiness | 対象Showの最新判定を毎回確認する。サービス全体のPause gateやそのTTL cacheは設けない |
| 実装上の結合 | サービス全体のactive排他・blocked停止 | 現行設計が選んだ停止範囲であり、分割を否定する業務要件ではない |
| 実装上の結合 | Show登録時に全Showのqueued/running/blockedが0であることを要求 | この条件を撤去する。永久予約と共有更新中の所属集合固定だけを制御DOで守る |

**サービス共通管理があることは、Show分割後の設計課題を示すが、Issueの前提の反証にはならない。** 不変条件と、現在それを実現している単一DOという手段を区別する。

## 4. 証拠が示すこと・示さないこと

### 4.1 blockedによる停止

2026-10-16の隔離試験 `sq16-668cbdfa` では、36 Episode中14件が成功し、15件目が `blocked / execution_failed` となった。serviceはopenだが `active=blocked / drained=false` となり、後続公開・互換配備へ進めなくなった（[測定記録](archive/sqlite_sequential_measurement_20261016.md)）。失敗はpurge段階まで絞られたが、rate limitかRPC障害かは確定していない。

これはblockedによる公開・更新停止の実測である。ただし、**別Showの公開要求も投入して停止を確認した横断障害試験ではない**。他Showへの新規公開拒否、全体のdrain未完了、Show登録拒否は現行コードから確認できる性質として区別する。別Showの既存配信は、serviceがopenなら現行でも継続できる。

blockedのretry/releaseは未提供である。分割も案Bも、当該Showの未知IOを解放する仕組みではない。また、既にblockedの既存環境へは現行のcode-only更新経路で配備できず、本検討を復旧手順として使えない。

### 4.2 公開時間と並列化

現行は1 Alarm invocationにつき1 jobで、サービス全体で直列実行する。1 Show＋36 Episodeの初回公開は242.398秒だった（[先行測定](archive/sqlite_sequential_measurement_20261016.md)）。別の継続試験では次の値を取得した。

| 対象 | 中央値 | 最大 |
| --- | ---: | ---: |
| Episode create＋metadata/audio upload＋publish（22件） | 6.259秒 | 7.667秒 |
| publishコマンドのみ（22件） | 2.467秒 | 2.655秒 |
| DO AlarmのCPU（32 invocation） | - | 11ms |
| DO HTTPのCPU（282 invocation） | - | 19ms |

出典：[36件規模の再試験・CPU測定](archive/sqlite_size36_measurement_20261017.md)。CPU最大値は収録したinvocationの値であり、job全体のCPUではない。

- CPUが小さくても、R2やpurgeのIO待ちの間は逐次実行枠を占有する。CPUとwall timeを比較して「DO側はボトルネックでない」と断定しない。
- 単一CLIが逐次公開する負荷では、分割だけで処理が自動的に並列化されるわけではない。一方、複数Showからの同時要求で競合待ちがどれだけ減るかは未測定である。
- Show数だけから待ち時間が比例すると断定しない。要求の到着頻度、同時実行数、IO時間、purge制限を含めて比較する。共有purge制限が並列化で悪化する可能性も評価する。

### 4.3 容量と共通の障害範囲

Workers Freeの容量計画はDOあたり1GB、アカウント合計5GBを前提とする（[公式上限](https://developers.cloudflare.com/durable-objects/platform/limits/)のFree向けFAQ）。現行は全Showのcontent・queue・操作記録が1 DBに蓄積する。

Show分割は1 DBの容量到達やShow固有の実行状態の影響範囲を小さくできる。ただしアカウント合計枠は増えず、サービス制御DOの障害や共通のWorker不具合はサービス全体に影響し得る。容量到達については、SQLiteの読取まで必ず停止するという意味ではなく、書込失敗の範囲を問題とする。

## 5. 選択肢の再比較

| 案 | 内容 | 便益 | 残る課題・費用 | 評価 |
| --- | --- | --- | --- | --- |
| A 現状維持 | 1 DO/サービス、全体FIFO | 変更不要。現在の安全契約を維持 | Show固有のblockedが他Showの公開・登録と共有更新を止める。DB容量・実行枠も共有 | 検討中の現行baseline。恒久解としては推奨しない |
| B 1 DO内のShow単位隔離 | Show別に停止範囲を分け、実行は全体で一件ずつ | 別Showの既存公開処理を継続できる。DO間の受付調停は不要 | 配信・Alarm・状態集約・登録条件も要変更。DBと実行枠は共有。全体resume・更新停止は残る | 代替候補。Cに先行する必須段階とはしない |
| B' 1 DO内のShow間並列実行 | Bに加えて別ShowのIOを並行実行 | IO待ちの重なりを利用できる可能性 | 同一Alarm内の部分失敗・全IOのsettlement・再起動判定・wall/CPUを管理する必要。DB容量は共有 | Cと別の複雑さがある。優先しない |
| C Show単位DO＋サービス制御DO | Showのqueue/content/操作記録/Pauseと、所属・共有更新を分担 | 業務境界に沿った状態・Alarm・DB容量の分離。Show間の並列実行が可能 | 共有更新、登録途中状態、一覧、経路解決を扱う。旧版互換・移行は対象外 | **採用。実装・ローカル検証へ進む** |

「Cの設計が未完成ならBで足りる」とは判断しない。未完成なのは採用前に解く課題であり、代替案が要求を満たす証拠にはならない。Bを先に実装してからCへ進むと、queueと配信の変更・検証を二度行う費用もある。

## 6. 採用した案Cの実装契約

### 6.1 状態の正本を責務ごとに分ける

同じ `SqlitePublicationService` class/namespace/bindingを使い、制御DOを `service/<service_id>`、Show DOを `show/<service_id>/<show_id>` で識別する。cache owner名・compatibility dateは維持する。新サービス設定には必須の `storage_layout = "show-v1"` を追加し、旧設定はIO・ローカル書込前に拒否する。旧DOの内容を変換・採用しない。

| 正本 | 持つ責務 | 持たせない責務 |
| --- | --- | --- |
| サービス制御DO | service identityと初期probe、Show IDの永久予約・所属registry、共有更新の進行と対象集合 | 通常の受付window・Pause状態、Showの公開状態・job結果・操作記録を重複管理しない |
| Show DO | Pause/Resumeと受付window、Show/Episodeのcontent・lifecycle・世代、不変media index、Show内FIFOとAlarm、操作・要求・素材・履歴 | 他Showの状態を通常操作の許可条件にしない。共有更新の保守拘束中や未確認runtimeをready扱いしない |

registryが予約・所属の正本、Show DOが公開状態の正本であれば、異なる責務の分担であり、それ自体は正本の二重化ではない。ただし、登録途中・応答喪失・registryだけ作成済み等の状態を隠してはならない。登録identityを凍結し、永久予約を保全して、未知の作成・登録を再送せず読取照合できる設計が必要である。

横断検索用の情報を複製する場合は、検索用projectionと明記する。再開・取消・公開・削除の可否は対象Show DOの最新状態で判断し、古い一覧やprojectionを実行権限の根拠にしない。

### 6.2 通常受付と共有更新を分離する

- 同一Show内の受付、素材参照の検証、操作記録、Alarm予約は同じShow DOのトランザクションに置く。Show間の全体FIFOは要求しない。
- Pauseと受付は同じShow DO内で原子的に判断する。サービス共通open確認や、DO間の受付許可tokenは不要とする。
- 更新準備は各Show DOでpaused/drainedを確認し、更新準備記録とResume禁止の保守拘束を原子的に保存する。確認と拘束の間にResumeできる別マーカー方式にはしない。
- Show登録は制御DOで永久予約と初回送信前の記録を保存する。別Showのblockedを確認しない。登録途中・応答不明があれば共有更新の準備を拒否する。
- 登録先のShow identityと予約IDを固定し、未知の初期化要求を再送しない。新ShowはpausedでSQL/Alarm/R2/cacheのprobeを行い、明示Resumeを待つ。

### 6.3 配信とキャッシュ

2026-10-21第3段階追補: [Show更新の継続配信契約](show_update_feed_availability_plan.md)も実装した。以下のEpisode専用の例外を公開済みShowのmetadata/cover更新へ広げ、Feed/Show/coverと対象種別のguardを照合する。Show更新は旧coverのR2 identity検証後にverifiedを保存する。不変coverを別keyへ準備し、metadata/cover/Feedはpurge後の同一transactionで確定する。公開cover URLは固定し、遅い単一要求は許可世代へ固定するが、別要求間のsnapshot一致は保証しない。queue/content schema **5/6**、`cover_storage="immutable-generation-v1"`と`publication_read_boundary="show-episode-v1"`を必須とする。旧形式の移行・互換配備はなく、Show停止・保守拘束・後続FIFO停止とShow間分離は維持する。

2026-10-21追加追補: [Episode更新の継続配信契約](episode_update_feed_availability_plan.md)を実装し、以下の追加専用条件を既存Episodeのmetadata/audio更新にも広げる。更新では公開中の対象revisionとlifecycle世代が開始時のguardに一致することを必須とする。新音源の承認とFeed切替はpurge後の同じtransactionで確定し、旧音源は保持する。新規環境専用のqueue/content schema 4/5と必須health識別を使い、旧形式を変換しない。

gatewayはpublic pathから対象Showを決め、要求ごとにそのShow DOの最新判定だけを確認する。制御DOへの毎回の配信照会や、状態のTTL cacheは設けない。Show DOがpaused、未ready、共有更新の保守拘束中なら503とする。Pauseは従来の安全側の意味をShow単位へ移し、新規受付と配信を閉じる。既受付jobは取り消さずdrainを続ける。

Issue #50では[Feed継続配信契約](episode_add_feed_availability_plan.md)に従い、新規Episode追加のrunning/blockedだけ、開始時に保存した確定Feed/Show世代・要求hash・対象Episode未登録の根拠が成立すれば旧Feedと承認済みcover/audioを配信する。それ以外のrunning/blockedは503、別Show固有のblockedだけでは配信拒否しない。全Feedは世代別の不変R2 snapshotへ保存し、読取先もcache propsと同世代に固定する。R2 streamingと承認済みpublic path、必要なpurge成功後の公開完了は維持する。音源本体をDO経由で中継しない。

通常配信の判定は1 Show DOへの要求であり、制御DOの障害を毎回の配信依存にしない。共有Worker/R2/cache/アカウント上限の共通障害範囲は残る。

### 6.4 Show単位Pause/Resumeと共有Worker更新

**全体Pause/Resumeは廃止する。** `show-status SHOW`、`show-pause SHOW OPERATION_UUID`、`show-resume SHOW NEW_WINDOW_UUID`を提供する。サービスstatusの全Show停止・drain表示は照会時の集約であり、通常操作を許可する全体状態ではない。

| 操作・状態 | 採用仕様 |
| --- | --- |
| Aだけblocked/paused | Aの後続公開を止める。pausedなら配信も停止。blockedの配信は§6.3の保護条件に従う。Bの通常操作・配信・独立Resume、新Show登録は継続できる |
| AとBを個別Pause | 両Showの新規受付・配信が止まる。新Show登録まで止める意味ではなく、永続的な全体Pause状態も作らない |
| BだけResume | Bがpaused/drained/readyで保守拘束がなく、新しいwindowなら可能。Aのblockedは参照しない |
| 共有Worker更新 | 専用の更新手順で所属集合を固定し、各Showをpaused/drainedで保守拘束する。blockedや登録途中があれば配備しない |

共有更新は新layout導入後の通常更新を指す。制御DOへ対象集合と凍結要求を保存して登録を閉鎖し、Showごとに送信開始を永続記録してからprepareする。全Showの正確な準備を確認するまでCLIへ配備可能な結果を返さない。prepare中のResume競合はShow側の原子的な拘束で拒否する。

配備後は更新statusのGETで全対象Showのnative version・正確なprepared状態・保守拘束も照合する。制御DOだけが新versionになっていても`targets_native_ready=false`として有限観測を続け、全対象が確認できるまでactivationを送らない。未確認のまま停止した場合、既知配備のverifyから読取を明示続行できるが、配備・prepareを再送しない。

同じ対象・旧/new runtime・config/namespace・operationに束縛してactivationする。サーバーも全対象のnative確認を行ってから、共有activationの開始を原子的に保存する。Show別activation/probeの部分成功を全体完了にせず、全Showと制御DOのprobe成功後に保守拘束を解く。送信開始済みで結果不明のprepare/activation/解除は再送しない。中断記録を保持し、自動rollback・時間切れ解放はしない。

blocked retry/releaseやShow別Worker versionは追加しない。Aのblockedは共有更新を妨げるが、更新準備を始めていない通常運用でBのPause/Resumeを妨げない。

### 6.5 一覧・operation IDの経路解決

- Show一覧はregistryのShow ID順にkeyset paginationし、対象ページのShowからtitle・lifecycle・未完了状態を照会して20件ずつ返す。cursorはruntime/configと条件へ束縛する。登録途中・照会失敗を「存在しない」として落とさない。検索projectionは作らない。
- remoteのoperation-list/status/resume/cancel/cleanupは`--show SHOW_ID`を必須とする。全Showのoperation集約・operation IDの横断索引は作らない。ローカル診断は引き続きサービスworkspace内の記録を読むだけでよい。
- `job-status`と保存済みlifecycle要求はjournalに凍結したShowへ到達する。既存の小さい管理URLを使い、`X-Castloop-Show-Id`でgatewayとShow DOの双方が経路を照合する。操作要求journalにもShow経路を固定し、別Showへ再利用しない。
- 公開状態と操作記録は同じShow DO内で原子的に更新する。登録と配信は全Showへのfan-outを必要とせず、`service-status`だけが全所属Showを集約する。この集約は非原子的な照会であり、共有更新の保守拘束を代替しない。

### 6.6 費用と検証

DO数そのものはFreeでも無制限だが、要求10万回/日、duration 13,000 GB-s/日、SQL読取500万行/日・書込10万行/日、アカウント保存容量5GBは共通枠である（[料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。durationはCPU時間ではなく、DOがactiveなwall time等に基づく。

通常の公開受付・素材操作・Show Pause/Resume・公開配信は対象Show DOだけへ到達する。Show登録は制御DOの予約と対象Showの初期化/probe、Show一覧は制御DO＋対象ページのShow照会、service-statusは制御DO＋全Show照会、共有更新は固定集合へのprepare/activation/probe確認/保守解除となる。SQL行数・active時間と実機遅延は未測定。空DB約12KBはアプリのテーブル・索引を作成した後の固定費ではない。

模擬テストでは独立した複数storageとAlarmを使い、DO間の遅延・応答喪失・部分成功・再起動を注入する。少なくとも次を受け入れ条件にする。

1. AがblockedでもBの公開・更新・配信と新Show登録が進む。両Showを個別Pauseした後もBだけResumeできる。
2. 同一ShowのFIFO、同一IDの要求凍結、base/世代/ownerの照合、操作記録と公開状態の原子性を維持する。
3. ShowのPause・受付を同じDOで直列化する。登録・共有更新・Resumeの競合で未確定要求や対象を取りこぼさない。未知応答を自動再送しない。
4. pausedでもqueued/running/blockedをdrained扱いしない。共有更新の部分prepare/activation/probe、未確認解除、旧runtimeは完了扱いしない。
5. 複数Showの同時IOでも開始済みIOのsettlementを守り、必要なpurge成功前に公開完了・途中payloadの配信をしない。
6. 一覧・operation参照の経路解決失敗を、成功・不存在・取消可能へ誤って変換しない。

ローカル試験はCloudflare nativeのoutput gate・Alarm再配送・性能の実証とは区別する。実機測定は対象・範囲の別承認後とする。

実装のローカル検証構成・故障注入ケースと限界は[検証記録](archive/do_show_separation_verification.md)にまとめる。

## 7. 不採用の案Bについての比較メモ

Bは「索引をShow別に変えてclaim/enqueueを調整するだけ」の軽微な変更ではない。少なくとも次を設計・検証する。

1. **排他とschema**: Showごとのrunning/blocked制約に加え、Bでは実行中jobはサービス全体で一件という条件も維持する。索引変更は永続schemaの変更として評価し、「行が同じだからcode-only互換」とは扱わない。新規環境のschemaとして定義し、旧schemaへの互換導入・変換は設計しない。
2. **選択・予約・失敗遷移**: `claim()` と `schedule()` が同じ実行可能条件を使う。成功・確定失敗だけでなく、`block()`、残存runningの中断検出、`claim()`内の要求破損後にも、別Showの次回起動を耐久予約する。起動予約の失敗、再起動、全Showがblockedのときの空回りも検証する。
3. **配信**: 現行 `delivery()` は全体activeの先頭1行しか見ない。Aがblocked、Bがrunningまたはblockedのとき、双方を停止できるよう対象 `show_id` で存在確認する。「配信は変更不要」という旧評価を撤回する。
4. **状態集約**: `active()`、`snapshot()`、service health等の単一active前提を見直す。複数blockedとrunningを取りこぼさず、全体drainedはqueued/running/blockedがすべて0のときだけとする。旧APIへの互換維持を要求せず、新しいAPI表現を決める。
5. **Show登録**: 現行 `registerShow()` は全Showの未完了jobを数える。Bでも新Show登録の独立が必要であり、この全体停止条件を外し、登録と受付閉鎖・runtime更新との原子的な整合を検証する。別Showのblockedで登録が止まるままなら、確認済みの目標を満たさない。
6. **残る停止範囲**: DB容量と単一の実行枠は共有する。blockedのretry/releaseは追加せず、全体resume・コード更新のdrain条件も緩和しない。

回帰ではAの失敗前にBをqueue済みにする場合と、失敗後に新規受付する場合の両方を扱う。Bが起動することだけでなく、複数activeに対する配信停止、FIFO、Alarm予約失敗時のrollback、再生成時の非再実行を確認する。

## 8. 既存環境とリリース境界

**管理者確認済みの前提として、まだ本番活用していないため、旧版の維持・互換対応・マイグレーション機能は不要とする。** 旧版維持・互換併存・移行の三案比較は行わず、新layoutのみを扱う実装を設計する。

- 旧layoutを動かすためのrouting、互換DO型、旧schema読取、旧CLI/API互換層、旧journal変換を追加しない。旧版を継続サポートするための分岐やテストも新構成の要件にはしない。
- 既存サービスを新layoutへ移す機能、既存資源の採用、旧DBの変換・コピー、旧jobの新DOへの再登録は提供しない。新構成の検証は承認された新規環境で行う。
- サービス設定version 2とpublication protocol名は維持し、必須の`storage_layout="show-v1"`と完全config hashで識別する。省略・未知layoutは副作用前に拒否する。新layout内では既存のqueue/content/操作記録の表形式を再利用し、binding・registry・更新対象の小さい表を追加する。旧DOへ新codeを送り込んでから判別・変換する経路は作らない。
- 新layout導入後の通常のWorker更新と復旧は設計対象である。「旧版の移行不要」は、今後のすべてのコード更新で未完了状態・runtime照合を無視してよいという意味ではない。

この方針により、旧版の保守費や移行の難しさを理由にCを見送る必要はない。CとBの比較は、新構成そのものの安全性・複雑さ・利用量に絞る。

**旧版の製品サポートが不要なことと、既存資源・データを削除してよいことは別である。** 保持環境 `sq16r-6ec01dc6`、非テストDNS、共有証明書、ローカル原本・journal・私有証跡は本検討で変更しない。未知IOの解放、旧環境のcleanup・削除は対象・範囲の別承認を要する。

## 9. 今後の進め方

1. **採用仕様を実装する**: Show単位DO/Pause/Resumeと、所属・共有更新の制御DOを接続する。Bは比較の履歴であり先行実装しない。
2. **CLIと配備前検査を更新する**: 新layout必須、旧設定の副作用前拒否、対象Showへの管理要求、一覧・操作参照、通常更新を接続する。
3. **ローカル検証する**: 独立SQLite/Alarmの複数Showで正常・blocked・Pause/Resume・共有更新・未知応答を試験する。`bun test`、`npm run check`、CLI buildとローカルwalkthroughを行う。
4. **仕様と結果を更新する**: [全体設計](initial_design.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、更新・操作記録の関連契約を更新する。未確認の実機特性を明記する。
5. **実機確認は対象・範囲を別途承認する**: 単一Showの逐次負荷と複数Showの同時負荷を分け、競合待ち・IO wall・purge・配信遅延・DO利用量を測る。既存測定を新構成の性能証拠へ流用しない。

Issue #48は、**Showを業務上の自然な境界として採用し、通常運用と共有更新を分離する**。旧稿の却下方針やBの先行実装へは戻さない。

## 参照

- 設計: [全体設計](initial_design.md)、[SQLite逐次公開の実装計画](sqlite_sequential_publication_implementation_plan.md)、[Worker更新の復旧契約](sqlite_worker_update_recovery.md)、[操作記録の設計](sqlite_operation_records_schema.md)、[テスト責務監査](archive/sqlite_test_responsibility_audit.md)、[v0.6.0 Queue削除計画](schema_v1_removal_plan.md)
- 測定: [SQLite実機受け入れ・測定](archive/sqlite_sequential_measurement_20261016.md)、[36件規模の再試験・CPU測定](archive/sqlite_size36_measurement_20261017.md)
- 公式: [DOの上限](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DOの料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[DO SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
