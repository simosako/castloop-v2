# RSSからのPodcast移行（v0.5.0以降）

v0.5.0はSQLite方式（schema-version-2）と既存Queue方式（schema-version-1）の両方に対応する。v0.5.1はRSSへ出力するテキストのXML 1.0検証を追加する。
公開には選択した方式に対応するCLI・検証済みWorker・private workspaceが必要で、既存サービスを自動変換しない。
通常HTTPの最新測定範囲と未検証事項は[v0.5.0リリースの制限](release-v0.5.0.md)、v0.5.1の変更点は[v0.5.1リリースノート](release-v0.5.1.md)を確認する。

ローカルdownloadは両方式で共通。公開先のprotocolによって受付・完了status・復旧条件が異なるため混用しない。

## 対象

- 管理者が移行する権利を持つ、公開RSS 2.0の番組。
- 取得したRSSに含まれる全Episodeを、新規Showへ一度取り込む。
- 音源はMP3、1件300,000,000 bytes以下。番組カバーはJPEG／PNG、5,000,000 bytes以下。
- 既存Showへの追加、定期同期、ページ分割の自動追跡、音源変換、旧ホストの削除は行わない。

## 1. ローカルへ取り込む

まず件数、不足項目、対応しないRSS項目を確認する。この操作はRSSだけを取得する。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --dry-run
```

空のディレクトリへ素材とTOMLを保存する。親ディレクトリは事前に作成しておく。Cloudflare認証やサービスworkspaceは不要。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import
```

保存するのは`source.xml`、`show.toml`、`episode-<id>.toml`、番組カバー、`<id>.mp3`、`import.json`、私有の`.castloop/`記録。GUIDから作るEpisode IDは`ep-<SHA-256>`となる。

元RSSのGUID・公開日時・GUIDの`isPermaLink`を維持する。不足するowner email、カテゴリ、サイトURL等を架空の値で埋めない。`missing_fields`を確認し、TOMLで補う。

### 公開前に確認する内容

- 元ホストの全Episode件数と取り込み件数が一致するか。元RSSに載っていないEpisodeは取り込めない。
- タイトル・説明・公開日時・番組情報が正しいか。番組のWebサイトは旧ホスト廃止後も利用できる実在URLにする。
- カバーが開け、各MP3が再生できるか。
- `import.json`の`warnings`に、残す必要がある情報が含まれていないか。Episode画像・transcript・独自拡張等は保存しない。
- 説明内のリンクや画像に、廃止する旧ホストへの依存が残っていないか。それらの外部素材はコピーしない。

GUID・公開日時・`guid_is_permalink`は変更しない。他の不足項目や説明は編集できる。

download中に失敗したら、同じコマンド・同じ出力先で続行する。保存済みRSSを使い、hashが一致する完成素材を再利用する。編集したTOMLは上書きしない。取り込み先を移動せず、`.castloop/`と元MP3を保持する。

取得先は公開HTTP／HTTPSの標準portに限定する。認証付きURL、localhost・私有address、HTTPSからHTTPへのredirect、DTD／外部entity、UTF-8以外のXMLは非対応。

## 2. 確認した内容を公開する

