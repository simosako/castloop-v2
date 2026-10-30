# 初めてのサービス作成と公開

配布CLIで新しいサービスを作成し、番組と最初のEpisodeを公開する手順です。[インストール](installation.md)を済ませ、[対応条件](README.md#対象と用語)を確認してください。以下のコマンドはCloudflare上の実資源を作成・変更します。

## 1. 用意するもの

- CloudflareアカウントIDと、そのアカウントのWorker・R2・SQLite Durable Objectsを管理できるAPIトークン。
- 利用可能な `workers.dev` サブドメインと、未使用のサービスID・非公開R2バケット名。
- 番組情報、JPEG/PNGカバー（5,000,000 bytes以下）、MP3音声（300,000,000 bytes以下）。
- 設定・管理キー・編集元を保管する、新しいワークスペースの場所。

APIトークンの権限は管理者が確認します。CLIは権限・料金プラン・CPU上限を自動変更しません。管理端末にBun・Node.js・Wrangler・ffprobe・別のR2資格情報は不要です。

試験用コンテンツを一般公開しない場合は、初期化後、素材のアップロード前に[非公開試験の保護条件](../design/security.md#非公開の実機試験)を満たしてください。URLを知らせないことや `noindex` はアクセス制御ではありません。

## 2. サービスを初期化する

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace --service-id my-service \
   --bucket-name my-private-bucket --workers-subdomain my-account-subdomain --operation-id INIT_UUID
castloop service-status --workspace /path/to/workspace --json
```

値は実際のアカウント・未使用名へ置き換えます。`INIT_UUID` はUUIDです。`--operation-id` を省略すればCLIが生成します。上の環境変数の設定例はPOSIXシェル用です。PowerShellでは `$env:CLOUDFLARE_ACCOUNT_ID = "..."`、`$env:CLOUDFLARE_API_TOKEN = "..."` と設定します。

初期化は設定・非公開バケット・Workerを用意し、稼働を確認します。既存の不明な資源を採用する操作ではありません。結果の `publication_ready` を確認してください。APIトークンは環境変数で与え、TOMLやGitに保存しません。

ワークスペースには `castloop.toml` と、管理キー・操作記録を含む `.castloop/` ができます。TOMLだけをコピーしても管理環境のバックアップにはなりません。

## 3. 番組を作成・公開する

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
```

`my-show/show.toml` を編集し、実際の番組情報と所有者情報を入力します。`image_path` は同じディレクトリに置くカバーのファイル名（例：`cover.jpg`）です。番組IDなどCLIが確定した識別情報は保持してください。

項目の書き方は[入力例](../examples/README.md)を参照できます。例のファイルで生成済みのTOMLを丸ごと置き換えないでください。

```sh
castloop preview-show my-show --workspace /path/to/workspace --remote --json
castloop publish-show my-show --workspace /path/to/workspace --expect-preview REVIEWED_HASH --json
```

`REVIEWED_HASH` は直前のプレビューで確認した `input_fingerprint` に置き換えます。作成は登録とローカル雛形の用意だけで、公開は `publish-show` で行います。外部サイトを使う場合は `--site-mode external --site-url https://your-site.example/podcast` を指定します。詳しくは[番組サイト](show_website.md)を参照してください。

## 4. Episodeを作成・公開する

```sh
castloop create-episode first --workspace /path/to/workspace --show my-show
```

`my-show/episode-first.toml` のタイトル・説明等を編集します。生成されたGUID・公開日時は保持します。初回公開にはMP3が必要です。

```sh
castloop preview-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --remote --json
castloop publish-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

Showとは別のプレビュー結果を確認し、そのハッシュを使います。即時公開の `publish-episode` は未来の `published_at` でも公開を待ちません。待つ場合は[予約公開](scheduling.md)を選んでください。

## 5. 結果を確認し、管理ファイルを保全する

公開結果の `changed`／`unchanged` と `revision_id` を確認します。

```sh
castloop list-episodes my-show --workspace /path/to/workspace --json
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

RSSは `<public_base_url>/podcasts/my-show/feed.xml`、内蔵サイトは `<public_base_url>/podcasts/my-show/` です。実際の `public_base_url` はサービス設定を確認してください。保護された試験環境では、閲覧を許可された本人のブラウザでも確認します。

以後の変更は[公開・更新](publishing.md)、配信停止は[非公開化](lifecycle.md)、エラーや中断時は[診断](troubleshooting.md)を参照してください。`.castloop/` と原本を保持し、[バックアップ](workspace_backup.md)を作成します。同じ場所を変更するCLIは同時に複数起動せず、実行中は入力を編集しないでください。
