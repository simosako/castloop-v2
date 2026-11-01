# サービスを作り、最初のエピソードを公開する

[CLIのインストール](installation_ja.md)を済ませてから、次の順に進めます。

1. Cloudflareの認証情報を設定する
2. サービスを作る
3. 番組を公開する
4. エピソードを公開する
5. RSSと音声を確認する

このページでは、ワークスペースを `/path/to/workspace`、番組IDを `my-show` とします。パスや名前は自分の環境に合わせて置き換えてください。ワークスペースを作成した後は、特に指定がなければそのディレクトリからコマンドを実行します。

公開時には `--review` を使います。1つのコマンドでプレビューと公開の確認を行うため、確認用のハッシュをコピーしたり、公開コマンドを別に入力したりする必要はありません。確認するまでは音声・画像のアップロードや番組・エピソードの公開は行われません。

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

管理ファイルを保存する新しいフォルダと、未使用のサービスID・R2バケット名を決めます。既存の親ディレクトリの下にフォルダを作り、その中に移動します。

```sh
mkdir /path/to/workspace
cd /path/to/workspace
```

現在のディレクトリにサービスを初期化し、状態を確認します。

```sh
castloop init --service-id my-service --bucket-name my-private-bucket --workers-subdomain my-account-subdomain
castloop service-status --json
```

`init` はCloudflare上に配信環境を作り、手元のワークスペースを初期化します。`service-status` の結果で `publication_ready` が `true` になっていることを確認してください。

ワークスペースの `castloop.toml` はサービスの設定、`.castloop/` は管理キーや操作記録です。両方を保管してください。

試験用の番組を限られた人だけに公開する場合は、素材をアップロードする前に[アクセス保護](../design/security.md#非公開の実機試験)を設定します。

## 3. 番組を公開する

番組を登録し、手元に編集用の雛形を作ります。この時点では公開されません。この例では、castloopの番組サイトを使います。

```sh
castloop create-show my-show --site-mode builtin
```

作成された `my-show/show.toml` を開き、番組名、説明、著者、所有者の連絡先などを入力します。[入力例](../examples/README.md)を参考に、生成されたファイルの各項目を編集してください。

番組のカバー画像を `my-show/` に置き、`image_path` にファイル名を書きます。カバーには5,000,000バイト以下のJPEGまたはPNGを使います。

準備ができたら、対話端末で内容を確認して公開します。

```sh
castloop publish-show my-show --review
```

`--review` は、アップロードや公開を行う前に、対象、差分、カバー画像のパス、警告を表示します。番組情報と画像を確認し、公開する場合は `publish` と入力します。取り消す場合は何も入力せずEnterキーを押します。確認後、入力と公開状態が再照合されてからアップロード・公開されます。

## 4. エピソードを公開する

エピソードの雛形を作ります。この時点ではアップロードも公開も行われません。

```sh
castloop create-episode first --show my-show
```

`my-show/episode-first.toml` を開き、タイトルや説明を入力します。生成されたGUID（エピソードの識別子）はそのまま使い、公開日時を確認してください。

300,000,000バイト以下のMP3を用意して番組ディレクトリにコピーし、内容を確認します。音声には絶対パス、または番組ディレクトリからの相対パスを指定できます。この例の `audio.mp3` は `my-show/audio.mp3` を指します。

```sh
cp /path/to/audio.mp3 my-show/audio.mp3
castloop publish-episode first audio.mp3 --show my-show --review
```

プレビューの対象と差分を確認し、表示された手元のパスにある音声を試聴してから、`publish` と入力して公開します。取り消す場合はEnterキーを押します。確認中に入力や公開状態が変わった場合は、同じ内容がすでに公開済みの場合を除き、もう一度確認する必要があります。

`--review` には対話端末が必要で、`--json` や `--non-interactive` とは併用できません。自動化などでプレビューと公開を別々に行う場合は、[公開と更新](publishing_ja.md#プレビューと公開を別々に実行する)を参照してください。

`published_at` が未来でも今すぐ公開する場合は、追加の確認で `publish now` と入力します。指定した日時まで待って公開する場合は、[予約公開](scheduling_ja.md)を使ってください。

## 5. RSSと音声を確認する

```sh
castloop list-episodes my-show --json
castloop verify my-show --episode first --json
```

`castloop.toml` の `public_base_url` を確認し、次のURLをブラウザで開きます。

| 内容 | URL |
| --- | --- |
| 番組サイト | `<public_base_url>/podcasts/my-show/` |
| RSS | `<public_base_url>/podcasts/my-show/feed.xml` |

番組名や説明を確認し、音声を再生してください。

公開できたら[ワークスペースのバックアップ](workspace_backup_ja.md)を作成します。次回からの編集は[公開と更新](publishing_ja.md)を参照してください。

## 他のディレクトリから実行する

エピソードのコマンドは、番組ディレクトリまたはそのサブディレクトリから `--workspace` と `--show` を省略して実行することもできます。

```sh
cd /path/to/workspace/my-show
castloop preview-episode first audio.mp3 --remote --json
```

管理コマンドと `backup-create` は、現在のディレクトリから上位5階層まで `castloop.toml` を探し、最も近いものを使います。ファイルシステムのルートで探索を終え、最も近い設定が不正な場合に別のワークスペースへ切り替えることはありません。エピソードのコマンドで `--show` を省略する場合は、ワークスペース直下の番組ディレクトリ名と `show.toml` の `show_id` が一致する必要があります。音声の相対パスはその番組ディレクトリ基準です。

探索範囲内でワークスペースが見つからない場合は、`--workspace` を指定してください。対話端末では、ワークスペースを自動選択する管理コマンドは実行前にワークスペースとサービスを表示します。`init`、`doctor`、`preview-schedule-time` は上位を探索せず、現在のディレクトリを使います。

別のディレクトリからワークスペースを明示する場合は、`--workspace` を使います。エピソードのコマンドでは、この場合 `--show` も必要です。

```sh
castloop preview-episode first audio.mp3 --workspace /path/to/workspace --show my-show --remote --json
```

[エージェントに操作を依頼する](agent_usage_ja.md)場合や、現在のディレクトリが不確かな場合は、パスと番組IDを明示してください。
