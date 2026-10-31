# 状態確認とトラブルシューティング

コマンドが失敗したときや、公開結果が分からないときは、設定、サーバー、公開URLの順に確認します。

以下はワークスペースを `/path/to/workspace`、番組IDを `my-show` とした例です。

## 1. 手元の設定を確認する

```sh
castloop doctor --local --workspace /path/to/workspace --json
```

設定ファイルや管理キーの読み取り結果を確認します。問題が表示された項目から、パスや設定内容を見直してください。

## 2. サービスと番組の状態を確認する

```sh
castloop service-status --workspace /path/to/workspace --json
castloop show-status my-show --workspace /path/to/workspace --json
```

対象サービスと番組が正しいか、`publication_ready` が `true` かを確認します。

## diagnose

まとめて診断したい場合は、次を実行します。

```sh
castloop diagnose my-show --workspace /path/to/workspace --json
```

設定、認証情報、Cloudflareへの接続、番組の登録・公開内容を確認できます。公開URLも調べる場合は `--external` を付けます。

各項目の `pass` は確認済み、`warn` は注意、`fail` は失敗、`not_checked` は未確認を表します。`fail` になった項目の説明を読んで対処してください。

## verify

公開後の配信を確認するには、次を実行します。

```sh
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

サーバーに保存された内容と、公開RSS・カバー・指定した音声の配信を照合します。RSSとカバーを確認するときは `--episode first` を省略できます。

アクセス保護を設定している場合は、閲覧を許可されたアカウントでブラウザからも確認してください。

## 操作が中断した場合

実行していたコマンドが終了していることを確認します。ワークスペース、入力ファイル、素材、`.castloop/` を保管したまま、次の表に沿って進めてください。

| 中断した操作 | 確認・続行の方法 |
| --- | --- |
| 公開・更新 | プレビューと履歴で現在内容を確認し、同じ確認済み入力で再実行します。更新元が変わっていたら、差分を再確認します |
| 非公開化・過去版の採用 | 現在状態を確認し、保存した計画を実行します。計画が古い場合は新しく作成して確認します |
| 予約作成 | `schedule-list` と `schedule-status` で受付済みかを確認してから、必要な操作を選びます |
| 初期化 | 元の保存先で `castloop init /path/to/workspace` を実行し、保存されている入力で続行します |
| 番組作成 | 元のワークスペースで、同じ番組ID・設定の `create-show` を再実行します |
| サーバー更新 | 現在状態を確認し、同じ設定で `deploy` を再実行します。[保守手順](maintenance_ja.md)を参照してください |
| 独自ドメインの変更 | [操作IDを使って状態を確認し、続行](custom_domains_ja.md#照会と中断後の継続)します |
| RSS取り込み | [同じ保存先・入力で続行](rss_migration_ja.md#停止した場合)します |

公開結果の `unchanged` は、同じ内容が既に反映されていることを示します。予約については、`schedule-status` が `dispatched` になり、`revision_id` が表示されたら公開完了です。

## 公開URLでエラーになる場合

| 表示・状態 | 確認すること |
| --- | --- |
| 404 | URLと、番組・エピソードの公開状態を確認します。再公開する場合は[公開の復元](lifecycle_ja.md)へ進みます |
| 503 | `service-status` と、実行中のドメイン変更の状態を確認します |
| 認証画面やアクセス拒否 | アクセス保護の対象URLと、閲覧を許可されたアカウントを確認します |
| 更新内容が分からない | プレビューでサーバーの現在内容を確認し、`verify` で公開URLと照合します |

## 問い合わせる前に

CLIのバージョン、実行したコマンド、エラーコード、診断で失敗した項目を整理します。APIトークン、管理キー、`.castloop/` の内容、未公開の文章や個人の連絡先は伏せて共有してください。
