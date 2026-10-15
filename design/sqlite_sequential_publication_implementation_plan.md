# DO SQLite逐次キューによる公開処理の実装計画

2026-10-16。管理者と合意した簡素化案を実装の基準とする。
計画保存と、それに基づく開発・ローカルテストの指示を受けた。その後、適切な区切りでcommitしながら実装を続ける指示を受けた。push、Cloudflare資源作成・配備、実機測定、既存データ移行は別承認とする。

## 1. 採用する基本形

```text
CLI: 一意のR2 keyへ素材をPUT
  → PUT成功・保存内容を確認
  → 明示的な公開要求をHTTP経由でDOへ登録
DO: SQLiteへ要求・受付順・状態を永続保存
  → Alarmが受付順に一件ずつ実行
  → 公開用ファイルの保存・feed更新・purgeをすべてawait
  → SQLiteへ完了を記録し、次のjobを起動
CLI: 同じjobの結果をpoll
```

- **1サービスにつき1つのSQLite-backed Durable Object**。実行はサービス全体で一件ずつ。
- Cloudflare Queues、DLQ、D1、Queue送信用outboxは新方式に導入しない。
- R2はファイル保存先。ロック、実行token、status/progressの正本には使わない。
- HTTPは小さい要求の転送と応答を担当し、業務処理はDO invocationへ置く。
- 公開用音源・revision履歴は引き続き不変。feed/current/coverの既存固定key更新は維持できる。全面的な世代別feed/coverと公開先ポインター方式を前提にしない。
- 不明な途中実行は停止・通知する。時間切れlease、旧tokenの奪取、未知PUTの自動再送、万能な自動復旧は作らない。

[保存先再検討書](control_plane_storage_reconsideration_20261016.md)のDO＋Queues/outbox案と、公開先ポインターを必須とした部分は、この計画では採用しない。
既存リリースや現在のCloudflare環境を、そのまま新方式へ切り替える指示ではない。

## 2. 素材アップロードとCLIの契約

### アップロード前のサーバーロックをなくす

CLIがローカルに未公開draftのjob IDを持ち、各PUTに暗号学的に一意なupload IDを採番する。
キーの例は`staging/uploads/<showId>/<draftJobId>/<uploadId>/episode.toml`。音源・画像も同様に分離する。
正確なkeyはasset種別と凍結identityから組み立て、任意の`system/`や公開keyを入力として受け付けない。
同じ未公開draft IDは維持するが、以前の素材objectを上書きして編集しない。

- `update-show`、`update-episode`、`update-episode-audio`は素材を保存してローカルmanifest/receiptを更新するだけ。公開しない。
- アップロード前にDOのstage-start許可を待たず、upload-completeをQueueへ送る方式もなくす。
- PUTが成功し、サイズ・全量hash・ETag等の既存確認を終えた素材だけをmanifestへ登録する。
- 音源は300,000,000 bytes上限、MP3/duration解析、既存の全量読戻しを維持する。失敗・結果不明のPUTは登録せず、同じキーへの自動再送もしない。
- metadata-only公開は既存の不変音源を参照し、MP3の再PUT/コピーをしない。
- 公開前にローカル素材とmanifestを照合し、古いstagingを黙って公開しない。submit前に要求body/hash/request IDをローカルjournalへ凍結する。
- 初回も更新も明示的な`publish-*`だけが公開jobを登録する。登録後はdraftと参照素材を凍結し、次の編集は新しいdraftへ行う。

アップロード成功後のR2読取は強整合であり、反映待ちの反復確認は行わない。
未確認PUTをenqueueしないので、そのPUTが後から完成しても未参照objectにとどまる。掃除は別操作で、自動期限を設けない。
R2 REST PUTのCASやクライアント切断時の取消保証を前提にしない。

## 3. 要求・受付・順序

新protocol名は`sqlite-sequential-v1`とする。旧`queue-management-v1`とは混ぜず、能力確認済みの新環境でだけ使う。
strict schemaでservice/対象/action/request ID/job ID、期待base revision、runtime/config/resume window、確認済み素材参照を束縛する。
管理要求を認証し、API token/管理秘密鍵/metadata本文をjob診断へコピーしない。

