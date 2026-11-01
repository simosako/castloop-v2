# 番組・エピソードの公開と更新

公開済みの番組やエピソードは、手元のファイルを編集し、プレビューしてから公開します。新しい番組やエピソードの作成は[初回公開の手順](getting_started_ja.md)を参照してください。

このページでは、ワークスペースを `/path/to/workspace`、番組IDを `my-show`、エピソードIDを `first` とします。コマンドはワークスペースから実行してください。

```sh
cd /path/to/workspace
```

別のディレクトリから実行する場合は、[他のディレクトリから実行する方法](getting_started_ja.md#他のディレクトリから実行する)を参照してください。

## 1. ファイルを編集する

| 変更する内容 | 編集するもの |
| --- | --- |
| 番組名・説明・サイト設定 | `my-show/show.toml` |
| 番組のカバー | `show.toml` の `image_path` で指定した画像 |
| エピソードのタイトル・説明 | `my-show/episode-first.toml` |
| エピソードの音声 | 新しいMP3ファイルを用意 |

公開済みエピソードのGUIDと公開日時は、保存されている値を使います。カバーを差し替える場合は、現在と同じ拡張子の画像を用意してください。

素材の上限は、MP3が300,000,000バイト、JPEG・PNGのカバーが5,000,000バイトです。

## 2. 変更を確認して公開する

対話端末では、変更する内容に合ったコマンドを選んで実行します。

```sh
castloop publish-show my-show --review
castloop publish-episode first --show my-show --review
castloop publish-episode first /path/to/new.mp3 --show my-show --review
```

必要なコマンドを1つだけ実行してください。2番目は公開済みの音声を再利用し、3番目は音声を差し替えます。MP3には絶対パス、または番組ディレクトリからの相対パスを指定できます。

`--review` は、アップロードや公開を行う前に、ワークスペース、サービス、対象、差分、素材のパス、警告を表示します。内容と素材を確認し、公開する場合は `publish` と入力します。取り消す場合はEnterキーを押します。エピソードの `published_at` が未来で、今すぐ公開する場合は、追加の確認または `--allow-future-published-at` の指定も必要です。

確認後は、サービス設定、入力、現在の公開状態が再照合されます。設定が変わっていた場合は、もう一度確認してください。入力や公開状態が変わっていた場合も、同じ内容がすでに公開済みの場合を除き、再確認が必要です。

`--review` には対話端末が必要で、`--json` や `--non-interactive` とは併用できません。自動化や、確認と公開を異なるタイミングで行う場合は、以下の別々のコマンドを使えます。

### プレビューと公開を別々に実行する

次の例から、変更する内容に合ったものを選びます。まずプレビューだけを実行し、差分と素材を確認してください。

確認後、プレビュー結果の `input_fingerprint` をコピーし、公開コマンドの `REVIEWED_HASH` に入れます。

#### 番組情報・カバーを更新する

```sh
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH --json
```

#### エピソードのタイトル・説明を更新する

公開済み音声を使って、編集した情報を反映します。

```sh
castloop preview-episode first --show my-show --remote --json
castloop publish-episode first --show my-show --expect-preview REVIEWED_HASH --json
```

#### エピソードの音声を差し替える

新しいMP3は絶対パス、または番組ディレクトリからの相対パスで指定します。次の例では絶対パスを使います。プレビューと公開では同じパスを指定してください。

```sh
castloop preview-episode first /path/to/new.mp3 --show my-show --remote --json
castloop publish-episode first /path/to/new.mp3 --show my-show --expect-preview REVIEWED_HASH --json
```

プレビュー後にファイルを編集した場合は、もう一度プレビューして新しいハッシュを使ってください。

## 3. 結果を確認する

公開結果の `changed` は更新完了、`unchanged` は同じ内容が公開済みであることを表します。どちらも `revision_id` で保存された版を確認できます。

```sh
castloop verify my-show --episode first --json
```

番組サイトでも、変更箇所や音声を確認してください。

エラーや通信切断で結果が分からない場合は、[中断後の確認手順](troubleshooting_ja.md#操作が中断した場合)へ進みます。

## 関連する操作

- [日時を指定して公開する](scheduling_ja.md)：`published_at` はRSSに載せる日時です。公開する時刻は予約で指定します。
- [差分・RSS・過去版を確認する](published_content_review_ja.md)
- [非公開にする・公開を戻す](lifecycle_ja.md)
