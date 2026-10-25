# RSSからのPodcast取り込み（v0.6.0）

v0.7.0は`storage_layout="show-v1"`の新規サービス専用。`publish-rss-import`は新Showの作成・初期probe・そのShowだけのResumeも含む。全体Pause/Resumeはなく、remote操作記録は`--show SHOW_ID`で対象を指定する。以下の過去の実機結果は新layoutの検証ではない。

v0.6.0ではSQLiteサービス（サービス設定version 2）だけに公開する。公開には対応するCLI・検証済みWorker・private workspaceが必要。旧サービス設定version 1からのマイグレーション機能やjournal変換は提供しない。
旧版v0.5.2の操作は[同版のガイド](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/rss_migration.md)を参照する。v0.6.0の検証は[新規隔離環境の回帰試験](../design/archive/schema_v1_removal_live_test.md)、v0.6.1の入力上限は[リリースノート](release-v0.6.1.md)、v0.6.2の操作記録は[リリースノート](release-v0.6.2.md)、v0.7.0の変更は[リリースノート](release-v0.7.0.md)に記録した。超過した取込は切り詰めず、TOML編集後に再審査する。

ローカルdownloadはサービスworkspace不要。既存の取り込み素材は引き続き検証して利用できるが、旧Queue公開cursorをSQLiteの受付記録として採用しない。

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
- Issue #70開発版で[内蔵サイト](show_website.md)を使う場合は、最初の公開前に`show.toml`へ`site_mode = "builtin"`を追加し`site_url`を削除して確認する。既定では元RSSの外部サイトURLを維持する。GUID・日時は変更しない。
- カバーが開け、各MP3が再生できるか。
- `import.json`の`warnings`に、残す必要がある情報が含まれていないか。Episode画像・transcript・独自拡張等は保存しない。
- 説明内のリンクや画像に、廃止する旧ホストへの依存が残っていないか。それらの外部素材はコピーしない。

GUID・公開日時・`guid_is_permalink`は変更しない。他の不足項目や説明は編集できる。

download中に失敗したら、同じコマンド・同じ出力先で続行する。保存済みRSSを使い、hashが一致する完成素材を再利用する。編集したTOMLは上書きしない。取り込み先を移動せず、`.castloop/`と元MP3を保持する。

取得先は公開HTTP／HTTPSの標準portに限定する。認証付きURL、localhost・私有address、HTTPSからHTTPへのredirect、DTD／外部entity、UTF-8以外のXMLは非対応。

## 2. 確認した内容を公開する