- SQLiteの単調増加sequenceが受付順。クライアント時刻やupload完了時刻から順序を推測しない。
- 同じrequest ID・同じbodyは同じjobを返す。同じID・異なるbody、同じjob IDへの別要求は拒否する。
- `accepted`は要求と起動予約の耐久保存を示すだけ。公開成功ではない。
- CLIのsubmit結果が不明なら、同じrequest IDのstatusを読んで照合する。自動再POST・新job置換・旧経路へのfallbackはしない。
- 複数jobは受付順に並べられるが、実行時に期待baseを再照合する。同じEpisodeを同じbaseから更新する後続jobはconflictにする。
- 無関係な別Episodeの先行公開だけで、全後続要求が一律staleにならないよう、対象baseとShow lifecycle/configの変更を区別する。

## 4. SQLiteとAlarmの責務

### 最小の永続状態

- service: identity、受付open/paused、runtime/config/window、active job。
- jobs: sequence、request/job identity、凍結要求/hash、状態、実行開始と結果、allowlist理由コード。
- Show/Episode: 永久identity、lifecycle、現在revision、不変音源参照とfeed生成に必要なcontent index。
- schema version: 対応しないversionを自動採用・破壊的再初期化しない。

statusとprogressを別ファイルへ保存して突き合わせない。本文等は公開コンテンツの保存領域と運用記録を分離し、deleteでcontentを消しても必要な小さいidentity記録は残す。

### 起動と逐次実行

1. 受付要求を検証し、SQLiteへのjob保存とAlarm予約をDO storageのtransaction内で行う。外部I/Oはtransactionへ入れない。
2. Alarmは最古のqueued job一件だけを取り、`running`を保存してから副作用を始める。
3. 入力・期待baseを検証し、公開runnerを実行する。開始済みのR2 I/O・purgeをすべてawaitする。
4. 成功結果とactive解除、次のAlarm予約を耐久保存する。一つのAlarmでキュー全件を回してwall上限へ近づけない。

`blockConcurrencyWhile`で長い処理を囲まない。Alarm実行中もstatus/受付要求を処理できるが、公開・更新の副作用はAlarm以外から開始しない。
同じDO内でも外部I/Oをawaitすると別要求が処理されるので、状態遷移は短いtransactionで行う。
DOの再起動やAlarmの再配送だけを理由に、残った`running`を再実行しない。

### 失敗を隠さない

| 状態・事象 | 扱い |
| --- | --- |
| queued | 受付済み・未実行 |
| running | 実行開始を耐久記録済み |
| succeeded | 全保存・purge・完了記録が成功 |
| failed | 副作用前の確定的な入力不正/base競合。要求は保持し、自動再実行しない |
| blocked | 実行中断、公開書込後の失敗、purge失敗、I/O結果不明。後続を開始しない |

副作用前の確定的失敗は、そのjobだけをfailedとして次へ進める。
それ以外は最初の段階では保守的にblockedとする。正常に処理中のjobを経過時間だけでblocked/解放しない。
再生成したDOで過去のrunningを発見した場合は中断を通知し、元の要求と状態を保持する。
blockの自動解除・再試行コマンド・途中状態の外部復旧は、この初期実装に追加しない。

Alarmsの標準retryは最大6回だが、それを公開副作用の自動再実行に使わない。
再配送が来てもblocked/runningを確認して止める。保存や起動予約自体の失敗・Free枠超過も成功応答へ変換しない。

## 5. 公開・配信・管理操作

