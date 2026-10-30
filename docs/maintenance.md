# サービスの保守

新しいCLIに含まれる配信サーバー（Worker）を、利用中のサービスに反映する手順です。

## 1. 更新の準備をする

1. [リリースノート](https://github.com/simosako/castloop-v2/releases)で、利用中のサービスを更新できる版か確認します。
2. [CLIを更新](installation.md#cliを更新する)します。
3. 元のワークスペースの[バックアップ](workspace_backup.md)を作成します。
4. CloudflareのアカウントIDとAPIトークンを[環境変数に設定](getting_started.md#1-cloudflareの認証情報を設定する)します。

## 2. サーバーを更新する

更新前の状態を確認してから、`deploy` を実行します。

```sh
castloop service-status --workspace /path/to/workspace --json
castloop deploy --workspace /path/to/workspace --json
```

公開内容、音声、画像、履歴、予約、独自ドメインは維持されます。

## 3. 更新後の状態を確認する

```sh
castloop service-status --workspace /path/to/workspace --json
castloop verify my-show --workspace /path/to/workspace --json
```

`publication_ready` が `true` であることを確認し、番組サイトでも表示と音声を確かめてください。

## 更新が中断した場合

実行していたコマンドの終了を確認し、`service-status` で現在の状態を調べます。その後、同じワークスペースと設定で `deploy` を再実行してください。

互換性や設定のエラーが出た場合は、リリースノートとエラー内容を確認します。その他の状態確認は[トラブルシューティング](troubleshooting.md)を参照してください。
