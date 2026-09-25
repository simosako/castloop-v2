# 別環境での簡易動作確認（Linux x86-64）

この手順では、ソースコードのない別のLinuxマシンに`castloop`実行ファイルをコピーし、専用の検証サービス・Show・Episodeを新規作成します。**Cloudflare上にWorker、R2 bucket、Queue、DLQと公開コンテンツが作成されます。** 通常運用中のworkspaceや既存のShow IDは使わないでください。

別マシンでの試験は、現在の管理者運用向けMVP公開の必須条件ではありません。今後、実行ファイルを不特定の利用者へ配布する場合や対応環境を増やす場合の検証手順として残します。下の実施記録は同じLinux環境の新規workspaceでの結果です。

対象はLinux x86-64（`uname -s`が`Linux`、`uname -m`が`x86_64`）です。macOS・Windows用バイナリの起動確認とCloudflare上の管理操作の検証は別に扱います。検証先にNode.js/npm、Wrangler、Bun、ソースコード、`ffprobe`は不要です。

## 1. 事前に用意するもの

- ビルド元: このリポジトリ、Bun 1.4.2、Node.js/npm。`dist/castloop`はGit管理外の成果物です。
- 検証先: Linux x86-64、`curl`、`sha256sum`。管理操作は配布バイナリから行います。
- CloudflareアカウントID、API token、利用可能な`workers.dev`サブドメイン。tokenにはWorkers、R2、QueuesおよびR2通知の作成・利用権限が必要です。R2とQueuesを利用できるアカウントで実施してください。
- 検証先に置いた**実在するサイトURL**、正方形のJPEGカバー画像（5 MB以下、推奨1400×1400ピクセル以上）、短いMP3音源（300,000,000 bytes以下）。検証用のShowも公開URLからアクセスできます。カバーとMP3のパスは、検証先マシン上の絶対パスにします。
- アカウント内で未使用のサービスID（20文字以内）、R2 bucket名、検証用workspaceのパス。サービスID、Show ID、Episode IDには英小文字・数字・区切りのハイフンを使います。

## 2. 実行ファイルをビルドしてコピーする

ビルド元のリポジトリで実行します。

```sh
npm ci
npm run check
npm run build:cli
sha256sum dist/castloop
scp dist/castloop USER@HOST:/tmp/castloop
```

`USER@HOST`を検証先のSSH接続先に置き換えます。`sha256sum`の値を控え、検証先で**同じ値**になることを確認してください。バージョン付きの配布アーカイブやダウンロードURLはまだありません。

以下は検証先の**Bash**ターミナルで実行します。

```sh
uname -s
uname -m
sha256sum /tmp/castloop
mkdir -p "$HOME/.local/bin"
install -m 0755 /tmp/castloop "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
castloop --version

```

`castloop --version`で`0.1.0`が表示されることを確認します。検証先に`ffprobe`などの解析ツールをインストールする必要はありません。

## 3. Cloudflare認証とサービス作成

次の値は**自分の値**に置き換えてください。`SITE_URL`は管理者が用意した実在のURLです。`SERVICE_ID`と`BUCKET_NAME`はアカウント内で未使用のものを選び、再実行時にも同じ値を使います。

```sh
export CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
read -r -s -p "Cloudflare API token: " CLOUDFLARE_API_TOKEN
echo
export CLOUDFLARE_API_TOKEN

export SERVICE_ID="smoke-myservice"
export BUCKET_NAME="castloop-smoke-myservice"
export WORKERS_SUBDOMAIN="YOUR_WORKERS_DEV_SUBDOMAIN"
export WORKSPACE="$HOME/castloop-smoke-workspace"
export SITE_URL="https://YOUR_ACTUAL_WEBSITE/podcast"
export COVER_FILE="/absolute/path/to/cover.jpg"
export MP3_FILE="/absolute/path/to/short.mp3"
test -s "$COVER_FILE" && test -s "$MP3_FILE"

castloop init "$WORKSPACE" \
  --service-id "$SERVICE_ID" --bucket-name "$BUCKET_NAME" \
  --workers-subdomain "$WORKERS_SUBDOMAIN"
```