- 公開runnerは「検証→必要な不変音源とrevision→current/feed/cover→purge→完了」の責務へ整理する。
- 現行R2 owner/manifest/progress helperをDO RPCへ一対一で置換しない。guard重複を引き継がない。
- schema検証、音源receipt/保存内容の照合、RSS生成、immutable media、cache処理を再利用する。参照素材の確認はjob開始時と必要な利用箇所へ限定する。
- feed等の複数R2 objectとSQLiteは分散transactionにならない。途中失敗では後続を止め、公開可否・feedと音源の整合性を回帰テストする。無停止・一括原子公開は約束しない。
- 固定keyへの途中書込みを配信しないため、実行中/blockedの対象Showは配信判定を503にする。別Showの配信は継続できる。SQLiteの小さいscalarだけで判定し、job本文やcontent metadataを配信ごとにparseしない。
- 配信の最新service/Show/Episode状態はDOの小さい読取で判定し、許可された既存public keyをWorkers Caching/R2から配信する。配信判定をTTL cacheしない。
- GET/HEAD/Range/304、承認済みrevision以外の拒否、非公開404・削除410・paused 503、外向け再検証必須とpurge-before-completionを維持する。
- 公開HTTPから毎回TOMLやjob履歴をparseせず、MP3をDO経由で中継しない。

pauseは新規受付と配信を閉じる。既に受け付けたjobだけは同じruntime条件でdrainできるようにする。
queued/running/blockedが残る間はdeploy/domain変更・drain完了扱いを禁止する。pausedというだけで空・完了とはしない。
resumeでは検証済みruntimeと明示windowを用い、古い未受付要求を自動採用しない。

削除はpayloadの物理削除であり、tombstoneを書くだけで完成にしない。
新方式では未登録のCLI uploadをDOが把握しないため、削除完了を保証する前にupload停止・settlementをどう確認するかをlifecycle接続時に具体化する。
その受け入れ前にdeleteを公開せず、未登録uploadの不存在をSQLiteのキュー空から推測しない。

## 6. 実装順序

### P0: 計画保存と開発分離

- 本書を保存し、旧比較書・設計READMEから最新方針へ誘導する。
- `feat/sqlite-sequential-publication`を作り、既存の未commit変更を保持する。無関係な変更を破棄・巻き戻ししない。
- 既存CLI/Workerの既定経路はまだ変更しない。先行実装を既存環境へ配備できた扱いにしない。

### P1: strict protocolとSQLite永続キュー

- 凍結要求、確認済みupload参照、受付/状態schemaと一意key生成をsharedへ追加する。
- DO storage向けSQL schema、FIFO受付、重複排除、job状態遷移、service pause/drainを作る。
- SQLiteでtransaction rollback、同じIDの改変拒否、永続再読込、先頭blockedによる停止をテストする。

### P2: Alarm実行基盤

- 受付と起動予約、running保存、単一job実行、完了と次回起動を接続する。
- executorを小さい明示interfaceへ分離し、テスト用executorでawait順序と異常停止を検証する。
- executorの`validate`は読取・検証だけを行い、確定的な入力不正だけを専用エラーで返す。`publish`開始後の例外は入力不正へ格下げせず、開始した全I/Oのsettlementを待つ。fire-and-forgetや早期rejectする並列I/Oを持ち込まない。
- 再配送/再起動で過去runningを再実行しないこと、statusが長いI/Oを待たないことを検証する。
- 実際のDO classへの接続とDO runtime検証を区別する。Bun SQLiteによるテストだけでCloudflare永続性を実証したとは言わない。

### P3: CLIの一意uploadと凍結submit

- 既存MP3解析・REST upload/readbackを再利用し、前後のR2制御record操作を外す。
- `update-*`のlocal draft/receiptと、明示publishの新journal/HTTP clientを実装する。
- 未完了uploadをenqueueしない、参照素材を上書きしない、submit不明時に再送しない、旧journalを昇格させない回帰を追加する。

### P4: Show/Episode公開runner

- SQLite管理の登録・base/current/content indexと、既存のRSS/media/purge部品を接続する。
- まず新規Show、小容量Episode、metadata-only更新を通す。次にaudio-only・Show metadata/cover更新へ広げる。
- 正常系でR2 lock/status/progressへのアクセスがないこと、失敗後に次のjobが書かないことをテストする。

