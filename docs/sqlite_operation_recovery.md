# SQLiteの操作記録と中断後の操作

Issue #40で導入した操作記録の利用方法。サーバーへの記録、アップロードの再開、取消、未公開素材の削除には、対応するCLIとWorkerを使う。旧版v0.6.1以前の配布済みバイナリには含まれない。

v0.7.0では操作記録を各ShowのDOに保存し、remoteコマンドに`--show SHOW_ID`を必須とする。以下は新layout向けの操作例で、配布済みv0.6.2とは引数が異なる。`--local`と保存済みlifecycle jobの照会にはShow指定は不要。旧layoutへの互換配備・移行は提供しない。

## 状態を確認する

サービスの作業ディレクトリで実行する。

```sh
castloop operation-list --show my-show --incomplete
castloop operation-status upload UPLOAD_OPERATION_UUID --show my-show --remote
castloop operation-status rss-import IMPORT_UUID --show my-show --remote
castloop operation-list --show my-show --parent IMPORT_UUID
```

結果はJSONで表示する。`operation`に対象・現在状態・処理段階、`assets`に素材ごとの保存・検証結果、`requests`に要求元クライアントと受信時刻、`events`に状態の履歴が入る。

RSSの詳細には、公開済みエピソード件数、子操作の状態別件数、直近5操作も表示する。未着手の予定一覧はサーバーへ保存していないため、`unstarted_episode_count`は`null`（不明）とする。集計は利用者のRSS状態確認で行い、各処理段階の更新要求では全子操作を数え直さない。

`operation-list`は1ページ20件。`next_cursor`があれば、`--cursor UUID`で続きを取得する。RSS取り込みの子操作は`--parent IMPORT_UUID`で絞り込める。

詳細の要求と履歴もそれぞれ20件ずつ取得する。`next_event_version`を`--after-version N`へ、`next_request_cursor`を`--request-cursor UUID`へ渡すと続きを読める。

```sh
castloop operation-status upload UPLOAD_OPERATION_UUID --local
castloop operation-list --local --incomplete
```

`--local`は通信や認証情報を必要とせず、手元の記録だけを読む。旧形式の記録と残存ロックも確認できる。`--remote`は既定値で、管理キーを使ってサーバーへGETする。どちらもローカルの記録・ロック・クライアントIDや、サーバーの操作記録を変更しない。

主な素材の状態は次のとおり。

| `upload_state` | 意味 | 次の判断 |
| --- | --- | --- |
| `prepared` | 保存先と入力を登録済み | 未送信なら送信を開始できる |
| `put_requested` | PUTの開始を許可済み | 手元の成功応答を確認する。応答がなければ保留する |
| `put_acknowledged` | PUT成功のETagとversionを保存済み | 保存済みファイルの検証から再開できる |
| `verified` | 全量のサイズ・ハッシュと識別情報を照合済み | 同じ下書きへの登録を続けられる |
| `attached` | 下書きへ登録済み | 明示的な公開を待つ |

アップロード作業の`succeeded`は下書きへの登録完了を表し、公開完了とは異なる。公開作業は`job_id`と同じ操作IDを持ち、`succeeded`になった時点でその公開が完了する。

## アップロードを再開する

```sh
castloop operation-resume upload UPLOAD_OPERATION_UUID --show my-show
```

元の作業ディレクトリ、サービス設定、Worker、受付window、下書きの対象・公開済み版、入力ファイルを照合して続行する。Cloudflareの認証情報も必要になる。

- PUTの成功応答が保存されていれば、同じR2 objectを読み戻して検証する。PUTは行わない。
- 検証済みなら、その結果を使って下書きへの登録を完了する。
- 状態報告や下書き登録の応答を失った場合は、保存した要求IDの結果をGETで照合する。
- 未着手の素材が残っていれば、その素材だけを初めて送信する。

成功応答のない`put_requested`、結果を確認できない変更要求、変更された入力は保留する。R2にファイルがないことだけではPUTを再送しない。

