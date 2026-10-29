# 管理用設定と予約公開

フェーズ3開発版。任意の管理用タイムゾーン設定、オフライン日時変換、UTCでの予約登録・実行を提供する。予約実行日時は`published_at`とは別。予約にはローカル入力、明示承認hash、稼働準備完了（`publication_ready`）のShowが必要。新規環境専用の内部queue/content形式**14/13**を使い、旧形式は変換しない。

## 任意の管理用設定

サービスworkspace直下に`castloop-admin.toml`を置く。

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

ファイルも`timezone`も省略でき、その場合はサーバー基準UTCを使う。Cloudflare Workersの本番runtimeはUTCであり、管理者PCのOSのタイムゾーンやエッジの所在地から推測しない。コマンドをShow directoryでなくworkspaceから実行するか、明示的に`--workspace`を指定する。

このファイルは秘密・操作対象・公開承認を持たないCLI設定であり、`castloop.toml`の代わりではない。サービスhash・配備・既存の公開日時を変更しない。初期化時の自動作成や既存設定の移動も行わない。

番組サイトの公開日表示は別のShow設定`site_timezone`で指定する。この管理用`timezone`を変更してもサイトの表示は変わらない。[番組サイトのタイムゾーン設定](show_website.md#公開日表示のタイムゾーン)を参照する。

初版の対応項目は`schema_version`と`timezone`だけ。account・origin・bucketは`castloop.toml`、管理鍵・client ID・journalは`.castloop/`、Cloudflare tokenは既存の環境変数に残す。通信／待機上限、既定Show、承認や`--json`等の出力契約をここへ移さない。

設定は通常ファイル・1〜16,384 bytes・UTF-8に限定する。symlink、FIFO、未知key、未知version、不正zoneは拒否し、UTCへ黙ってfallbackしない。`init`もtemplateコマンドも既存ファイルを上書きしない。

```sh
castloop template admin-config
castloop schema admin-config
castloop validate admin-config /path/to/workspace/castloop-admin.toml --json
castloop doctor --workspace /path/to/workspace --local --json
```

templateはstdoutへ雛形を出すだけ。存在しない設定に対するdoctorは「UTC既定」、不正な設定はfailとする。`validate`とdoctorは通信・修復・鍵やjournalの生成を行わない。

## 公開しない日時preview

```sh
castloop preview-schedule-time 2026-11-01T09:00:00 \
  --workspace /path/to/workspace --timezone Asia/Tokyo --json
```

日時の解釈と表示の規則:

1. 入力に`Z`や`+09:00`があれば、それが絶対時刻を決める。
2. offsetなしの場合は、`--timezone`→管理用設定→UTCの順。
3. 明示offsetと`--timezone`を併用した場合、そのzoneの当該日時のoffsetと一致しなければ拒否する。`Z`でもこの照合を省略しない。
4. 設定zoneは表示に使うが、入力offsetの絶対時刻を動かさない。入力offset、解釈元、表示zoneとその出所を別fieldで返す。
5. `UTC`または`Asia/Tokyo`、`America/New_York`等の対応IANA名を指定する。`JST`・`CST`等の略称は拒否する。

日付と時刻を`YYYY-MM-DDTHH:mm[:ss]`で指定する。小数秒、自然言語、相対時刻、日時注釈、うるう秒、未知offsetを意味する`-00:00`は受け付けない。存在しない日付を自動補正しない。

夏時間開始で存在しない現地日時、終了時に二重となる現地日時は拒否する。二重日時では、例えば`2026-11-01T01:30:00-04:00 --timezone America/New_York`のように意図したoffsetを指定する。

出力は`scheduled_at`（UTC）、`scheduled_at_ms`、`input`、`input_offset`、`resolution_source`、`timezone`、`timezone_source`、`local_datetime`、表示`offset`を分ける。将来の予約では確定したUTCを保存し、zone設定から再計算しない設計である。

**このpreviewは変換の確認だけであり、予約・upload・公開・サーバー通信は行わない。** サービス設定や鍵のない場所でも使える。過去日時の変換も可能で、`server_time_checked=false`、`publication_ready=false`を返す。

## 予約公開

予約previewでローカルTOML・素材hash・公開済みbase・現地日時・UTC・承認hashを確認する。実行時にCLIが素材を直接配置し、metadata・具体的な素材参照を予約へ保存する。MP3指定で音声更新、省略で公開済み音声を使い、初回はMP3が必要。

```sh
# Episode requires --show.
castloop preview-episode-schedule first audio.mp3 --workspace /path/to/workspace --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-episode first audio.mp3 --workspace /path/to/workspace --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo \
  --expect-preview REVIEWED_HASH --json

# Show
castloop preview-show-schedule daily --workspace /path/to/workspace --at 2026-11-01T09:00:00 --json
castloop schedule-show daily --workspace /path/to/workspace --at 2026-11-01T09:00:00 \
  --expect-preview REVIEWED_HASH --json
```

`scheduled`は受付であり公開成功ではない。CLIはschedule IDを返して終了し、端末を起動したままにする必要はない。Show内の予約表と既存Alarmで実行し、遠い未来の予約が通常公開を待たせない。作成応答が不明なら一覧で確認し、無条件に再作成しない。

```sh
castloop schedule-list daily --workspace /path/to/workspace --json
castloop schedule-status daily SCHEDULE_UUID --workspace /path/to/workspace --json
```

`scheduled`は未実行、`dispatched`は公開確定済みで、その`revision_id`を返す。公開内容と予約の実行済み状態は同じトランザクションで確定する。job台帳や`publication_state`は使わない。

- `preview-schedule-reschedule SHOW SCHEDULE_ID --at DATETIME`→`schedule-reschedule SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH`で未実行予約の日時だけ変更する。
- `preview-schedule-cancel SHOW SCHEDULE_ID`→`schedule-cancel SHOW SCHEDULE_ID --expect-version N --expect-preview HASH`で未実行予約を取消す。素材は自動削除しない。
- `preview-schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N`→`schedule-reapprove ... --expect-preview HASH`で再承認する。予約済みmetadata・素材を保持し、現在の設定・baseと日時だけ再確認する。手元の編集を暗黙に採用しない。
- 独自ドメイン変更（`domain_change`）およびShow／Episodeの更新元競合（`base_conflict`）では予約を`needs_approval`へ移す。通常のWorkerコード更新（`deploy`）では予約はそのまま維持される。
- 対象ごとに未実行予約は1件。即時公開は別の明示操作であり、予約と競合すれば古い予約には再承認が必要になる。
- 予約実行が遅延しても`published_at`を書き換えない。予定時刻は「実行を開始してよい最早時刻」であり、その瞬間の公開完了や最大遅延を保証しない。

## 未来の`published_at`で即時公開する場合

`published_at`はRSS上の日時であり、予約実行時刻ではない。未来の`published_at`を持つEpisodeでも`publish-episode`は即時公開する。

- `preview-episode`は`warnings`に`code=future_published_at`を返す。予約previewにも同じ警告が含まれるが、予約の実行時刻は`schedule`の値で決まる。
- 非対話（`--json`または`--non-interactive`）の`publish-episode`は、`--allow-future-published-at`がなければ送信前に`future_published_at`で失敗する。JSONの`outcome`は`not_started`。
- 対話時は`publish now`の入力を求める。通常の承認hashや`--expect-preview`をこの確認の代用にしない。
- 既に同じ内容が公開済みの場合は、即時公開確認を繰り返さず変更なしで返す。
- `publish-rss-import`はfuture日時のEpisodeを1件でも含む場合、同じ`--allow-future-published-at`を要求する。一括公開の途中で止まらないよう、開始前に拒否する。
- 予約公開を使う場合は`preview-episode-schedule`／`schedule-episode`を使う。予約実行日時は`published_at`と独立で、予約は`published_at`を書き換えない。

現行経路はローカルで予約・停止・再承認・取消・Alarm再配送・公開との原子的確定を検証する。実Cloudflareへの配備・性能は未確認。旧形式の実機記録は[設計索引](../design/README.md)で区別する。