サービスworkspaceで実行する。SQLiteサービスの初期化・互換更新は[SQLiteガイド](sqlite_sequential_development.md)、既存Queueサービスは[Queue方式ガイド](queue_service.md)に従い、稼働確認後に明示resumeする。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
cd /path/to/service-workspace
castloop service-status
# Confirm the protocol-specific ready/open runtime before submission.
castloop publish-rss-import /path/to/import
```

全TOML・素材を検証した後、Show登録・Show公開・各Episodeの公開を既存runnerで順番に実行する。既存または削除済みShow IDは採用しない。操作中は取り込みファイルや対象Showを別の操作で変更しない。

Episodeは古い公開日時から公開し、各jobの完了を確認して次へ進む。**全件同時公開ではなく、完了したEpisodeから配信される。** 途中で失敗しても完了済み分を削除・rollbackしない。

| 公開先 | 必要な稼働状態 | 完了証拠 |
| --- | --- | --- |
| SQLite | 同じconfig/runtimeの`publication_ready: true`、`state: "open"`と受付window | 凍結job IDの`status.state: "succeeded"` |
| v0.5.0 Queue管理 | `queue-management-v1` readiness、open admission、Queues Edit付きCloudflare認証 | 認証付き結果の`server_status.response.state: "published"` |
| 保持した旧Queue job | 元のjournal/protocolを維持 | 従来の`published / released` |

SQLiteはCLIの一意uploadと検証後、DO FIFO/Alarmへ明示要求する。Queues Editは不要。
公開前にreview済み素材とstaged receiptを照合し、元のjob IDを凍結する。既存/削除済みShowの採用、別draftへの置換、未知要求の再送はしない。
v0.5.0 Queue管理はstage-start/grant/upload-complete/publishを使い、HTTP commitへfallbackしない。旧journalを新しい受付済み記録へ昇格しない。
いずれもqueued/accepted/enqueue receiptだけでは公開成功ではない。

完了時に新RSSの番組情報、Episode件数、GUID・公開日時・説明、音源URLを照合し、`feed_url`を返す。`subscriber_migration_completed: false`は、購読者の移行は別途必要という意味。

### 停止した場合

- 各job最大300状態照会、5分経過後は新規照会を開始しない。進行中の要求には別timeoutがあり、CLI全体が必ず5分以内に終了するという意味ではない。
- SQLite管理GETの通信/本文断とallowlistの一時HTTP拒否は最大3試行。retryも300 GETへ数える。schema/identity不一致や恒久拒否はretryしない。Queue方式へこのGET契約を流用しない。
- 保存済みpending publicationがある場合、同じ取り込みはその凍結jobのstatusを確認する。完了済み公開を再送せず、別jobへ置き換えない。未知upload・登録・ローカルinstallは自動再実行しない。
- SQLiteの`failed`は公開書込前の確定的失敗、`blocked`は未知IOや途中停止等で後続FIFOを止める。retry/releaseを提供しない。Queueの`failed/rejected/blocked`も凍結要求とowner/tokenを保持し、DLQ・経過時間・HEAD不在で解放しない。
- `.castloop/`、取り込み元のTOML/cover/audio、元workspaceを保持する。公開開始後に入力・公開URL・サービスを変えたり、journal/lockを削除したりしない。
- protocolごとに`job-status`/`service-status`で照合する。未知mutationを再送する万能復旧は提供しない。旧Queueの限定的復旧条件は[Queue方式ガイド](queue_service.md)と[v0.4.0時点の詳細](https://github.com/simosako/castloop-v2/blob/v0.4.0/docs/rss_migration.md)を参照し、SQLiteへ適用しない。

新しい版は既存UUID Episodeも読めるが、任意GUIDを取り込んだ後の旧版へのdowngradeは非対応。

### Workerの時間ログと性能比較

対応WorkerのCloudflare Workers Logsを使用する。DashboardのObservabilityでjob IDとruntime/version・request/trace IDを照合する。
保存ログの収集・CPU数値とapplication log・tail配送の不足は区別する。公開確認のprobe IDが一致しない記録を欠測0msとして扱わない。

SQLiteでは通常Worker HTTP/cacheとDO HTTP/RPC/Alarmを区別する。通常Free HTTPは10ms、DOは既定30秒のCPU上限で評価し、ジョブ全体のCPUを合算する必要はない。
最新試験の外側/cache HTTP最大は3/5ms、公開probeは60/60対応したが、全invocation・未試験負荷の保証ではない。[測定記録](../design/archive/sqlite_size36_measurement_20261017.md)を参照。

以下のphase名・カタログの説明は、既存Queue方式の診断用でありSQLiteのcontrol DBには適用しない。

- `event: "worker_phase_started"`: `job_id`、固定`phase`、`timing_id`、`started_at`。処理のawait前に出す。
- `event: "worker_timing"`: 同じ`timing_id`と`job_id`／`phase`、`outcome`、`started_at`、`finished_at`、`duration_ms`。
- `event: "publication_delivery"`: Queue messageの時刻、consumer登録前の時刻、配送試行回数。時計が異なるため、時刻差は近似値として扱う。
- `event: "publication_execution_blocked"`: 残留execution tokenでconsumerを拒否したこと。`authorizes_recovery: false`であり、生存・終了証明ではない。
- 公開受付、consumer全体、実行取得、service invocation解放を記録する。Episode公開はさらにguard内部、staging証跡、snapshot、GUID検証、音源HEAD/GET/PUT/検証/cancel、feed入力、history/current/feed書き込み、catalog/世代保存、progress/status保存、purge、Show owner解放、例外後処理を区別する。staging管理APIもactionごとに記録する。

ログには素材・本文・秘密・execution tokenを含めない。詳細traceをR2に保存せず、診断用headerも返さない。Workerの時計はI/Oで進むため、`duration_ms`はI/O区間の比較用でCPU profileではない。consumer全体とその内部phaseは重なるので加算しない。ログのsampling・保持期間により、全記録を後から取得できるとは限らない。

停止調査ではjob IDに加え同じattemptのrequestId/traceIdで絞り、`timing_id`で開始と終了を対応付ける。
最も内側の開始だけのphaseをplatform outcome/例外・CPU/wallと照合する。`progress.phase=feed`は
音源保存だけでなくcatalog/世代保存まで含み、開始ログのみでも取消理由や解放の安全性を確定できない。
このログには対応Workerが必要だが、残留tokenを通常更新のpause/drain条件から除外して配備しない。

実機性能試験の採取には`scripts/test-support/worker-tail.ts`を使用できる（正式CLIの機能ではない）。
同じWorkerのtail IDが複数観測者で共有される場合があるため、観測終了時はWebSocketだけを閉じ、
tail削除APIを自動実行しない。ping/pongだけではremote tail削除による配送停止を検知できないので、
IDの一覧照合と期限・health記録も必要。採取異常のある時間分布を完全な測定結果として扱わない。
試験用起動コードは、実行中の変更要求を打ち切らずsettleを待ち、次の変更コマンドを拒否する。
詳細は[採取時の注意](../design/publication_execution_recovery.md#長時間試験のlive-tail採取)を参照。

性能比較は、公開済み36件Showのmetadata-only 1件更新を同じ条件で測る。完成済みimportの再実行では公開処理を測れない。CLI/Workerのcommitとjob IDを記録し、`publication.consumer`、`publication.guard`、`publication.feed_inputs`、`publication.unique_guid`、`staging.finish`と、CLIが`published / released`を確認するまでを比較する。実機更新は承認された試験環境で行う。

v0.4.0は、検証済みEpisode情報をShow単位のカタログに保存する。CLIを更新し、通常更新手順でWorkerもdeploy・検証・明示resumeする。古いWorkerへのdowngradeは行わない。

- 既存Showの最初の公開更新ではカタログ構築のため全件を読む。このjobの時間は「初回構築」として別に記録し、published/releasedとservice invocation解放を確認する。
- 次の同一metadata-only更新1jobを通常更新として測る。GUID/feed入力の時間とstaging finishを4781fadの測定と比較し、前後のfeed byte一致、GUID・音源参照不変、所有権解放を確認する。
- カタログはprivate R2の`public/podcasts/<showId>/episode-catalog.json`。`public/`というkeyでも公開Workerはこのpathを配信しない。確認時はそのURLが404になることも調べる。手動編集・削除はしない。
- Episode公開停止ではカタログ内に元情報を保持し、復元で再掲載する。Episode削除では対象情報を除き、Show削除ではカタログ自体をpayloadとして削除する。Show停止中の子操作もカタログ更新世代を進めるが、停止中のfeedは書き換えない。

通常更新では未変更Episodeの個別GET/HEADを行わない。転送するカタログと生成するRSSの量は件数に比例するため、全体の所要時間が件数に全く依存しなくなるという意味ではない。構築済みカタログの欠落・破損・世代不一致は自動再構築せず停止する。

## 3. 購読先を切り替える

新RSSと全音源を確認してから、旧ホスト側の移行機能で新RSSへの301 redirectを設定し、各Podcast directoryの手順に従って切り替える。castloopは旧ホストの設定や購読者の登録を変更しない。

[Appleの案内](https://podcasters.apple.com/support/837-change-the-rss-feed-url)ではGUID維持に加え、redirect等を少なくとも4週間維持することが求められる。移行確認と必要な維持期間を満たし、旧ホスト依存の素材が残っていないことを確認してから旧環境を廃止する。取り込み完了だけを理由に削除しない。