`test -s`が失敗した場合は、カバーとMP3のパスを直してから進めてください。`Initialized ...`と表示されれば成功です。`WORKERS_SUBDOMAIN`には`foo.workers.dev`全体ではなく**`foo`の部分だけ**を指定します。`init`はWorkerのURLが反映されるまで一時的な404等を最大6回再試行します。途中で止まった場合はworkspaceを残し、**フラグなし**で`castloop init "$WORKSPACE"`を再実行してください。API tokenを`castloop.toml`やGitへ保存しないでください。

## 4. Showを公開する

```sh
cd "$WORKSPACE"
castloop create-show smoke-show --site-url "$SITE_URL"
cp "$COVER_FILE" smoke-show/cover.jpg
```

`smoke-show/show.toml`をエディタで開き、少なくとも`title`、`description`、`author`、`owner_name`、`owner_email`を実際の検証用の値に変更します。`image_path = "cover.jpg"`と`site_url`も確認します。PNGを使う場合は`cover.png`へコピーし、`image_path = "cover.png"`に変更してください。`create-show`によるID予約だけでは公開されません。

```sh
castloop update-show smoke-show
castloop publish-show smoke-show
export SHOW_JOB_ID="PASTE_SHOW_JOB_UUID"
castloop job-status "$SHOW_JOB_ID" --show smoke-show
```

`SHOW_JOB_ID`には`publish-show`が表示したUUIDを貼り付けます。数秒後に`job-status`を再実行し、JSONの`status.state`が`published`、`owner.state`が`free`になったことを確認します。`update-show`だけでは公開されません。

## 5. Episodeを公開する

Showの完了を確認してから続けます。

```sh
cd "$WORKSPACE/smoke-show"
castloop create-episode first-episode
cp "$MP3_FILE" audio.mp3
```

`episode-first-episode.toml`の`title`と`description`を編集します。生成された`guid`と、引用符付きの`published_at`はそのまま残してください。

```sh
castloop update-episode first-episode
castloop update-episode-audio first-episode audio.mp3
castloop publish-episode first-episode
cd "$WORKSPACE"
export EPISODE_JOB_ID="PASTE_EPISODE_JOB_UUID"
castloop job-status "$EPISODE_JOB_ID" --show smoke-show --episode first-episode
```

`EPISODE_JOB_ID`には`publish-episode`が表示したUUIDを貼り付けます。数秒後に再確認し、`status.state = published`かつ`owner.state = free`なら公開完了です。MP3の解析はCLIに同梱され、`ffprobe`を使用しません。

## 6. 公開結果の確認

`castloop.toml`の`public_base_url`から配信URLを組み立てます。

```sh
export PUBLIC_BASE_URL="$(sed -n 's/^public_base_url = "\(.*\)"$/\1/p' "$WORKSPACE/castloop.toml")"
curl -fsS "$PUBLIC_BASE_URL/podcasts/smoke-show/feed.xml" -o "$WORKSPACE/feed.xml"
grep -E '<(title|itunes:duration|enclosure)' "$WORKSPACE/feed.xml"

export MEDIA_URL="$PUBLIC_BASE_URL/podcasts/smoke-show/episodes/first-episode/$EPISODE_JOB_ID.mp3"
curl -fL "$MEDIA_URL" -o "$WORKSPACE/downloaded.mp3"
cmp "$MP3_FILE" "$WORKSPACE/downloaded.mp3"
sha256sum "$MP3_FILE" "$WORKSPACE/downloaded.mp3"
curl -fL "$PUBLIC_BASE_URL/podcasts/smoke-show/cover.jpg" -o "$WORKSPACE/downloaded-cover.jpg"
cmp "$COVER_FILE" "$WORKSPACE/downloaded-cover.jpg"
```

