# 公開内容の確認と過去版の採用

公開前の差分やRSSを確認する方法と、保存されている過去の内容に戻す方法を説明します。

## 公開前の差分を確認する

エピソードを編集したら、次のコマンドで公開中の内容と比較します。

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --json
```

音声も差し替える場合は、`first` の後にMP3の絶対パスを指定します。番組情報を比較する場合は `preview-show my-show` を使います。

主に次の項目を確認してください。

| 項目 | 確認する内容 |
| --- | --- |
| `published` | サーバーに保存されている現在の内容 |
| `local` | 手元で編集した内容 |
| `changes.metadata_fields` | 変更された項目 |
| `assets` | 使用するカバーや音声 |
| `unchanged` | `true` なら公開済みの内容と同じ |

内容が正しければ、`input_fingerprint` を使って[公開](publishing_ja.md)します。入力を修正した場合は、再度プレビューしてください。

## RSSをファイルで確認する

プレビューに `--rss-output` を付けると、変更を反映したRSSを手元に保存できます。保存先には新しいファイル名を指定します。

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --rss-output /path/to/preview.xml --json
```

`preview.xml` を開き、番組情報や各エピソードの記載を確認してください。新しい音声のURLは仮の値です。音声やカバー自体は、プレビューの `verification_paths` に表示された手元のファイルで確認します。

## 履歴の閲覧と採用

### 1. 戻したい版を探す

エピソードの履歴を表示します。

```sh
castloop list-episode-revisions first --workspace /path/to/workspace --show my-show --json
```

番組情報の履歴には `list-show-revisions my-show` を使います。

履歴は新しい順に表示されます。続きがある場合は、結果の `next_cursor` を `--cursor` に指定して次のページを取得してください。

### 2. 過去版との差分を確認する

選んだ版の `revision_id` を `SAVED_REVISION_UUID` に入れ、確認用の計画ファイルを保存します。

```sh
castloop preview-episode-revision first SAVED_REVISION_UUID --workspace /path/to/workspace --show my-show > /path/to/workspace/revision-plan.json
```

番組情報には `preview-show-revision my-show SAVED_REVISION_UUID` を使います。

計画ファイルを開き、現在の内容、採用する過去版、差分、素材を確認します。過去版を採用すると、その内容で公開されます。エピソードを戻す場合は、先に番組を公開状態にしてください。

### 3. 確認した過去版を採用する

計画の `request_sha256` を `REVIEWED_REQUEST_SHA256` に入れます。最後の `confirm` はそのまま入力してください。

```sh
castloop revision-execute revision-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

実行後は[配信確認](troubleshooting_ja.md#verify)を行い、番組サイトでも内容を確認します。採用した内容も履歴から確認できます。

## サーバーの内容をTOMLに書き出す

過去版を採用した後も、手元の編集ファイルは元のままです。サーバーの現在内容を編集元にしたい場合は、現在の `revision_id` を指定して新しいTOMLに書き出します。出力先のフォルダを先に用意してください。

```sh
castloop sync-local-metadata --workspace /path/to/workspace --show my-show --episode first --expect-revision CURRENT_REVISION_UUID --output /path/to/exported-episode.toml --json
```

書き出したTOMLを確認してから、手元の編集ファイルに反映してください。音声やカバーは保管してある原本を使います。
