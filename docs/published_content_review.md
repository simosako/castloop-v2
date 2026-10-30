# 公開内容の差分確認と過去版の採用

公開前に現在内容と編集内容を比較し、必要に応じてRSSをローカルで確認します。保存済みの過去版を採用する手順も扱います。基本操作は[公開・更新](publishing.md)、対応条件は[利用ガイド](README.md#対象と用語)を参照してください。

## 公開前の比較

```sh
castloop preview-episode first audio.mp3 --workspace /path/to/service --show daily --remote --json
castloop publish-episode first audio.mp3 --workspace /path/to/service --show daily --expect-preview REVIEWED_HASH --json
```

MP3省略時は公開済み音声を再利用する。初回公開にはMP3が必要。Showには`preview-show SHOW`／`publish-show SHOW`を使う。

- `published`：サーバーの確定全文・revision・素材identity。非公開保存中でも管理者は読める。
- `local`：手元のTOML/CSSと指定素材。
- `changes.metadata_fields`：項目別差分。音源は`reuse_published`／`replace_audio`／`missing_required`。公開済みと同じ内容の画像・音源を指定した場合も既存参照を再利用し、R2へのアップロードは行わない。
- `unchanged`：metadata・素材・公開状態が現在値と同じ。履歴・世代・パージを増やさない。
- identity変更や公開済み画像拡張子の変更は`changed_invalid`となり公開できない。

プレビューはアップロード・公開・操作記録の作成を行いません。既定では `.castloop/` があればリモートを読み、なければローカルだけを確認します。`--local` は通信せず、公開済み内容を未確認と表示します。管理キーの欠落や照会失敗を「差分なし」とは扱いません。

出力の `input_fingerprint` を確認し、公開時の `--expect-preview` へ渡します。入力・対象・設定・更新元を照合するため、変更後は再プレビューします。既に同じ内容が公開済みなら変更なしです。ハッシュ自体は管理者承認の証明ではありません。

## RSSと素材の確認

`preview-* --rss-output NEW_FILE`は認証付きで世代固定の公開一覧を読み、本番と同じrendererでローカルXMLを生成する。既存ファイルは上書きせず、公開もしない。音声差替え・初回の音源URLは確認用仮UUIDを含み、実際のURLは公開時にサーバーが発行する。画像・音源は`verification_paths`のローカル原本で確認する。未公開素材の一時公開URLは作らない。

## 履歴の閲覧と採用

```sh
castloop list-show-revisions daily --workspace /path/to/service --json
castloop list-episode-revisions first --workspace /path/to/service --show daily --json
castloop preview-episode-revision first SAVED_REVISION_UUID --workspace /path/to/service --show daily > /path/to/service/revision-plan.json
castloop revision-execute revision-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/service --json
```

一覧は新しい順に最大20件で、`next_cursor`を`--cursor`へ渡す。Showには`preview-show-revision`を使う。previewの現在版・選択版の全文、差分、素材、公開状態を確認する。計画ファイルの相対パスはworkspace基準で、`--output`／`--rss-output`は呼出元cwd基準。

実行は選択したmetadata・保存済み素材参照を採用し、必要なパージ後に一括確定する。同じ内容と公開状態なら`unchanged`、変更時は新しいrevisionになる。GUID・日時・旧音源・履歴を保持し、Showの採用でEpisode一覧や個別非公開を巻き戻さない。Episodeの採用には親Showの公開が必要。応答不明時も同じ計画を実行でき、既に同じ状態なら変更なしになる。

[公開状態の復元](lifecycle.md)は非公開から最新保存内容に戻す操作で、任意リビジョンの採用とは異なります。原本TOMLはどちらも自動編集しません。

## 編集元の書出し

```sh
castloop sync-local-metadata --workspace /path/to/service --show daily --episode first \
  --expect-revision CURRENT_REVISION_UUID --output /new/path/reviewed-episode.toml --json
```

現在revisionを照合し、TOMLだけ新規出力する。既存ファイルを上書きせず、素材・秘密・journalを再構築しない。

全文取得は8 MiBの読取予算を超えればエラーとし、切り詰めません。取得した本文・所有者メール等を診断記録へ保存しないでください。応答不明時の確認は[診断ガイド](troubleshooting.md)を参照してください。
