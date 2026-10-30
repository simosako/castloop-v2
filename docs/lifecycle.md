# 非公開化と公開の復元

番組全体、またはエピソード単位で配信を止められます。非公開にした内容や素材は保存され、後から再公開できます。

## エピソードを非公開にする

### 1. 変更内容を確認する

次の例では、番組 `my-show` のエピソード `first` を非公開にします。

```sh
castloop preview-episode-lifecycle my-show first unpublish --workspace /path/to/workspace > /path/to/workspace/unpublish-plan.json
```

`unpublish-plan.json` を開き、番組、エピソード、変更後の状態を確認します。

### 2. 実行する

計画内の `request_sha256` を `REVIEWED_REQUEST_SHA256` に入れます。`confirm` はそのまま入力してください。

```sh
castloop lifecycle-execute unpublish-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

完了後、エピソードがRSSと番組サイトの一覧から消えたことを確認します。エピソードのページと音声も配信が停止します。

## エピソードを再公開する

保存されている最新の内容で公開を戻します。親の番組を公開状態にしてから実行してください。

```sh
castloop preview-episode-lifecycle my-show first restore --workspace /path/to/workspace > /path/to/workspace/restore-plan.json
```

`restore-plan.json` の内容を確認し、その計画の `request_sha256` を使って実行します。

```sh
castloop lifecycle-execute restore-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

再公開後は番組サイトで表示と再生を確認してください。

## 番組全体を非公開にする・再公開する

番組全体を止める場合は、次のコマンドで計画を作ります。

```sh
castloop preview-show-lifecycle my-show unpublish --workspace /path/to/workspace > /path/to/workspace/show-plan.json
```

計画を確認し、`request_sha256` を使って実行します。

```sh
castloop lifecycle-execute show-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

番組のRSS、サイト、画像、音声の配信が停止します。

再公開するときは、プレビューの `unpublish` を `restore` に替えて新しい計画を作り、確認して実行します。個別に非公開にしていたエピソードは、その状態が維持されます。

## 別の内容で公開したい場合

- 手元で編集した内容を公開する：[通常の公開・更新](publishing.md)
- 特定の過去版に戻す：[履歴の閲覧と採用](published_content_review.md#履歴の閲覧と採用)
- 操作の結果が分からない：[中断後の確認](troubleshooting.md#操作が中断した場合)
