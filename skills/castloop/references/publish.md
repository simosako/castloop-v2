# エピソード追加・更新と公開

## 新規Episode

1. workspace、Show、未完了操作と`show-status`を確認する。既存Showが公開済み・openであることが前提。毎回Pause/Resume/deployしない。
2. ID、タイトル、説明、日時・タイムゾーン、MP3、任意項目を管理者に確認する。
3. `create-episode ID --workspace PATH --show SHOW --non-interactive --json`。生成済みGUIDを保持してTOMLを編集する。未来日時は予約配信ではない。
4. `validate episode ABSOLUTE_TOML --audio ABSOLUTE_MP3 --json`。MP3は300,000,000 bytes以下。
5. `update-episode ID --workspace PATH --show SHOW --json`と`update-episode-audio ID ABSOLUTE_MP3 --workspace PATH --show SHOW --json`で同じdraftにstageする。まだ公開されない。
6. `preview-episode ID --workspace PATH --show SHOW --json`で対象・metadata・素材hash・base・未stage変更を確認する。`input_fingerprint`と内容について管理者の承認を得る。
7. `publish-episode ID --workspace PATH --show SHOW --expect-preview HASH --json`。承認後の変更は再preview・再確認する。同じjobの`succeeded`が公開完了。queued/runningは待機中。

## 通常更新

- metadata-only: 元TOMLを編集、validate、`update-episode`、preview、明示publish。MP3 uploadは不要。
- audio-only: 元metadataとGUID・日時を保持、MP3検証、`update-episode-audio`、preview、publish。既存音源・revisionは保持する。
- 両方: 両方を同じdraftにstageし、一度publish。
- Show metadata/cover: `update-show`はmetadataと画像を組でstageする。公開済み画像の拡張子変更は不可。`preview-show ID --workspace PATH --json`→承認→`publish-show ... --expect-preview HASH`。

既存GUID・日時・guid_is_permalinkの意味を通常更新で変更しない。identity不一致は確認だけで解除できない。previewが公開済み全文を取得できないと示した場合、差分を推測しない。ローカル原本と管理者のバックアップを使う。

`input_fingerprint`は承認を証明する署名ではない。実行時のbase/lifecycle照合も必要。previewはローカル検査でありremote readinessは保証しない。

## 開発版の日時preview

`preview-schedule-time DATETIME --workspace PATH [--timezone IANA_ZONE] --json`はローカルの日時変換のみ。upload・予約・公開・サーバー時刻／readinessの検証は行わない。任意の`castloop-admin.toml`は`schema_version = 1`と`timezone`を受け付け、未指定ならサーバー基準UTCを使う。明示offsetが絶対時刻を決め、併用した`--timezone`はそのoffsetと一致する必要がある。存在しない／二重となるDST日時を勝手に解決しない。サーバー予約は未実装であり、未来の`published_at`も即時公開を遅らせない。このpreviewを予約受付・公開承認の証拠にしない。
