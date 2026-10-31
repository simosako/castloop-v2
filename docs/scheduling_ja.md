# 予約公開

番組やエピソードの内容を、指定した日時に公開できます。公開するファイルを準備し、日時と内容をプレビューしてから予約します。

以下の日時は例です。実行時には、希望する未来の日時に置き換えてください。

## 任意の管理用設定

日本時間で予約を入力する場合は、ワークスペース直下に `castloop-admin.toml` を作成します。

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

この設定を使うと、時差の記載がない日時を日本時間として扱います。既定はUTCです。コマンドごとに指定する場合は `--timezone Asia/Tokyo` を使えます。

## 1. 公開する内容と日時を確認する

[通常の公開](publishing_ja.md)と同じようにTOMLと素材を準備します。エピソードを初めて公開する場合はMP3を用意し、親の番組を公開しておきます。

次の例は、エピソード `first` を日本時間の2026年12月1日9時に公開する予約です。

```sh
castloop preview-episode-schedule first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --json
```

プレビューで内容、素材、現地日時、UTCでの日時を確認し、`approval_sha256` をコピーします。公開済み音声を使う更新では、MP3の指定を省略できます。

日時の解釈だけを先に確認したい場合は、次を実行してください。

```sh
castloop preview-schedule-time 2026-12-01T09:00:00 --workspace /path/to/workspace --timezone Asia/Tokyo --json
```

## 2. 予約する

確認した `approval_sha256` を `REVIEWED_HASH` に入れます。内容、素材、日時はプレビュー時と同じ値を指定してください。

```sh
castloop schedule-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH --json
```

結果の予約ID（`schedule_id`）を控えます。予約にはこの時点の内容が保存されます。予約後にTOMLを編集しても、予約済みの内容はそのままです。

番組情報を予約する場合も、プレビューしてから実行します。番組のプレビューで得た `approval_sha256` を使ってください。

```sh
castloop preview-show-schedule my-show --workspace /path/to/workspace --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-show my-show --workspace /path/to/workspace --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH --json
```

## 3. 実行結果を確認する

```sh
castloop schedule-list my-show --workspace /path/to/workspace --json
castloop schedule-status my-show SCHEDULE_UUID --workspace /path/to/workspace --json
```

`SCHEDULE_UUID` は予約IDに置き換えます。

| 状態 | 意味・操作 |
| --- | --- |
| `scheduled` | 予約済み。指定日時以降にサーバーが公開を実行します |
| `dispatched` | 公開済み。`revision_id` と番組サイトで内容を確認します |
| `needs_approval` | 設定や公開内容の変更により、再確認が必要です。下の再承認手順へ進みます |

予約後の処理はサーバーが行います。予定時刻を過ぎたら、`schedule-status` で結果を確認してください。

## 予約日時を変更する

1. プレビューで現在の予約と新しい日時を確認します。
2. 出力の `schedule.version` を `N`、`approval_sha256` を `REVIEWED_HASH` に入れて実行します。

```sh
castloop preview-schedule-reschedule my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-reschedule my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --expect-preview REVIEWED_HASH --json
```

## 予約を取り消す

プレビューで対象を確認し、同様に版番号とハッシュを使って取り消します。

```sh
castloop preview-schedule-cancel my-show SCHEDULE_UUID --workspace /path/to/workspace --json
castloop schedule-cancel my-show SCHEDULE_UUID --workspace /path/to/workspace --expect-version N --expect-preview REVIEWED_HASH --json
```

## 再確認が必要な予約を承認する

独自ドメインや公開内容を変更すると、予約が `needs_approval` になることがあります。

1. `schedule-status` で理由と現在の `schedule.version` を確認します。
2. その版番号を `N` に入れ、今後の実行日時を指定してプレビューします。
3. 保存されている内容と日時を確認し、`approval_sha256` を使って再承認します。

```sh
castloop preview-schedule-reapprove my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --json
castloop schedule-reapprove my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --expect-preview REVIEWED_HASH --json
```

再承認では、予約に保存されている内容を使います。内容も変更したい場合は、元の予約を取り消してから、編集した内容で予約し直してください。

## 日時を入力するときのポイント

- `2026-12-01T09:00:00` のように、日付と時刻を `T` でつなぎます。
- `2026-12-01T09:00:00+09:00` のように時差を書くこともできます。`--timezone` も指定する場合は、その地域の時差と合わせます。
- 夏時間の切り替わりで同じ時刻が2回ある場合は、意図する時差も指定します。
- エピソードの `published_at` はRSSに記載する日時です。公開を開始する日時は `--at` で指定します。
- 未来の `published_at` を付けて今すぐ公開したい場合は、通常の公開で確認に答えます。`--json` で実行する場合は `--allow-future-published-at` を付けます。

番組サイトの日付表示は、[サイトのタイムゾーン](show_website_ja.md#公開日表示のタイムゾーン)で設定します。