### P5: 新しいWorker入口・CLI初期化・配信

- DO class export/binding/SQLite schema、薄い管理HTTP、status、配信判定を接続する。
- 新しいservice config schemaを定義し、Queues/DLQの不要な設定値を架空の名前で埋めない。旧configの暗黙変換はしない。
- 新規環境のREST配備・runtime/config/capability検証を実装し、pausedで初期化を終える。新環境にQueues/DLQ/通知設定を作らない。
- Bun単一実行ファイル・既存認証方式を維持する。利用者にWrangler/Node.js/別R2 credentialを要求しない。
- 未対応操作は明示拒否し、旧R2管理経路へfallbackさせない。

### P6: lifecycle・管理統合と受け入れ

- Show/Episodeの非公開化・復元・削除、一覧、pause/resume、deploy/domainを同じ制御正本へ統合する。
- 削除と未登録uploadの扱いを確定し、安全条件・保持方針を検証してから該当コマンドを公開する。
- 既存サービス移行は別計画。dual-write、旧unknown owner解除、旧Queueの要求再解釈は行わない。

## 7. テストと性能確認

### ローカル自動テスト

- 複数要求のFIFO、同じID/bodyの重複、ID改変、同じjobへの別要求、異なる対象の逐次実行。
- PUT途中/失敗/読戻し不一致ではsubmit 0回。metadata-onlyの音源PUT 0回。
- 素材schema/hash/identity不一致、base競合、paused/旧window/旧runtimeでの拒否。
- 実行中に次の要求を受けても並列実行しない。未完了Promiseを残して完了・次へ進まない。
- 受付・開始・公開書込・purge・完了保存の各境界での失敗、再生成/Alarm再配送、blockedの保全。
- 新規公開、metadata-only/audio-only更新、GUID/日時/URL/履歴保持、feed整合性、配信GET/HEAD/Range/条件付き要求。
- `bun test`、`npm run check`、変更した配布経路のCLI buildを実行する。新規lint等は追加しない。

### 実機試験は別承認後

新規隔離環境で小容量→36件を実施する。既存36件のmetadata-only再公開と0→36件取り込みを別試験とし、大容量MP3を測定だけのために再送しない。
tmux独立実行と既存の異常通知supervisorを用い、異常時は後続mutationを止める。
証跡・素材・鍵・journal・rawログは`.local-test-data/`へ保存してGit管理しない。

- CLI総wall、upload/検証、受付待ち、Alarm実行、purge、完了観測を分けて測定する。
- R2操作数、SQL rows、DO request/durationとCPU、外側HTTP/内部cache-owner CPUを別々に記録する。
- 36件Showのmetadata-onlyは、現状の中央値170.759秒に対して比較する。暫定目標は総wall p95 30秒未満で、達成予測とは扱わない。
- feed/audioのcold/warm cacheとclient wallも比較し、DO判定の通信遅延を隠さない。
- HTTP CPUは最大・p95・10ms超過件数・収録欠落を報告する。Issue #13のfreeze未観測と、恒久解消・全Free適合は区別する。

## 8. 実装状況

2026-10-16、`feat/sqlite-sequential-publication`で基盤の実装とローカル回帰を開始した。

| 段階 | 到達範囲 |
| --- | --- |
| P0 | 本書保存、旧比較書の位置付け修正、別branch作成。既存未commit変更は保持 |
| P1 | strict公開/upload参照schema、一意key、要求hash、SQLite schema、FIFO/重複排除、pause/drain、状態遷移を実装。Show/Episode content保存はP4で接続するため未実装 |
| P2 | executor分離したAlarm実行基盤を実装。単一job、I/O await、再生成後のrunningブロック、allowlistログをテスト。実DO class/bindingとCloudflare runtime検証は未接続 |
| P3 | 新config専用の一意upload、private local journal、明示submit/status/waitを内部CLI moduleとして実装。正式コマンドへの分岐・対象inspectionはP5で接続するため未公開 |
| P4 | SQLite content indexと実Show/Episode公開executorを接続。Show、初回Episode、metadata-only/audio-only、Show metadata/cover更新をローカル検証。lifecycle操作の実行は未実装 |
| P5 | DO内で使う認証付きsubmit/status HTTP handlerと配信判定coreを追加。実DO class/binding、外側Worker、正式CLI分岐、init/readiness、実Cache purge・GET/HEAD/Range配信は未接続 |
| P6 | 未実装。既存CLI/Workerの既定経路は切り替えていない |

