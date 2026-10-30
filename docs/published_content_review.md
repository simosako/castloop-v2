# 公開内容の差分確認と過去版の採用

v0.8.0・サービス設定version 2 / `show-v1`、内部queue/content形式14/13の新規環境向け。旧形式の変換やR2履歴の事後採用は行わない。

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

previewはupload・公開・journal作成を行わない。初期化済みworkspaceでは既定でremoteを読み、`--local`では通信せず未確認を表示する。取得失敗を差分なしにしない。`--expect-preview`はローカル入力、サービス設定、対象と確認済みの更新元revision・世代等を照合する。廃止された受付windowやWorker版の一致は要求しない。変更後は再previewするが、既に同じ内容が公開済みなら変更なしで返せる。hash自体は管理者承認の証明ではない。

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

`lifecycle restore`は非公開から最新保存内容に戻す操作で、任意revisionの採用とは異なる。原本TOMLはどちらも自動編集しない。

## 編集元の書出し

```sh
castloop sync-local-metadata --workspace /path/to/service --show daily --episode first \
  --expect-revision CURRENT_REVISION_UUID --output /new/path/reviewed-episode.toml --json
```

現在revisionを照合し、TOMLだけ新規出力する。既存ファイルを上書きせず、素材・秘密・journalを再構築しない。

全文取得は8MiBの読取予算を超えればエラーとし、切り詰めない。本文・所有者メール等を診断へ保存しない。ローカル試験はnative性能やFree適合を証明しない。