新規の下書き・アップロード・RSS記録は形式番号2を使う。変更中はローカルSQLiteの`BEGIN EXCLUSIVE`で排他し、プロセス終了時にOSがロックを解放する。`.lock.sqlite`は排他用のファイルであり、残っていても実行中とは限らない。旧形式の`.lock`は保持する。既存の下書き形式1や未知の旧記録を形式2へ変換しない。

## RSS取り込みを続ける

```sh
castloop operation-status rss-import IMPORT_UUID --show my-show --remote
castloop operation-list --show my-show --parent IMPORT_UUID
castloop publish-rss-import /path/to/reviewed-import
```

新形式では、取り込み全体を親操作とし、アップロード、公開、登録・ローカル配置の処理を子操作として記録する。再実行は完了済みの公開を再送せず、保存済みの公開要求の照会、成功応答のあるアップロードの検証、完了確認済みの配置結果から続行する。元のGUID・公開日時・音源の識別情報を維持する。

登録やローカル配置の途中で結果が分からなくなった場合は、その処理を保持して停止する。取り込み元と`.castloop/`はそのまま残す。

## 取り消しと未公開素材の削除

まず操作を取り消す。取消自体はファイルを削除しない。

```sh
castloop operation-cancel upload UPLOAD_OPERATION_UUID --show my-show
castloop operation-cleanup-preview upload UPLOAD_OPERATION_UUID --show my-show
```

プレビューの対象キー、サイズ、ETag、versionと`plan_sha256`を確認してから実行する。

```sh
castloop operation-cleanup upload UPLOAD_OPERATION_UUID PLAN_SHA256 confirm --show my-show
castloop operation-status cleanup CLEANUP_OPERATION_UUID --show my-show
```

削除できるのは、登録された一意のstaging keyのうち、PUT成功が分かり、その下書きIDで公開要求を受け付けていない素材である。サーバーが対象の確定と利用禁止を同じSQLiteトランザクションで保存し、R2の識別情報を再照合して削除する。プレビュー後に条件が変わった場合は実行しない。

削除結果はファイルごとに`deleted`または`unknown`として残る。完了を確認できない場合は後続の削除を停止し、同じ削除要求を再送しない。操作IDと要求IDは送信前にも表示する。

RSS全体は、実行中・保留中の子操作がない場合に`operation-cancel rss-import IMPORT_UUID --show my-show`で取り消せる。公開済みのエピソード、改訂履歴、元のTOML・カバー・MP3は残る。公開済みShow/Episodeの物理削除とは別の機能である。

## 容量を確認する

`operation-list`と詳細の`capacity`には、対象Show DO内のDB全体の使用量を表示する。他Show・制御DO・アカウント合計の使用量ではない。

- `database_bytes`：Cloudflareの`databaseSize`。操作記録以外のSQLデータも含む。
- `warning`：1GBを計画上限として、50%で`half`、70%で`high`、85%で`critical`。
- `account_daily_usage`：現状は`unknown`。この機能だけでアカウント全体の日次残量は判断しない。

85%以上では、大量取り込みの開始前に「予定操作数×20KB＋コンテンツ増分の概算＋10MBの余裕」を確認し、1GBを超える見込みなら開始しない。進行中の操作の結果保存には、この事前制限を適用しない。

操作・要求・成功応答・必要な履歴は保持する。自動期限削除や記録表全体の整理は行わない。通常運用の見積もりと、将来整理できる情報の考え方は[保存先と費用の設計](../design/archive/sqlite_operation_record_storage_options.md)を参照する。

## 確認済みの範囲

ローカルSQL、模擬R2/REST、CLI entrypoint、Linuxプロセスの強制終了を確認した。加えて、[小規模なCloudflare実機試験](../design/archive/sqlite_operation_records_live_verification_20261019.md)で、正常公開、PUT成功保存後のSIGKILLからの検証再開、成功応答保存前のSIGKILLでの再送拒否を確認した。実機性能・日次課金行数・大容量処理の保証とは区別する。実環境への配備・公開・削除は対象を明示して承認を受けてから行う。
