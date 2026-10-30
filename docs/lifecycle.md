# 非公開化と公開の復元

Show全体またはEpisode単位で配信を止め、保存済み内容から再公開できます。音源や履歴を物理削除する機能ではありません。

## Episodeを非公開にする

1. 計画を作り、対象・現在状態・変更後の状態を確認します。
2. 確認した計画のハッシュを指定して実行します。

```sh
castloop preview-episode-lifecycle my-show first unpublish --workspace /path/to/workspace > /path/to/workspace/unpublish-plan.json
castloop lifecycle-execute unpublish-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

`REVIEWED_REQUEST_SHA256` は計画内の `request_sha256` に置き換えてください。`confirm` はそのまま指定する確認文字列です。計画ファイルの相対パスはワークスペース基準です。

非公開化したEpisodeはRSS・内蔵サイトの一覧から消え、ページと音源はHTTP 404になります。公開済みメディアと履歴、GUID・公開日時・短いページURLの対応は保持します。

## 保存済み内容で公開を戻す

```sh
castloop preview-episode-lifecycle my-show first restore --workspace /path/to/workspace > /path/to/workspace/restore-plan.json
castloop lifecycle-execute restore-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

`restore` は、最新の保存済み内容を使って公開状態に戻します。手元のTOMLや音声の編集は採用せず、ローカルファイルも書き換えません。Episodeの復元には親Showが公開されている必要があります。

任意の古い版を選びたい場合は、別の[過去版の採用手順](published_content_review.md#履歴の閲覧と採用)を使います。手元の編集を公開する場合は[通常の公開](publishing.md)を使ってください。

## 番組全体を止める・戻す

```sh
castloop preview-show-lifecycle my-show unpublish --workspace /path/to/workspace > /path/to/workspace/show-plan.json
castloop lifecycle-execute show-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

復元時は `unpublish` を `restore` に替え、新しい計画を確認してから実行します。Showを非公開化すると、その番組のRSS・サイト・画像・音声を配信しません。Showの復元は、個別に非公開化したEpisodeまで公開に戻す操作ではありません。

## 結果と保持範囲

- 実行結果の `changed`／`unchanged` とリビジョンを確認します。同じ状態なら変更なしです。変更がある場合は計画の更新元を照合します。
- 応答不明時は現在状態を確認し、同じ計画で実行できます。既に同じ状態なら変更なしになります。計画が古ければ、再プレビューして確認します。
- 非公開化は以後の配信を止めるものです。利用者の保存済み音声、再生バッファー、第三者のコピーを遠隔消去することはできません。
- ローカルファイルの削除、Workerの配備、素材のアップロードだけでは、公開可否は切り替わりません。

状態確認は[診断ガイド](troubleshooting.md)、内部の保持条件は[保存構造](../design/data/storage.md)を参照してください。