feedにShow/Episodeのタイトル、`itunes:duration`、enclosure URLがあり、各`cmp`が何も表示せず終了コード0、音源の両SHA-256が一致すれば基本動作の確認は完了です。PNGを選んだ場合は画像のURLと保存先の拡張子を`cover.png`・`downloaded-cover.png`に変えてください。

終了後は`SERVICE_ID`、workspaceのパス、Show/Episode job ID、`job-status`の状態、feed URL、確認結果を控えてください。**API tokenと`.castloop/secrets.json`は共有しないでください。** 検証用Cloudflareリソースは自動削除されません。確認後に片付けるまでworkspaceを保持してください。

## 実施記録（2026-09-25、Wranglerを使用した旧実装）

### 実施環境

- OS / architecture: Linux x86-64
- Node.js `v24.21.0`、npm `11.19.0`、Bun `1.4.2`、Wrangler `4.131.2`
- `npm ci`、`npm run check`、`npm run build:cli`は成功。`npm ci`では`esbuild`と`workerd`のinstall scriptに関する警告が出たが、型チェックとビルドは完了した。
- `dist/castloop --version`: `0.1.0`
- `dist/castloop` SHA-256: `03d3bc2fe888b7223df8fd088bc37e28ba6e394a69dc31fd1bccf6bc61197da3`
- ビルド済み実行ファイルを同じLinux環境で実行した。ソースコードのない別マシンへのコピー・実行は未確認。
- Cloudflare API tokenの値と`.castloop/secrets.json`の内容は記録しない。

### 使用した値と作成リソース

- `SITE_URL`: `https://www.otftalk.com/`（事前のHTTP HEAD応答は200）
- Service ID: `smoke-20260924`
- R2 bucket: `castloop-smoke-20260924`
- Show / Episode: `smoke-show` / `first-episode`
- `workers.dev` subdomain: `simosako`
- Worker: `castloop-smoke-20260924-2afc5f48`
- Queue: `castloop-smoke-20260924-2afc5f48`
- DLQ: `castloop-smoke-20260924-dlq-2afc5f48`
- workspace: `~/castloop-smoke-workspace`（リポジトリ外）
- 公開Worker URL: `https://castloop-smoke-20260924-2afc5f48.simosako.workers.dev`
- ローカルの合成テスト素材は`tmp/linux-smoke/`に置き、Git管理対象外とした。JPEGは1400×1400・41,261 bytes、MP3は8秒・129,287 bytes。

### 結果

- `init`はWorkerデプロイ直後のヘルスチェックでHTTP 500となった。その後同じWorkerの`/admin/health`がHTTP 200になったことを確認し、同じworkspaceでフラグなしの`init`を再実行して完了した。
- 最初の`update-show`は、workspaceがmiseプロジェクト外にありWrangler shimを解決できず失敗した。`CASTLOOP_WRANGLER`にWranglerの絶対パスを設定して再実行し、同じ下書きを正常にステージした。
- Show job `cf14b630-728b-4385-9b0d-e5c0bafaa5de`: `status.state = published`、`owner.state = free`。
- Episode job `5ae2873a-7739-4578-b1d3-17c08c7d4934`: `status.state = published`、`owner.state = free`、DLQなし。
- 公開Feed: `https://castloop-smoke-20260924-2afc5f48.simosako.workers.dev/podcasts/smoke-show/feed.xml`
- FeedにShow/Episodeのtitle、enclosure URL、`itunes:duration`（`00:00:08`）があることを確認した。
- 公開URLからMP3とカバーを取得し、両方とも元ファイルとの`cmp`が成功。SHA-256も一致した。
  - MP3: `583cdd6736c1b69dd1605b9f8303a148db14cf0f585d9f8cb2d71b6f90a2cda8`
  - Cover: `f712c1adaa0ec85a9160a527cfad239987481208fbb12be31546b76249871bbc`
- 検証用Cloudflareリソースとworkspaceは削除せず保持中。別マシンでの再確認とリソースの後片付けは未実施。別マシン試験は、このMVPの公開ブロッカーではない。
