# サービスを作り、最初のエピソードを公開する

[CLIのインストール](installation_ja.md)を済ませてから、次の順に進めます。

1. Cloudflareの認証情報を設定する
2. サービスを作る
3. 番組を公開する
4. エピソードを公開する
5. RSSと音声を確認する

このページでは、ワークスペースを `/path/to/workspace`、番組IDを `my-show` とします。パスや名前は自分の環境に合わせて置き換えてください。

## 1. Cloudflareの認証情報を設定する

Cloudflareのダッシュボードで、次を確認します。

- アカウントID
- Workers・R2・SQLite Durable Objectsを管理できるAPIトークン
- 利用する `workers.dev` サブドメイン

認証情報をターミナルの環境変数に設定します。

Linux・macOSの場合：

```sh
export CLOUDFLARE_ACCOUNT_ID="アカウントID"
export CLOUDFLARE_API_TOKEN="APIトークン"
```

WindowsのPowerShellの場合：

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "アカウントID"
$env:CLOUDFLARE_API_TOKEN = "APIトークン"
```

## 2. サービスを作る

管理ファイルを保存する新しいフォルダと、未使用のサービスID・R2バケット名を決めます。

```sh
castloop init /path/to/workspace --service-id my-service --bucket-name my-private-bucket --workers-subdomain my-account-subdomain
castloop service-status --workspace /path/to/workspace --json
```

`init` はCloudflare上に配信環境を作り、手元にワークスペースを作成します。`service-status` の結果で `publication_ready` が `true` になっていることを確認してください。

ワークスペースの `castloop.toml` はサービスの設定、`.castloop/` は管理キーや操作記録です。両方を保管してください。

試験用の番組を限られた人だけに公開する場合は、素材をアップロードする前に[アクセス保護](../design/security.md#非公開の実機試験)を設定します。

## 3. 番組を公開する

番組の雛形を作ります。この例では、castloopの番組サイトを使います。

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
```

作成された `my-show/show.toml` を開き、番組名、説明、著者、所有者の連絡先などを入力します。[入力例](../examples/README.md)を参考に、生成されたファイルの各項目を編集してください。

番組のカバー画像を `my-show/` に置き、`image_path` にファイル名を書きます。カバーには5,000,000バイト以下のJPEGまたはPNGを使います。

準備ができたらプレビューします。

```sh
castloop preview-show my-show --workspace /path/to/workspace --remote --json
```

番組情報とカバーを確認し、結果の `input_fingerprint` をコピーします。次の `REVIEWED_HASH` をその値に置き換えて公開します。

```sh
castloop publish-show my-show --workspace /path/to/workspace --expect-preview REVIEWED_HASH --json
```

## 4. エピソードを公開する

エピソードの雛形を作ります。

```sh
castloop create-episode first --workspace /path/to/workspace --show my-show
```

`my-show/episode-first.toml` を開き、タイトルや説明を入力します。生成されたGUID（エピソードの識別子）はそのまま使い、公開日時を確認してください。

300,000,000バイト以下のMP3を用意し、プレビューします。音声のパスは絶対パスで指定すると分かりやすくなります。

```sh
castloop preview-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --remote --json
```

内容と音声を確認し、この結果の `input_fingerprint` を使って公開します。

```sh
castloop publish-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

日時を指定して公開する場合は、公開コマンドの代わりに[予約公開](scheduling_ja.md)を使ってください。

## 5. RSSと音声を確認する

```sh
castloop list-episodes my-show --workspace /path/to/workspace --json
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

`castloop.toml` の `public_base_url` を確認し、次のURLをブラウザで開きます。

| 内容 | URL |
| --- | --- |
| 番組サイト | `<public_base_url>/podcasts/my-show/` |
| RSS | `<public_base_url>/podcasts/my-show/feed.xml` |

番組名や説明を確認し、音声を再生してください。

公開できたら[ワークスペースのバックアップ](workspace_backup_ja.md)を作成します。次回からの編集は[公開と更新](publishing_ja.md)を参照してください。
