# RSSからのPodcast移行（v0.4.0）

v0.4.0のCLIとWorkerの両方が必要。v0.3.0以前のバイナリには含まれない。
HTTP CPUの既存観測は15〜34msでWorkers Freeの10ms目標は未達。Freeでの安定稼働とIssue #13の完全解消は保証しない。[リリースの制限](release-v0.4.0.md)を確認する。

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

サービスworkspaceで、v0.4.0のCLIを使用する。既存Workerの更新は[通常更新手順](../README.md#compatible-worker-updates)に従い、最後に明示resumeする。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
cd /path/to/service-workspace
castloop service-status
# external_episode_guids: true、publication_acceptance_protocol: "queue-validation-v1"、admission.state: "open"を確認する。
castloop publish-rss-import /path/to/import
```

全TOML・素材を検証した後、Show登録・Show公開・各Episodeの公開を既存runnerで順番に実行する。既存または削除済みShow IDは採用しない。操作中は取り込みファイルや対象Showを別の操作で変更しない。

Episodeは古い公開日時から公開し、各jobの`published`／`released`を確認して次へ進む。**全件同時公開ではなく、完了したEpisodeから配信される。** 途中で失敗しても完了済み分を削除・rollbackしない。

v0.4.0ではHTTP commitを受付に限定した。`publish-show`／`publish-episode`の
`publication-accepted`、HTTPの`202 / accepted`、local journalの`phase: "accepted"`は、
凍結した要求とcommit markerの受付完了を示す。**staging検証済み・公開成功の応答ではない。**
詳細なstaging証跡、payload identity、base revisionは既存Queue consumerが公開書き込み前に検証する。
旧CLI／Workerとの混用はclaim/commitの受付プロトコル照合で拒否するため、CLIとWorkerを両方更新する。
旧`committed` journalはそのまま読めるが、`accepted`へ自動変換せず、未知要求を再送しない。

完了時に新RSSの番組情報、Episode件数、GUID・公開日時・説明、音源URLを照合し、`feed_url`を返す。`subscriber_migration_completed: false`は、購読者の移行は別途必要という意味。

### 停止した場合

- 読み取り中に公開記録やサービス状態が変わった場合（`publication_status_changed`）だけ、既知jobの状態を再照会する。v0.4.0は各jobで最大300回、待機開始から5分経過後は照会を追加しない。進行中のHTTP照会には別の要求timeoutがあり、CLI全体が必ず5分以内に終了するという意味ではない。`published`／`released`の検証までは次の公開へ進まない。この識別には対応CLIとWorkerの両方が必要。
- 公開receiptを保存済みのjobで状態照会に失敗した、または公開待機が終わらない場合は、同じコマンドでそのjobの確認から続けられる。完了済みの公開を再送しない。
- 公開前の確定的な入力不一致は`failed / validation_failed`として表示し、待機を終了する。`ownership: "held"`のShow ownerと凍結draftは保持する。I/Oが終了した通常経路ではexecution/service tokenだけを返す。重複配送で公開へ進めず、`retry-job`も拒否する。draft編集、別jobへの置換、owner強制解除は復旧方法ではなく、安全な取消し操作は未提供。
- heldなjobにDLQ履歴がある場合は早期停止し、token残留か、実行tokenを返却済みの失敗履歴かを表示する。DLQ markerは現在の実行・I/Oの終了証明ではない。前回追加した`release-job`／`publication-release`は安全条件を満たさず無効化したため使用しない。lock/owner/registryを保持し、[停止の診断手順](../design/publication_execution_recovery.md)で調べる。
- 更新前の対象照会では、確認できた記録変化（`target_status_changed`）だけ最大3回照会する。その他のエラーは停止し、変更処理を始めていなければ進捗を`ready`に戻す。同じ取り込みコマンドで続行できる。HTTP拒否には`http_status`を表示する。
- 修正前の`command_requested`記録も、Episode作成直後の最初の`update-episode`に限り続行できる。保持したworkspaceで下書きjournal／lockが未作成、ローカルTOMLが取り込み内容と一致、サーバーのEpisodeが未登録、Showがactive／openで所有者なし、照会前後のローカル記録が不変であることを確認する。確認できなければ停止する。通常更新は下書きjournalを保存してから変更要求を送るため、既存journalがあればこの復旧は適用しない。
- 照会エラーの`reason_code`は、通信失敗（`management_transport_failed`）、HTTP拒否（`management_http_rejected`）、応答形式不正（`management_response_invalid`）、公開schema／identity不一致（`management_identity_invalid`）、ローカル記録変化（`local_record_changed`）等を区別する。これらは自動再照会せず停止する。調査にはコードを保存し、秘密を含む原本や応答を公開しない。
- 変更コマンドの応答が不明な場合は再送を拒否する。サービスの`.castloop/`にある登録・staging・publicationの既存journalを保持し、`local-operation-status`／`operation-status`で調べる。lockやownerを削除しない。上記の未開始確認は、記録を削除・復元したworkspaceには適用しない。
- 公開進捗は`.castloop/rss-imports/<serviceId>/<importId>.json`に保存する。開始後に取り込み入力や公開URL・サービスを変更したら続行しない。
- `.castloop/`の記録削除、新しいjobによる置換、`init`の再実行は復旧方法ではない。未知の変更要求からの万能な自動復旧は提供しない。

新しい版は既存UUID Episodeも読めるが、任意GUIDを取り込んだ後の旧版へのdowngradeは非対応。

### Workerの時間ログと性能比較

v0.4.0のWorkerは、Cloudflare Workers LogsへJSONログを出力する。Dashboardの対象WorkerのObservabilityでjob IDを検索する。

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
