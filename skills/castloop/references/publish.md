# 追加・更新・公開

この開発版は新規13/13環境向け。旧形式を変換・採用しない。実行前に対応CLIと対象workspaceを確認する。

## 通常公開

1. 対象Showが公開済み・openか`show-status`で確認する。通常編集のたびにPause/Resume/deployしない。
2. `create-episode ID --workspace PATH --show SHOW --non-interactive --json`で手元の雛形を作る。GUIDを保持し、管理者が確認した内容・日時でTOMLを編集する。
3. `validate episode ABSOLUTE_TOML --audio ABSOLUTE_MP3 --json`で検証する。音声上限は300,000,000 bytes。
4. `preview-episode ID MP3 --workspace PATH --show SHOW --remote --json`でmetadata・素材・更新元を確認し、内容と`input_fingerprint`の承認を得る。
5. `publish-episode ID MP3 --workspace PATH --show SHOW --expect-preview HASH --non-interactive --json`で明示公開する。`changed`／`unchanged`とrevisionが確定結果。

MP3省略時は公開済み音声を再利用する。初回は必須。metadata-onlyはTOML編集後にMP3を省略し、audio-onlyはTOMLを変えず新MP3を指定する。公開済みと同じ内容の画像・音源を指定した場合も再アップロードしない。事前`update-*`・ステージング・job照会はない。同じ内容は履歴・世代・パージを増やさない。

Showは`preview-show SHOW`→承認→`publish-show SHOW --expect-preview HASH`。TOML・CSS・カバーを使い、公開済み画像の拡張子は変えない。GUID・日時・permalink意味を通常更新で変更しない。

previewは通信による現在内容の確認だけでupload・journal・lockを作らない。`--local`ではremote未確認を明示する。入力・更新元が変わったら再確認するが、既に同じ内容が公開済みなら変更なしで返せる。hashそのものは承認を証明しない。

`preview-* --rss-output NEW_FILE`は予定RSSをローカル生成し、既存ファイルを上書きしない。新しい音源URLは確認用の仮UUIDであり、実URLは公開時に発行される。素材は手元で確認し、一時公開URLを作らない。

未来の`published_at`でも即時公開する。非対話では`--allow-future-published-at`が必要。予約は次の専用操作を使う。

## 予約公開

- `preview-episode-schedule ID [MP3] --workspace PATH --show SHOW --at DATETIME [--timezone ZONE] --json`で確認し、`schedule-episode`に同じ引数と`--expect-preview APPROVAL_HASH`を渡す。Showには`preview-show-schedule`／`schedule-show`を使う。
- CLIが素材を配置し、metadataと具体的な素材参照を予約へ保存する。`scheduled`は受付、`dispatched`とrevisionは公開確定。端末を待機させる必要はない。
- `schedule-list SHOW`／`schedule-status SHOW UUID`で確認する。作成応答が不明なら一覧を読み、新規予約を無条件に再作成しない。
- 日時変更は`preview-schedule-reschedule`→`schedule-reschedule`、取消は`preview-schedule-cancel`→`schedule-cancel`。未実行の予約だけを扱い、version・hashを照合する。
- Pause等の`needs_approval`は、`preview-schedule-reapprove`→`schedule-reapprove`で明示再承認する。保存済みmetadata・素材を保持し、手元の未承認編集を採用しない。Resumeだけでは再開しない。
- 予約日時とRSSの`published_at`は独立。日時変換だけなら`preview-schedule-time`を使う。任意の`castloop-admin.toml`のtimezoneはCLIの日時解釈に使い、未設定はUTC。

## 履歴・統計

`list-show-revisions`／`list-episode-revisions`の`next_cursor`を追い、`preview-*-revision`で現在版と保存版を確認する。承認した計画を`revision-execute FILE HASH confirm`へ渡す。素材を再uploadせず採用し、同じ内容・状態なら変更なし。Show採用はEpisode履歴・個別非公開を巻き戻さない。手元TOMLも自動編集しない。

必要なら`sync-local-metadata --show SHOW [--episode ID] --expect-revision UUID --output NEW_FILE`で新規書出しする。原本を上書きしない。

`stats SHOW [--episode ID] --json`は配信統計の読取。未計測・保持期限切れを0とせず、カウンタを聴取人数と解釈しない。`stats-retention`は別の変更操作として承認する。
