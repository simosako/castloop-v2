# 管理用設定と予約公開

Issue #65の開発版。任意の管理用タイムゾーン設定、オフライン日時変換、future UTCの予約登録・実行を提供する。予約実行日時は`published_at`とは別で、既存の`published_at`に未来日時を書いただけでは公開を遅らせない。予約にはstage済みdraft、明示承認hash、openなShowが必要。Issue #70との統合版はfresh環境専用の内部queue/content形式**11/11**を使う。旧9/9・10/11等のDBは変換しない。

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

予約はstage済みのShow／Episode draftを対象にする。先に通常の`update-show`／`update-episode`／`update-episode-audio`で素材を保存し、予約previewで対象・素材hash・公開済みbase・現地日時・UTC・承認hashを確認する。

```sh
# Episode（--showが必要）
castloop preview-episode-schedule first --workspace /path/to/workspace --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-episode first --workspace /path/to/workspace --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo \
  --expect-preview REVIEWED_HASH --json

# Show
castloop preview-show-schedule daily --workspace /path/to/workspace --at 2026-11-01T09:00:00 --json
castloop schedule-show daily --workspace /path/to/workspace --at 2026-11-01T09:00:00 \
  --expect-preview REVIEWED_HASH --json
```

予約受付は`accepted`／`scheduled`であり、公開成功ではない。CLIはschedule IDを返して終了し、端末を起動したままにする必要はない。サーバーはShow内の予約表へ保存し、時刻到来までFIFOへ入れない。遠い未来の予約が通常公開を待たせない。

```sh
castloop schedule-list daily --workspace /path/to/workspace --json
castloop schedule-status daily SCHEDULE_UUID --workspace /path/to/workspace --json
```

`state`は予約の状態、`publication_state`は対応する公開jobの状態を表す。`scheduled`は未投入、`dispatched`はFIFO投入済みで公開成功ではない。公開完了は`publication_state="succeeded"`で確認する。

- `preview-schedule-reschedule SHOW SCHEDULE_ID --at DATETIME`で新しい日時の承認hashを得て、`schedule-reschedule SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH`でFIFO投入前だけ日時を変更する。内容は変えない。
- `preview-schedule-cancel SHOW SCHEDULE_ID`で承認hashを得て、`schedule-cancel SHOW SCHEDULE_ID --expect-version N --expect-preview HASH`でFIFO投入前だけ取消す。投入済みjobは取消さず、素材も自動削除しない。
- `preview-schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N`で現在のdraft・runtime・baseを再確認し、`schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH`で再承認する。
- Pause、受付停止、保守準備、runtime／config変更、Show／Episode base変更では未投入予約を`needs_approval`へ移す。Resumeや保守解除だけでは再開しない。現在の条件でdraftを再度previewし、`schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH`で明示再承認する。
- 予約中は同じdraftの再upload、即時publish、upload取消・cleanupを拒否する。取消後も素材は自動削除しない。
- 予約実行が遅延しても`published_at`を書き換えない。予定時刻は「実行を開始してよい最早時刻」であり、その瞬間の公開完了や最大遅延を保証しない。

隔離したfresh Cloudflare環境で3 Episodeを予約し、各予定前のFeed未配信と予定後の配信、`publication_state=succeeded`を確認した。Pause/再承認・取消・Alarm再配送・実Cache purge・性能は未確認である。ローカル試験とmemory R2の成功を、未確認経路の実機証拠にしない。採用設計と未確認範囲は[予約公開計画](../design/episode_scheduled_publication_plan.md)と[実機検証](../design/issue65_scheduled_publication_live_20261026.md)を参照。
