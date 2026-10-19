# castloop v2 デザインドキュメント

更新日: 2026-10-18。**v0.6.1仕様**。SQLite単独化と既定initに加え、新規Show/EpisodeメタデータのApple基準入力上限を提供する。保存履歴の読取・復元は無制限のまま維持する。配布の取得だけで既存環境へ配備されるものではない。[リリースノート](../docs/release-v0.6.1.md)参照。
操作は[README](../README.md)、詳細は[SQLiteガイド](../docs/sqlite_sequential_development.md)、[文書索引](README.md)を参照する。

## リリース境界

- v0.6.0以降はサービス設定`schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`のみを扱う。
- `castloop init`の既定はSQLite。従来の`--publication-protocol sqlite-sequential-v1`も省略可能な指定として受け付ける。
- v0.5.xでは従来のQueue/R2方式を維持するが、v0.6.0向けコードと配布物から旧専用CLI／Worker／schema／テストを削除した。
- 旧version 1設定は管理操作・配備・鍵作成前に拒否する。専用移行機能、旧journal変換、既存資源採用、fallbackを提供しない。
- Show／Episode／revisionとSQLite要求等の独立した`schema_version = 1`はそのまま維持する。サービス設定versionと混同しない。
- v0.5.2までの設計・開発履歴は[保存版](archive/initial_design_v052.md)、削除範囲は[Issue #24計画](schema_v1_removal_plan.md)を参照する。

## 構成とデータの正

Podcastを管理者自身のCloudflareアカウントへ配備する。1サービスにつき1 private R2 bucket、1 public Worker、1 SQLite-backed Durable Objectを使用する。複数Showを同じbucketにID別で保存し、Cloudflare Queues／DLQ／D1は使用しない。

```text
CLI: ローカルTOMLと素材の検証 → 一意のR2 keyへupload → 全量readback/hash/size/identity確認
  → 明示publishで要求を凍結しDOへ送信
DO: SQLiteへ受付・順序を原子的に保存 → AlarmがFIFOで一件ずつ実行
  → 検証 → 不変音源/revision・current/feed/cover保存 → cache purge → SQL完了
Gateway: DOの最新の小さい配信判定 → 同versionのcache owner → R2 streaming
```

ローカルTOMLは編集元、R2はpayloadと公開snapshot、SQLiteは制御状態・content index・受付順・job結果の正本とする。R2をlock/status/progress DBとして使わない。

### WorkerとCLI

- 正式Worker入口は`src/sqlite-worker.ts`。`SqlitePublicationService`がDO、`SqliteCachedAssets`がnamed cache owner。
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
- `failed`は副作用前の確定入力/base失敗。`blocked`は途中停止・不明IO等であり後続FIFOを止める。
- 再起動／Alarm再配送で残ったrunningを再実行せずblockedとして保全する。経過時間・HEAD不在・空queueで解放せず、未知PUT/POSTを再送しない。blockedのretry/releaseは未提供。
- 管理GETだけは有限の一時エラーretryを行う。status待機は最大300 GET・5分経過後に新規GETを始めない。開始済みIOとcleanupのsettlementを待つ。
- 診断は固定のallowlistコード・許可した識別子だけを保存し、本文・メール・秘密・任意例外文を運用記録へ入れない。

## 配信とキャッシュ

公開URLは`/podcasts/<showId>/feed.xml`、`cover.jpg|png`、`episodes/<episodeId>/<revisionId>.mp3`のみ。system／staging／metadata／indexを配信しない。

- gatewayは毎回DOの最新scalar判定を読み、ready・service・Show/Episode状態・承認音源を確認する。判定をTTL cacheしない。
- paused/readiness不一致・対象実行中／blockedは503、unpublishedは404。SQLiteの削除状態に対するgateはあるが物理削除操作は未提供。
- 許可した要求のみ同version cache ownerへ送り、認証header／cookie／queryを転送しない。
- GET／HEAD／単一Range／ETag・日付条件付き応答を維持する。外向け成功応答は再検証必須、非公開／停止／エラーはno-store。内部cache tagを外へ出さない。
- cache propsのgenerationを分離し、遅い旧cache fillを新feedへ使わない。必要なpurgeが成功するまで公開完了にしない。

## 管理と運用

- fresh initは未使用資源のみ。REST設定、正確な配備version/ETag/namespace、native SQL/Alarm/R2/cache/purgeを確認し、pausedで完了する。
- pauseは配信と新規受付を閉じ、既受付jobだけdrainする。pausedだけでdrainedとは扱わない。resumeには新しいwindow UUIDを使う。
- deployは同じconfig/schema/namespaceのcode-only更新。明示pause/drain後に正確なprepared状態を保存し、新versionをprobeしてpausedで完了する。config/schema変更・自動rollbackはしない。
- `update-service-verify`はPUT成功checkpoint／配備receiptと凍結入力を照合して、既知配備の検証と未開始のactivation/probeだけを明示続行する。旧receipt-free journal・未知activationを推測で昇格しない。[更新契約](sqlite_worker_update_recovery.md)参照。
- `init-reconcile`／`update-service-reconcile`は正確な完了済みserver証拠との読取照合のみ。initの限定検証続行もresource／配備／要求済みsetupを繰り返さない。
- 一覧はSQL indexから20件pagination。非公開化／復元はpreview→hash確認→executeで同じFIFOへ送る。復元は保存済みsnapshotを使い、子の個別停止を勝手に復活させない。
- RSSはdownload→ローカルreview→新規Showへの逐次公開。GUID・日時を維持するが、subscriber／旧ホスト移行やservice schema変換は行わない。

## 開発版の操作記録（Issue #40）

開発版は既存DOに操作・要求・素材・履歴と形式管理の5表を追加する。CLIはupload前に操作を登録し、PUT開始、成功応答、検証、下書き登録を記録する。公開の受付・実行・完了履歴は既存キューのトランザクションへ接続する。公開要求の本文・ハッシュ、既存content/queueの保存形式は維持する。

一覧・詳細・容量表示は読取専用。成功応答があるuploadと完了済み公開は結果を照合して続行する。取消後の未使用staging素材は、利用禁止を原子的に確定してから、プレビューと確認hashに従って削除する。必要な記録は保持し、容量を50/70/85%で警告する。

詳しくは[操作記録の設計](sqlite_operation_records_schema.md)と[利用方法](../docs/sqlite_operation_recovery.md)を参照する。配布済みv0.6.1や、以下の過去の実機測定とは区別する。

## 未提供機能と検証の限界

物理delete、独自domain、既存サービス移行、blocked retry/release、未登録uploadの一般cleanup、予約配信、音源変換、統計は提供しない。旧Queueのdomain／deleteを代替として呼び出さない。

過去のSQLite36件＋更新10回・通常HTTP最大3/5ms・probe60/60は[保存した負荷の結果](archive/sqlite_size36_measurement_20261017.md)。今回の削除版のnative性能や全Free適合を示すものではない。300MB新経路・実機purge rate-limit retry・#13恒久解消・万能復旧は保証しない。

コード変更・試験完了はCloudflareの配備・resume／公開・資源削除・domain／権限／課金変更の許可ではない。保持環境と私有journal／素材／証跡を保全する。

## 開発確認

`npm ci`、`npm run check`、`bun test`、`npm run build:cli -- linux-x64`を用いる。新たなlint等は追加しない。模擬SQL/Alarm/R2/Cache/RESTと、Cloudflare nativeのoutput gate・再配送・purgeを区別する。