追加した主なファイル:

- `packages/shared/src/sqlite-publication.ts`: 新protocol、確認済み素材参照、strict schema、key/hash。
- `src/sqlite-publication-queue.ts`: DO storageのSQL/transaction APIへ渡す永続キュー。R2/Queues操作なし。
- `src/sqlite-publication-alarm.ts`: 検証と公開を分離した一件ずつの実行。副作用開始後の例外を入力不正へ格下げしない。
- 同名のtestと`src/test-support/sqlite-publication.ts`: Bun SQLiteで実際のSQLを実行し、rollbackとfile再openを検証。

検証結果:

- 新規31テスト成功。要求改変・別対象のobject key・旧protocol拒否、FIFO、起動予約失敗時の受付rollback、完了と次回起動のrollback、途中I/O待機、再実行禁止を含む。
- 全体`bun test`: **1,208 pass / 0 fail**（130 files、78.62秒）。以前からのローカル診断修正も保持したworking tree全体の結果。
- `npm run check`成功、`npm run build:cli -- linux-x64`成功、`git diff --check`成功。
- Bun SQLiteのテストfixtureがAlarm予約/transactionを模擬している。**DO上の起動予約の原子性・output gate・再配送動作の実証とは区別する。**
- 基盤検証時点ではCloudflare資源・実データの変更、配備、移行、実機性能測定、commit/pushは行っていない。

### P3の内部CLI module

- `packages/shared/src/sqlite-service.ts`: schema version 2の新config。Queues/DLQ不要、旧configを拒否し、完全な設定hashと正確な管理用workers.dev originを束縛する。
- `packages/cli/src/sqlite-draft.ts`、`sqlite-draft-journal.ts`: 同じ対象の未公開job IDを保持し、編集ごとに別upload keyを使う。確認済み素材だけを登録し、公開要求を送信前にfsyncする。既知の完了/確定失敗をarchiveするまでは別draftへ置換しない。
- `sqlite-upload.ts`: PUT前に試行を保存し、成功と全量GET/hash/ETag確認後だけmanifestへ登録する。既存REST upload/readbackとprivate source snapshotを共用するが、旧R2 ownerやstage-start/upload-completeは呼ばない。receiptのversionも保持し、cover上限5MBを維持する。
- `sqlite-publication-client.ts`: 認証付きの小さいHTTP要求、strict/bounded/no-store応答、service/config/request hash/sequence照合。応答不明や404では再POSTしない。既に凍結した`publish()`もstatus読取だけ。waitは最大300回・新規読取開始5分まで。
- audio-onlyではローカルmetadataをbase revisionのcanonical metadata hashと照合する。metadata-onlyでは音源PUTなし。stage後のローカル編集を古いstagingのまま公開しない。
- journalは新しい`sqlite-*` namespace。旧journalの昇格、旧HTTP/Queueへのfallback、未確認PUTのキー再利用、公開完了前のdraft置換はない。

P3までの検証: **1,239 pass / 0 fail**（132 files、74.47秒）、型検査・Linux単体CLI build成功。新CLIとBun SQLiteキューを接続したローカル回帰で、Show/Episode、metadata-only/audio-only、7種類のPUT/検証失敗、送信前後の応答喪失、status改変/rollback、pause、待機上限を確認した。この段階のAlarm executorはテスト用であり、実公開・Cloudflare上のDO動作の受け入れではない。

commit承認後、先行診断を`6a13b1b`、基盤を`075e4e5`へ分けて保存した。push/配備/既存環境の変更はしていない。

### P4の実公開executorとcontent index

