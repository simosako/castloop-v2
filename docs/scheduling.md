# 予約公開と日時の設定

Show・Episodeを指定日時に公開する手順です。**予約実行日時と、RSSの `published_at` は別です。** 予約には編集元、確認したプレビューのハッシュ、稼働準備完了（`publication_ready`）のShowが必要です。対応条件は[利用ガイド](README.md#対象と用語)を参照してください。

## 任意の管理用設定

サービスワークスペース直下に `castloop-admin.toml` を置きます。

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

ファイルも `timezone` も省略でき、その場合はUTCを使います。管理者PCやエッジの所在地からは推測しません。Showディレクトリでなくワークスペースから実行するか、`--workspace` を明示してください。

このファイルはCLIの表示・日時入力用設定で、サービスの設定・配備・保存済みの公開日時を変えません。`castloop.toml` の代わりではなく、初期化時にも自動作成しません。

番組サイトの公開日表示は別のShow設定`site_timezone`で指定する。この管理用`timezone`を変更してもサイトの表示は変わらない。[番組サイトのタイムゾーン設定](show_website.md#公開日表示のタイムゾーン)を参照する。

対応項目は `schema_version` と `timezone` だけです。アカウント・公開URL・バケットは `castloop.toml`、管理キー・操作記録は `.castloop/`、Cloudflare APIトークンは環境変数で管理します。

設定はUTF-8の通常ファイルで、1〜16,384 bytesです。リンク・未知のキーや版・不正なタイムゾーンは拒否し、黙ってUTCには切り替えません。

```sh
castloop template admin-config
castloop schema admin-config
castloop validate admin-config /path/to/workspace/castloop-admin.toml --json
castloop doctor --workspace /path/to/workspace --local --json
```

`template` は標準出力へ雛形を出すだけで、ファイルを書き換えません。`doctor` は設定がなければ「UTC既定」、不正なら失敗として報告します。`validate` と `doctor` は通信・修復・管理キーや記録の生成を行いません。

## 日時だけを確認する

```sh
castloop preview-schedule-time 2026-11-01T09:00:00 \
  --workspace /path/to/workspace --timezone Asia/Tokyo --json
```

日時の解釈と表示の規則:

1. `Z` や `+09:00`（UTCからの時差）があれば、それが絶対時刻を決めます。
2. 時差の指定がなければ、`--timezone` → 管理用設定 → UTCの順に解釈します。
3. 時差と `--timezone` を併用した場合、その地域・日時の時差と一致しなければ拒否します。`Z` も例外ではありません。
4. 管理用設定のタイムゾーンは表示に使いますが、入力に明記した時差が決める絶対時刻は変えません。
5. `UTC` または `Asia/Tokyo`、`America/New_York` 等のIANA地域名を使います。`JST`・`CST` 等の略称は使えません。

日付と時刻を`YYYY-MM-DDTHH:mm[:ss]`で指定する。小数秒、自然言語、相対時刻、日時注釈、うるう秒、未知offsetを意味する`-00:00`は受け付けない。存在しない日付を自動補正しない。

夏時間開始で存在しない現地日時、終了時に二重となる現地日時は拒否する。二重日時では、例えば`2026-11-01T01:30:00-04:00 --timezone America/New_York`のように意図したoffsetを指定する。

出力では、UTCの `scheduled_at`、現地日時の `local_datetime`、時差、解釈元を分けて確認できます。予約は確定したUTCを保存し、後からタイムゾーン設定を変えても再計算しません。

**このpreviewは変換の確認だけであり、予約・upload・公開・サーバー通信は行わない。** サービス設定や鍵のない場所でも使える。過去日時の変換も可能で、`server_time_checked=false`、`publication_ready=false`を返す。

## 予約公開

予約プレビューでTOML・素材・公開済みの更新元・現地日時・UTCを確認します。実行例の `REVIEWED_HASH` は出力の `approval_sha256` に置き換えてください。実行すると必要な素材を配置し、その時点の内容と素材参照を予約へ保存します。MP3指定で音声を更新し、省略時は公開済み音声を使います。初回はMP3が必要です。予約後のローカル編集は予約に反映されません。

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

`scheduled` は受付であり、公開成功ではありません。CLIは予約IDを返して終了し、端末を起動したままにする必要はありません。遠い未来の予約が通常公開を待たせることもありません。作成応答が不明なら一覧で確認し、無条件に再作成しないでください。

```sh
castloop schedule-list daily --workspace /path/to/workspace --json
castloop schedule-status daily SCHEDULE_UUID --workspace /path/to/workspace --json
```

`scheduled` は未実行、`dispatched` は公開確定済みで、その `revision_id` を返します。公開内容と予約の実行済み状態は同時に確定します。

## 予約の変更・取消・再承認

いずれも先にプレビューし、確認した `approval_sha256` を `--expect-preview HASH`、予約の版を `--expect-version N` に渡します。例はサービスワークスペースでの構文です。別の場所では `--workspace` を指定してください。

| 操作 | プレビュー | 実行 |
| --- | --- | --- |
| 日時だけ変更 | `preview-schedule-reschedule SHOW SCHEDULE_ID --at DATETIME` | `schedule-reschedule SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH` |
| 取消 | `preview-schedule-cancel SHOW SCHEDULE_ID` | `schedule-cancel SHOW SCHEDULE_ID --expect-version N --expect-preview HASH` |
| 再承認 | `preview-schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N` | `schedule-reapprove SHOW SCHEDULE_ID --at DATETIME --expect-version N --expect-preview HASH` |

再承認は予約済み内容と素材を保持し、現在の設定・更新元・日時だけを再確認します。手元の編集を暗黙に採用しません。取消で素材を自動削除することもありません。

- 独自ドメイン変更（`domain_change`）や更新元の競合（`base_conflict`）では `needs_approval` となり、再承認が必要です。通常のWorkerコード配備は予約を維持します。
- 未実行予約は対象ごとに1件です。即時公開が予約と競合した場合も、古い予約には再承認が必要です。
- 予定時刻は「実行を開始してよい最早時刻」です。その瞬間の公開完了や最大遅延は保証せず、遅延しても `published_at` は書き換えません。

## 未来の`published_at`で即時公開する場合

`published_at`はRSS上の日時であり、予約実行時刻ではない。未来の`published_at`を持つEpisodeでも`publish-episode`は即時公開する。

- `preview-episode`は`warnings`に`code=future_published_at`を返す。予約previewにも同じ警告が含まれるが、予約の実行時刻は`schedule`の値で決まる。
- 非対話（`--json`または`--non-interactive`）の`publish-episode`は、`--allow-future-published-at`がなければ送信前に`future_published_at`で失敗する。JSONの`outcome`は`not_started`。
- 対話時は`publish now`の入力を求める。通常の承認hashや`--expect-preview`をこの確認の代用にしない。
- 既に同じ内容が公開済みの場合は、即時公開確認を繰り返さず変更なしで返す。
- `publish-rss-import`はfuture日時のEpisodeを1件でも含む場合、同じ`--allow-future-published-at`を要求する。一括公開の途中で止まらないよう、開始前に拒否する。
- 予約公開を使う場合は`preview-episode-schedule`／`schedule-episode`を使う。予約実行日時は`published_at`と独立で、予約は`published_at`を書き換えない。

予約の実行時刻と結果は必ず `schedule-status` で確認してください。現行版の限定的な実機確認は予約公開を含みません。[検証範囲](../design/testing.md#実機検証と証明できる範囲)は、通常の公開確認と区別しています。
