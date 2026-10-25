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

`input_fingerprint`は承認を証明する署名ではない。実行時のbase/lifecycle照合も必要。Issue #64対応版のpreviewは既定で認証付きremote読取を行い、公開中/local/stagedの差分と素材再利用を表示する。`--local`または未初期化workspaceでは公開済み内容を`not_checked`とし、取得失敗を差分なしへ変換しない。確認後のruntime/window/base/Feed世代変更でも再previewする。

`preview-* --rss-output NEW_FILE`は同じrendererで予定RSSをローカル生成する。既存ファイルは上書きせず、R2へ保存しない。画像・音源は手元で確認し、未公開素材の一時公開URLを作らない。

## 過去版の採用（Issue #64対応版）

- `describe`/helpで対応を確認する。内部7/8の新規環境専用。旧形式の変換や履歴の事後採用を行わない。
- `list-show-revisions SHOW` / `list-episode-revisions ID --show SHOW`で履歴を確認する。`next_cursor`を追い、一覧要約を全文へ逆変換しない。
- `preview-show-revision SHOW REVISION_UUID` / `preview-episode-revision ID REVISION_UUID --show SHOW`で現在版と選択版の全文・差分・素材identityを確認する。`--workspace`を明示する。
- 誤編集前へ戻す対象と内容・公開状態になることの承認を得た後だけ、保存したpreview JSONを`revision-execute PLAN_JSON REQUEST_SHA256 confirm`へ渡す。既存`lifecycle restore`は非公開からの最新snapshot復帰で、任意revision採用とは別である。
- 選択した素材を再uploadせず、新しいrevisionを作る。Show採用でもEpisode履歴や個別非公開は巻き戻さない。未完了draftやblockedを削除して迂回しない。原本TOMLは自動編集されない。
- 応答不明は同じjobのGET照会だけを行う。queuedや404を成功・未実行と推測しない。jobの`succeeded`を確認する。
- 編集元が必要なら`sync-local-metadata --show SHOW [--episode ID] --expect-revision CURRENT_UUID --output NEW_FILE`で新規書出しする。既存TOML・画像・音源・journalを上書き・再構築しない。

## 開発版の日時preview

`preview-schedule-time DATETIME --workspace PATH [--timezone IANA_ZONE] --json`はローカルの日時変換のみ。upload・予約・公開・サーバー時刻／readinessの検証は行わない。任意の`castloop-admin.toml`は`schema_version = 1`と`timezone`を受け付け、未指定ならサーバー基準UTCを使う。明示offsetが絶対時刻を決め、併用した`--timezone`はそのoffsetと一致する必要がある。存在しない／二重となるDST日時を勝手に解決しない。サーバー予約は未実装であり、未来の`published_at`も即時公開を遅らせない。このpreviewを予約受付・公開承認の証拠にしない。