- `src/sqlite-publication-content.ts`: 永久Show reservation、Show state version、Episode current/base、GUIDの一意性、不変音源indexをSQLiteへ保存する。本文を保持するcontent tableと小さいidentity/運用recordを分離した。異なるEpisodeの公開ではShow state versionを進めない。
- `src/sqlite-publication-executor.ts`: strict TOML/対象/base/receiptの検証、既存RSS renderer、不変音源/history、current/feed/cover保存とpurgeを接続した。R2にlock/status/progress/commit markerを書かない。初回対象に既存公開objectがあれば採用せず、既存音源はmetadata-onlyで再コピーしない。
- 新音源はreceiptのsize/ETag/versionを照合したstreamをR2 bindingへ渡し、bindingのSHA-256検証と保存結果を確認する。音源全量をWorkerメモリへbufferせず、失敗時はcurrent/feedを進めない。CLIのMP3解析と全量readbackはP3で維持している。
- `SqlitePublicationExecutor.commit`を短い同期SQL callbackとして追加し、**purge後のcontent更新・job成功・次のAlarm予約を同じstorage transaction**へ入れた。途中失敗ではSQLをrollbackし、残るrunningは再配送時にblockedにする。公開IO自体をそのtransactionへ入れない。
- 配信判定coreはapproved pathと最新service/Show/Episode状態・承認済み音源indexだけを見る。paused、実行中、blockedは503、unpublishedは404、deletedは410。lifecycle試験で状態を直接設定してgateを検証しただけで、物理delete runnerの実装/受け入れではない。
- 配信判定でjob本文をparseしないようqueueの内部SQLite schemaを**2**へ進め、`show_id`をscalar列へ保存した。以前の内部schema 1や未知versionは再初期化/暗黙変換せず拒否する。実環境の移行は実施していない。
- 凍結要求の破損・hash不一致は`blocked / stored_request_invalid`にして通知する。queuedのままAlarm retryだけが尽きる経路を避け、後続や公開IOを開始しない。
- `src/sqlite-publication-http.ts`: DO内で使う認証付きの小さいsubmit/status handler。既存auth/bounded readerを再利用し、readiness未確認では新規受付を拒否する。このcallbackを実環境でtrueにするsetup/readinessの配線はまだない。

ローカル結合試験では実際の`SqliteDraft`から、PUT/readback→認証HTTP handler→SQLite FIFO→実公開executor→完了pollまで接続した。Showと2件Episodeを公開し、metadata-only更新の音源/履歴/GUID/日時を保持した。R2はmemory binding fixture、Alarm/storage transactionとpurgeはローカルの模擬であり、Cloudflare runtimeの永続性や実Cache purgeの実証ではない。

P4までの検証: **1,262 pass / 0 fail**（134 files、76.99秒）、`npm run check`、Linux単体CLI build/`--help`、`git diff --check`成功。同じbaseの後続conflict、異なるEpisodeのFIFO、音源checksum不正、書込応答不明、purge失敗、実行中/purge待機、pause中の既受付drain、content/成功/次回起動のrollback、破損要求、HTTP認証/size/readiness拒否を含む。

次はP5の実DO class/binding、正式CLIと対象inspection、新規init/readiness、Workers Cachingを含む配信の接続。内部moduleが通っただけで正式CLIによる新方式の公開が利用可能、Issue #13解消、性能目標達成とは扱わない。Cloudflareへの配備・実機測定、既存環境の変更やpushはしていない。

## 参照

- [DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): 一つのAlarm、at-least-once、有限retry。
- [DO SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): SQL、transaction、output gate。
- [DO state](https://developers.cloudflare.com/durable-objects/api/state/): concurrencyと`blockConcurrencyWhile`。
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/): 成功後の強整合と、結果不明のin-flight PUTの区別。S3の条件付きPUTの説明を管理用REST PUTのCAS保証へ拡大しない。
- [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[limits](https://developers.cloudflare.com/durable-objects/platform/limits/): Free枠・duration・実行制約。
