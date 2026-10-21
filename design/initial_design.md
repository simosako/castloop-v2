# castloop v2 デザインドキュメント

2026-10-21追補: Issue #50の[Feed継続配信設計](episode_add_feed_availability_plan.md)第1段階を実装した。Feedは世代別の不変R2 objectへ保存し、purge後のSQL完了で配信先を切り替える。内部queue/content schemaは3/4で、新規環境専用。従来の固定key版からの移行・互換配備は提供しない。

更新日: 2026-10-20。**Issue #48の開発版仕様（未リリース）**。v0.6.2の公開・操作記録機能をShow単位DOへ分離し、Pause/ResumeをShow単位に変更する。配布済みv0.6.2の旧layoutとは非互換で、移行・旧版サポートは提供しない。設計と検証範囲は[採用設計](do_show_separation_options.md)、過去のリリースは[v0.6.2](../docs/release-v0.6.2.md)を参照。
操作は[README](../README.md)、詳細は[SQLiteガイド](../docs/sqlite_sequential_development.md)、[文書索引](README.md)を参照する。

## リリース境界

- v0.6.0以降はサービス設定`schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`のみを扱う。
- 本開発版はさらに`storage_layout = "show-v1"`を必須とする。省略した旧設定は管理要求・配備・鍵/journal作成前に拒否する。既存設定へ追記して移行する手順ではなく、新規環境専用である。
- `castloop init`の既定はSQLite。従来の`--publication-protocol sqlite-sequential-v1`も省略可能な指定として受け付ける。
- v0.5.xでは従来のQueue/R2方式を維持するが、v0.6.0向けコードと配布物から旧専用CLI／Worker／schema／テストを削除した。
- 旧version 1設定は管理操作・配備・鍵作成前に拒否する。専用移行機能、旧journal変換、既存資源採用、fallbackを提供しない。
- Show／Episode／revisionとSQLite要求等の独立した`schema_version = 1`はそのまま維持する。サービス設定versionと混同しない。
- v0.5.2までの設計・開発履歴は[保存版](archive/initial_design_v052.md)、削除範囲は[Issue #24計画](schema_v1_removal_plan.md)を参照する。

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
- `failed`は副作用前の確定入力/base失敗。`blocked`は途中停止・不明IO等であり対象Showの後続FIFOを止める。新規Episode追加で確定世代・要求hash・対象未登録の保存根拠を照合できる場合だけ旧公開内容の読取を継続し、それ以外は配信503。他Showの通常操作・Pause/Resume・新Show登録を止めない。
- 再起動／Alarm再配送で残ったrunningを再実行せずblockedとして保全する。経過時間・HEAD不在・空queueで解放せず、未知PUT/POSTを再送しない。blockedのretry/releaseは未提供。
- 管理GETだけは有限の一時エラーretryを行う。status待機は最大300 GET・5分経過後に新規GETを始めない。開始済みIOとcleanupのsettlementを待つ。
- 診断は固定のallowlistコード・許可した識別子だけを保存し、本文・メール・秘密・任意例外文を運用記録へ入れない。

## 配信とキャッシュ

公開URLは`/podcasts/<showId>/feed.xml`、`cover.jpg|png`、`episodes/<episodeId>/<revisionId>.mp3`のみ。system／staging／metadata／indexを配信しない。

- gatewayはpublic pathから対象Show DOへ直接到達し、毎回その最新scalar判定でready・Pause・保守拘束・Show/Episode状態・承認音源を確認する。制御DOへの毎回の照会や判定のTTL cacheは行わない。
- paused/readiness不一致・保守拘束は503、unpublishedは404。新規Episode追加のrunning/blockedだけ、保存した保護根拠が成立すれば旧Feed・承認済みcover/audioを配信する。その他の実行中／blocked、要求破損や保護根拠不一致は503。SQLiteの削除状態に対するgateはあるが物理削除操作は未提供。
- 許可した要求のみ同version cache ownerへ送り、認証header／cookie／queryを転送しない。
- GET／HEAD／単一Range／ETag・日付条件付き応答を維持する。外向け成功応答は再検証必須、非公開／停止／エラーはno-store。内部cache tagを外へ出さない。
- cache propsのgenerationを分離し、遅い旧cache fillを新feedへ使わない。必要なpurgeが成功するまで公開完了にしない。
- FeedのR2読取先は`public/podcasts/<showId>/feeds/<feed_generation>.xml`で、HEAD/GETとも同世代に固定する。世代を指定する公開URLは設けず、旧snapshotを自動削除しない。公開済みShowの確定snapshot欠落は503。Show更新・既存Episode更新の継続配信は後続開発とする。

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

詳しくは[操作記録の設計](sqlite_operation_records_schema.md)と[利用方法](../docs/sqlite_operation_recovery.md)を参照する。旧版v0.6.1以前や、以下の過去の実機測定とは区別する。

## 未提供機能と検証の限界

物理delete、独自domain、既存サービス移行、blocked retry/release、未登録uploadの一般cleanup、予約配信、音源変換、統計は提供しない。旧Queueのdomain／deleteを代替として呼び出さない。

過去のSQLite36件＋更新10回・通常HTTP最大3/5ms・probe60/60は[保存した負荷の結果](archive/sqlite_size36_measurement_20261017.md)。今回の削除版のnative性能や全Free適合を示すものではない。300MB新経路・実機purge rate-limit retry・#13恒久解消・万能復旧は保証しない。

コード変更・試験完了はCloudflareの配備・resume／公開・資源削除・domain／権限／課金変更の許可ではない。保持環境と私有journal／素材／証跡を保全する。

## 開発確認

`npm ci`、`npm run check`、`bun test`、`npm run build:cli -- linux-x64`を用いる。新たなlint等は追加しない。模擬SQL/Alarm/R2/Cache/RESTと、Cloudflare nativeのoutput gate・再配送・purgeを区別する。