サービスworkspaceで実行する。新規サービスは方式指定なしの`castloop init`で作成する。[SQLiteガイド](sqlite_sequential_development.md)に従い、制御DOの稼働を確認する。公開コマンドが新Showだけを作成・再開し、他Showは変更しない。既存layoutは採用・移行しない。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
cd /path/to/service-workspace
castloop service-status
# Confirm the ready SQLite service outside shared maintenance.
castloop publish-rss-import /path/to/import
```

全TOML・素材を検証した後、Show登録・Show公開・各Episodeの公開を既存runnerで順番に実行する。既存または削除済みShow IDは採用しない。操作中は取り込みファイルや対象Showを別の操作で変更しない。

Episodeは古い公開日時から公開し、各jobの完了を確認して次へ進む。**全件同時公開ではなく、完了したEpisodeから配信される。** 途中で失敗しても完了済み分を削除・rollbackしない。

| 公開先 | 必要な稼働状態 | 完了証拠 |
| --- | --- | --- |
| SQLite | 同じconfig/runtimeの`publication_ready: true`、`state: "open"`と受付window | 凍結job IDの`status.state: "succeeded"` |

SQLiteはCLIの一意uploadと検証後、DO FIFO/Alarmへ明示要求する。Queues Editは不要。
公開前にreview済み素材とstaged receiptを照合し、元のjob IDを凍結する。既存/削除済みShowの採用、別draftへの置換、未知要求の再送はしない。
queued/acceptedだけでは公開成功ではない。

完了時に新RSSの番組情報、Episode件数、GUID・公開日時・説明、音源URLを照合し、`feed_url`を返す。`subscriber_migration_completed: false`は、購読者の移行は別途必要という意味。

### 停止した場合

- 各job最大300状態照会、5分経過後は新規照会を開始しない。進行中の要求には別timeoutがあり、CLI全体が必ず5分以内に終了するという意味ではない。
- 複数Episodeのupload・全量readback・公開は逐次処理のため、import全体は数分以上かかり得る。外部の実行ツールやCIから起動する場合、短いcommand全体timeoutで強制終了させない。単一jobの5分予算とbatch全体の時間を区別し、元processの終了とjournalを確認せず二重起動しない。
- SQLite管理GETの通信/本文断とallowlistの一時HTTP拒否は最大3試行。retryも300 GETへ数える。schema/identity不一致や恒久拒否はretryしない。
- 保存済みpending publicationがある場合、同じ取り込みはその凍結jobのstatusを確認する。完了済み公開を再送せず、別jobへ置き換えない。v0.7.0の新形式では、成功応答があるuploadの検証・下書き登録、完了確認済みのローカル配置からも続行できる。未知upload・登録・ローカルinstallは自動再実行しない。
- SQLiteの`failed`は公開書込前の確定的失敗、`blocked`は未知IOや途中停止等で後続FIFOを止める。retry/releaseを提供せず、経過時間・HEAD不在で解放しない。
- `.castloop/`、取り込み元のTOML/cover/audio、元workspaceを保持する。公開開始後に入力・公開URL・サービスを変えたり、journal/lockを削除したりしない。
- v0.7.0は`operation-status rss-import IMPORT_UUID --show my-show --remote`と`operation-list --show my-show --parent IMPORT_UUID`で、取り込み全体と各処理を照合できる。操作は[中断後の手順](sqlite_operation_recovery.md)を参照する。配布済み版では`job-status`/`service-status`を使う。

新しい版は既存UUID Episodeも読めるが、任意GUIDを取り込んだ後の旧版へのdowngradeは非対応。

### Workerの時間ログと性能比較

対応WorkerのCloudflare Workers Logsを使用する。DashboardのObservabilityでjob IDとruntime/version・request/trace IDを照合する。
保存ログの収集・CPU数値とapplication log・tail配送の不足は区別する。公開確認のprobe IDが一致しない記録を欠測0msとして扱わない。

SQLiteでは通常Worker HTTP/cacheとDO HTTP/RPC/Alarmを区別する。通常Free HTTPは10ms、DOは既定30秒のCPU上限で評価し、ジョブ全体のCPUを合算する必要はない。
最新試験の外側/cache HTTP最大は3/5ms、公開probeは60/60対応したが、全invocation・未試験負荷の保証ではない。[測定記録](../design/archive/sqlite_size36_measurement_20261017.md)を参照。

診断ログは本文・秘密・任意例外文を含めず、SQLiteの固定eventとjob/request/versionを照合する。sampling・保持・tail配送不足とCPU 0msを混同しない。v0.6.0の追加確認では通常Workerの最大3/5msを保存ログで確認したが、全ログ収録や全負荷のFree適合は保証しない。

実機試験には別承認が必要。`scripts/test-support/worker-tail.ts`等の採取器は正式CLIに含まれず、tail削除や未知変更の再送・強制解放を自動実行しない。旧Queueのphase・R2カタログ・診断手順は[v0.5.2時点の資料](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/rss_migration.md)に保存する。

## 3. 購読先を切り替える

新RSSと全音源を確認してから、旧ホスト側の移行機能で新RSSへの301 redirectを設定し、各Podcast directoryの手順に従って切り替える。castloopは旧ホストの設定や購読者の登録を変更しない。

[Appleの案内](https://podcasters.apple.com/support/837-change-the-rss-feed-url)ではGUID維持に加え、redirect等を少なくとも4週間維持することが求められる。移行確認と必要な維持期間を満たし、旧ホスト依存の素材が残っていないことを確認してから旧環境を廃止する。取り込み完了だけを理由に削除しない。
