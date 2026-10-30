# Show・Episodeの公開と更新

サービスの作成と初回公開は[はじめに](getting_started.md)、項目別差分や過去版の採用は[内容確認ガイド](published_content_review.md)を参照してください。本書は、日常の編集と即時公開を扱います。

## 対象とファイルを確認する

以下はワークスペースを `/path/to/workspace`、Showを `my-show` とした例です。

| 編集する内容 | ファイル・入力 |
| --- | --- |
| 番組情報・サイト設定 | `my-show/show.toml` と、そこで指定したカバー・CSS |
| Episodeのタイトル・説明等 | `my-show/episode-first.toml` |
| Episodeの音声 | 公開コマンドへ渡すMP3。省略時は公開済み音声を再利用 |

`--workspace` は指定したサービスだけを対象にします。Episode操作では `--show` も必要です。相対MP3パスはShowディレクトリ基準で、呼び出した場所の基準ではありません。混同を避けるには絶対パスを指定します。`image_path` はShowディレクトリ直下のファイル名です。

GUIDと公開日時は保存済みの値を保持し、公開済みカバーの拡張子を変えないでください。入力の形式や必須項目は次で確認できます。

```sh
castloop schema show-input
castloop schema episode-input
castloop validate show /path/to/workspace/my-show/show.toml --assets --json
castloop validate episode /path/to/workspace/my-show/episode-first.toml --json
```

## プレビューして公開する

### 番組情報・カバーの変更

```sh
castloop preview-show my-show --workspace /path/to/workspace --remote --json
castloop publish-show my-show --workspace /path/to/workspace --expect-preview REVIEWED_HASH --json
```

### Episodeの説明・タイトル等の変更

MP3を省略すると公開済み音声を再利用します。初回公開はMP3が必要です。

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --json
castloop publish-episode first --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

### 音声の差し替え

```sh
castloop preview-episode first /path/to/new.mp3 --workspace /path/to/workspace --show my-show --remote --json
castloop publish-episode first /path/to/new.mp3 --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

各プレビューで、対象、ローカル内容、公開済み内容との差分、素材、更新元を確認します。`REVIEWED_HASH` は、その出力の `input_fingerprint` に置き換えてください。入力や更新元が変わったら再度プレビューします。ハッシュは確認内容を固定するもので、人の承認そのものではありません。

`--local` のプレビューは通信しませんが、公開済み内容は未確認になります。公開前はリモート確認を使います。プレビューは素材のアップロードも公開も行いません。

## 結果を確認する

| 結果 | 意味 |
| --- | --- |
| `changed` と `revision_id` | 内容と履歴の更新がサーバーで確定済み |
| `unchanged` と `revision_id` | 同じ内容・素材・公開状態が既に確定済み。履歴は増えません |
| エラー・応答不明 | 成功とは判断せず、現在内容と履歴を確認 |

公開時には必要な素材だけを非公開R2へ配置し、メタデータと素材参照をサーバーへ送ります。1件の公開は必要なキャッシュパージ後に一括確定します。同じ公開済み素材なら再アップロードせず、音声を差し替えても旧音源と履歴を保持します。MP3上限は **300,000,000 bytes**、JPEG/PNGカバーは **5,000,000 bytes** です。

```sh
castloop list-episodes my-show --workspace /path/to/workspace --json
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

公開確定と配信確認は別です。Access等で保護したURLは、許可された閲覧条件でも確認してください。

## 公開日時と中断時の扱い

- `published_at` はRSS上の日時です。未来日時でも即時公開されます。非対話でそれを実行するには `--allow-future-published-at` が必要です。時刻まで待つ場合は[予約公開](scheduling.md)を使います。
- 応答を失った場合は、現在内容を確認して同じ承認済み入力で再実行できます。既に同じ内容なら変更なしです。内容が異なり更新元が古ければ競合として拒否されるため、改めて差分を確認します。
- 入力や公開済み音源、`.castloop/` を削除してやり直す必要はありません。詳細は[トラブルシューティング](troubleshooting.md)を参照してください。
- 配信停止はファイルの削除ではなく[非公開化](lifecycle.md)で行います。
