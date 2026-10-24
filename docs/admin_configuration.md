# 管理用設定と予約日時の変換

Issue #65の開発版で追加するCLI基盤。**現段階では日時変換のみであり、サーバーへの予約登録・予約実行は未提供。** 既存の`published_at`に未来日時を書いても即時公開を遅らせる効果はない。

## 任意の管理用設定

サービスworkspace直下に`castloop-admin.toml`を置く。

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

ファイルも`timezone`も省略でき、その場合はサーバー基準UTCを使う。Cloudflare Workersの本番runtimeはUTCであり、管理者PCのOSのタイムゾーンやエッジの所在地から推測しない。コマンドをShow directoryでなくworkspaceから実行するか、明示的に`--workspace`を指定する。

このファイルは秘密・操作対象・公開承認を持たないCLI設定であり、`castloop.toml`の代わりではない。サービスhash・配備・既存の公開日時を変更しない。初期化時の自動作成や既存設定の移動も行わない。

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

**このpreviewは変換の確認だけであり、予約・upload・公開・サーバー通信は行わない。** サービス設定や鍵のない場所でも使える。過去日時の変換も可能で、`server_time_checked=false`、`publication_ready=false`を返す。今後の予約受付ではサーバー時刻による未来判定、明示承認、素材／base／runtime照合を別途行う。

採用設計と残る開発範囲は[予約公開計画](../design/episode_scheduled_publication_plan.md)を参照。
