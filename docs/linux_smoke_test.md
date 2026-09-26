# 別環境での簡易動作確認（Linux x86-64）

この手順では、ソースコードのない別のLinuxマシンで配布バイナリを実行します。**第1段階**で`workers.dev`を使って専用の検証サービス・Show・Episodeを公開し、**第2段階**で同じworkspaceを独自ドメインへ移行して戻します。Cloudflare上にWorker、private R2 bucket、Queue、DLQと公開コンテンツが作成されます。通常運用中のworkspaceや既存のShow IDは使わないでください。

**現在の状態:** 公開済みv0.1.1で実施できるのは第1段階までです。独自ドメインの`domain add/list/remove`はまだCLIに公開されていません。第2段階は両コマンドと安全な復帰が実装・受け入れ済みの**将来の配布版**を入手してから実施してください。現時点で手動でWorkerにCustom Domainを付けたり、`castloop.toml`の`public_base_url`だけを書き換えたりしても、feedの移行試験にはなりません。

下の実施記録は過去に同じLinux環境の新規workspaceで行った旧実装の結果です。別マシンでの検証済み結果ではありません。

対象はLinux x86-64（`uname -s`が`Linux`、`uname -m`が`x86_64`）です。macOS・Windows用バイナリの起動確認とCloudflare上の管理操作の検証は別に扱います。検証先にNode.js/npm、Wrangler、Bun、ソースコード、`ffprobe`は不要です。

## 1. 事前に用意するもの

- 検証先: Linux x86-64、`curl`、`sha256sum`、`cmp`、`grep`、`sed`。管理操作は配布バイナリから行います。
- CloudflareアカウントID、API token、利用可能な`workers.dev`サブドメイン。tokenにはWorkers、R2、QueuesおよびR2通知の作成・利用権限が必要です。R2とQueuesを利用できるアカウントで実施してください。
- 検証先に置いた**実在するサイトURL**、正方形のJPEGカバー画像（5 MB以下、推奨1400×1400ピクセル以上）、短いMP3音源（300,000,000 bytes以下）。検証用のShowも公開URLからアクセスできます。カバーとMP3のパスは、検証先マシン上の絶対パスにします。
- アカウント内で未使用のサービスID（20文字以内）、R2 bucket名、検証用workspaceのパス。サービスID、Show ID、Episode IDには英小文字・数字・区切りのハイフンを使います。

## 2. v0.1.1の実行ファイルを検証先に入れる

以下は検証先の**Bash**ターミナルで実行します。まず配布済みのLinux x86-64バイナリを入手します。`SHA256SUMS`が参照するファイル名のまま同じディレクトリに保存してください。

```sh
uname -s
uname -m
mkdir -p "$HOME/castloop-smoke-download"
cd "$HOME/castloop-smoke-download"
curl -fL https://github.com/simosako/castloop-v2/releases/download/v0.1.1/castloop-linux-x64 -o castloop-linux-x64
curl -fL https://github.com/simosako/castloop-v2/releases/download/v0.1.1/SHA256SUMS -o SHA256SUMS
sha256sum --check SHA256SUMS
mkdir -p "$HOME/.local/bin"
install -m 0755 castloop-linux-x64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
castloop --version
```

`uname -s`が`Linux`、`uname -m`が`x86_64`、`castloop --version`が`0.1.1`であることを確認します。検証先に`ffprobe`などの解析ツールをインストールする必要はありません。配布物のライセンス情報は同じ[Release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.1)の`LICENSE`と`THIRD_PARTY_NOTICES.md`を参照してください。

ソースから試す場合のみ、**ビルド元**でBun 1.4.2とNode.js/npmを使って以下を実行し、バイナリとSHA-256値を検証先へ転送してください。ソースビルドは検証先には不要です。

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
sha256sum dist/castloop-linux-x64
scp dist/castloop-linux-x64 USER@HOST:/tmp/castloop-linux-x64
```

この場合は検証先で`sha256sum /tmp/castloop-linux-x64`がビルド元と同じ値になることを確認してから、上と同じように`install -m 0755 /tmp/castloop-linux-x64 "$HOME/.local/bin/castloop"`で配置してください。ソースビルドとReleaseのchecksumは混用しないでください。

## 第1段階: `workers.dev`で公開する（v0.1.1で実施可能）

### 3. Cloudflare認証とサービス作成

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

### 4. Showを公開する

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

### 5. Episodeを公開する

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

### 6. `workers.dev`の公開結果を確認する

`castloop.toml`の`public_base_url`から配信URLを組み立てます。

```sh
export PUBLIC_BASE_URL="$(sed -n 's/^public_base_url = "\(.*\)"$/\1/p' "$WORKSPACE/castloop.toml")"
export WORKERS_BASE_URL="$PUBLIC_BASE_URL"
test -n "$WORKERS_BASE_URL"
curl -fsS "$PUBLIC_BASE_URL/podcasts/smoke-show/feed.xml" -o "$WORKSPACE/feed.xml"
curl -fsSI "$PUBLIC_BASE_URL/podcasts/smoke-show/feed.xml" | grep -i '^HTTP/.* 200'
grep -E '<(title|itunes:duration|enclosure)' "$WORKSPACE/feed.xml"
grep -F "$WORKERS_BASE_URL/podcasts/smoke-show/feed.xml" "$WORKSPACE/feed.xml"

export MEDIA_URL="$PUBLIC_BASE_URL/podcasts/smoke-show/episodes/first-episode/$EPISODE_JOB_ID.mp3"
grep -F "$MEDIA_URL" "$WORKSPACE/feed.xml"
curl -f "$MEDIA_URL" -o "$WORKSPACE/downloaded.mp3"
cmp "$MP3_FILE" "$WORKSPACE/downloaded.mp3"
sha256sum "$MP3_FILE" "$WORKSPACE/downloaded.mp3"
curl -f "$PUBLIC_BASE_URL/podcasts/smoke-show/cover.jpg" -o "$WORKSPACE/downloaded-cover.jpg"
curl -fsSI "$PUBLIC_BASE_URL/podcasts/smoke-show/cover.jpg" | grep -i '^HTTP/.* 200'
cmp "$COVER_FILE" "$WORKSPACE/downloaded-cover.jpg"
curl -fsSI "$MEDIA_URL" | grep -iE '^(HTTP/|content-length:|accept-ranges:)'
curl -fsS -D "$WORKSPACE/range.headers" -H 'Range: bytes=0-9' "$MEDIA_URL" -o "$WORKSPACE/range.bin"
grep -i '^HTTP/.* 206' "$WORKSPACE/range.headers"
grep -i '^content-range: bytes 0-9/' "$WORKSPACE/range.headers"
test "$(wc -c < "$WORKSPACE/range.bin")" -eq 10
```

feedにShow/Episodeのタイトル、`itunes:duration`、`workers.dev`上の`atom:link`、enclosure URLがあり、各`cmp`が何も表示せず終了コード0、音源の両SHA-256が一致すれば基本動作は合格です。RangeはHTTP 206、`Content-Range`と10 bytesを確認してください。PNGを選んだ場合は画像のURLと保存先の拡張子を`cover.png`・`downloaded-cover.png`に変えてください。

独自ドメインを後で試す場合は、**このworkspaceとCloudflareリソースを維持**してください。`WORKERS_BASE_URL`、`SERVICE_ID`、workspaceのパス、Show/Episode job ID、`job-status`の状態、元MP3/カバーのパスと確認結果を控えます。シェルを閉じるとexportした変数は失われるため、第2段階の前に再設定してください。**API tokenと`.castloop/secrets.json`は共有しないでください。** リソースは自動削除されません。

## 第2段階: 独自ドメインへ移行して戻す（機能公開後のみ）

**ここから先はv0.1.1では実行できません。** `domain add/list/remove`と安全な復帰が実装・検証されたLinux x86-64配布版の公開後、その版のRelease notesと`castloop --help`を確認してから実施します。手順は承認済みの[独自ドメイン計画](../design/custom_domain_plan.md)に基づく**予定の受け入れ手順**です。コマンドや必要権限が公開版で変わった場合は、この文書を先に更新してください。

### 7. ドメインと新しいバイナリを準備する

- 第1段階と**同じ検証サービス・workspace**を使い、Show/Episode jobが`published`かつ受付`free`であることを再確認します。処理中や失敗中のjobがある場合は移行を始めず、そのjobを先に安全に解決してください。
- 対象Cloudflareアカウント内で、権威DNSをCloudflareに移した**Activeなfull zone**と未使用のホスト名（例: `podcasts.example.com`）を用意します。Route 53など外部の権威DNSを維持する方式は対象外です。Cloudflareが既存のWebサイトやメールのDNSをホストしている場合、そのレコードを移行・確認してから行ってください。
- `www`とapexは別物です。例の`podcasts.example.com`のみを登録しても`example.com`や`www.example.com`の転送は設定されません。既存のA/AAAA/CNAME/NSレコードや別のWorkerが使っているホスト名は選ばず、検証用の**新しい名前**を使ってください。独自ドメインは1サービスに1つのみです。
- Cloudflare API tokenに、既存のサービス管理権限に加えてWorkers Scripts Write、Zone Zone Read、DNS Readなど公開版のRelease notesで指定された権限を持たせます。tokenをTOMLやGitに保存しないでください。
- 新Releaseの`castloop-linux-x64`と`SHA256SUMS`を第2節と同様に**別のダウンロードディレクトリ**で取得し、`sha256sum --check SHA256SUMS`の後で検証先のバイナリを更新します。**v0.1.1のchecksumを新バイナリに流用しないでください。** 既存の`castloop.toml`と`.castloop/`をバックアップし、`.castloop/secrets.json`や`.castloop/state.json`は新規生成で置き換えないでください。

同じ検証先のBashで、記録しておいた値を設定し直します。新しいバイナリを配置した後、バージョンと`domain`コマンドを確認してから、**同じworkspace**へ新しいWorkerをデプロイします。

```sh
export WORKSPACE="$HOME/castloop-smoke-workspace"
export COVER_FILE="/absolute/path/to/cover.jpg"
export MP3_FILE="/absolute/path/to/short.mp3"
export SHOW_JOB_ID="PASTE_SHOW_JOB_UUID"
export EPISODE_JOB_ID="PASTE_EPISODE_JOB_UUID"
export CUSTOM_HOSTNAME="podcasts.example.com"
export WORKERS_BASE_URL="$(sed -n 's/^public_base_url = "\(.*\)"$/\1/p' "$WORKSPACE/castloop.toml")"
test -n "$WORKERS_BASE_URL" && test -s "$COVER_FILE" && test -s "$MP3_FILE"
castloop --version
castloop --help
cd "$WORKSPACE"
castloop job-status "$SHOW_JOB_ID" --show smoke-show
castloop job-status "$EPISODE_JOB_ID" --show smoke-show --episode first-episode
castloop deploy
```

`WORKERS_BASE_URL`が`https://<Worker名>.<アカウントsubdomain>.workers.dev`であり、`castloop --help`に`domain add/list/remove`があることを確かめてください。`castloop deploy`は同じサービスのWorkerを更新します。ここで`workers.dev`のfeedとMP3が引き続き取得できることを確認してから次へ進みます。

### 8. 独自ドメインを追加して新旧URLを確認する

```sh
cd "$WORKSPACE"
castloop domain add "$CUSTOM_HOSTNAME"
castloop domain list
export CUSTOM_BASE_URL="$(sed -n 's/^public_base_url = "\(.*\)"$/\1/p' "$WORKSPACE/castloop.toml")"
test "$CUSTOM_BASE_URL" = "https://$CUSTOM_HOSTNAME"

curl -fsS "$CUSTOM_BASE_URL/podcasts/smoke-show/feed.xml" -o "$WORKSPACE/feed-custom.xml"
curl -fsSI "$CUSTOM_BASE_URL/podcasts/smoke-show/feed.xml" | grep -i '^HTTP/.* 200'
grep -F "$CUSTOM_BASE_URL/podcasts/smoke-show/feed.xml" "$WORKSPACE/feed-custom.xml"
grep -F "$CUSTOM_BASE_URL/podcasts/smoke-show/cover.jpg" "$WORKSPACE/feed-custom.xml"
export CUSTOM_MEDIA_URL="$CUSTOM_BASE_URL/podcasts/smoke-show/episodes/first-episode/$EPISODE_JOB_ID.mp3"
grep -F "$CUSTOM_MEDIA_URL" "$WORKSPACE/feed-custom.xml"

test "$(curl -sS -o "$WORKSPACE/feed-old-url.xml" -w '%{http_code}' \
  "$WORKERS_BASE_URL/podcasts/smoke-show/feed.xml")" = "200"
cmp "$WORKSPACE/feed-custom.xml" "$WORKSPACE/feed-old-url.xml"
curl -f "$CUSTOM_MEDIA_URL" -o "$WORKSPACE/downloaded-custom.mp3"
cmp "$MP3_FILE" "$WORKSPACE/downloaded-custom.mp3"
curl -fsSI "$CUSTOM_MEDIA_URL" | grep -iE '^(HTTP/|content-length:|accept-ranges:)'
curl -fsS -D "$WORKSPACE/custom-range.headers" -H 'Range: bytes=0-9' \
  "$CUSTOM_MEDIA_URL" -o "$WORKSPACE/custom-range.bin"
grep -i '^HTTP/.* 206' "$WORKSPACE/custom-range.headers"
grep -i '^content-range: bytes 0-9/' "$WORKSPACE/custom-range.headers"
test "$(wc -c < "$WORKSPACE/custom-range.bin")" -eq 10
curl -f "$CUSTOM_BASE_URL/podcasts/smoke-show/cover.jpg" -o "$WORKSPACE/downloaded-custom-cover.jpg"
curl -fsSI "$CUSTOM_BASE_URL/podcasts/smoke-show/cover.jpg" | grep -i '^HTTP/.* 200'
cmp "$COVER_FILE" "$WORKSPACE/downloaded-custom-cover.jpg"
test "$(curl -sS -o /dev/null -w '%{http_code}' "$CUSTOM_BASE_URL/system/service.toml")" = "404"
test "$(curl -sS -o /dev/null -w '%{http_code}' "$CUSTOM_BASE_URL/admin/health")" = "401"
test "$(curl -sS -o /dev/null -w '%{http_code}' "$CUSTOM_BASE_URL/staging/shows/smoke-show")" = "404"
```

ここでは`curl -k`や`-L`を使わないでください。通常のHTTPSでTLS証明書が有効で、旧`workers.dev`のfeedも**redirectなしのHTTP 200**で取得できることを確認します。feedの`atom:link`、カバー、enclosureは新ドメイン、Showの`site_url`は元の実在サイトURLのままであるべきです。カバーがPNGの場合は画像の拡張子を変更してください。複数Showを公開している場合は各feedでも同じ確認をします。R2の`system/`や`staging/`が外部配信されないことを確認し、Cloudflare Dashboardでも検証用R2 bucketの`r2.dev`公開とR2 Custom Domainが無効であることを確認します。

追加公開も試す場合は、`smoke-show/episode-first-episode.toml`の**タイトルだけ**を変更し、`guid`と`published_at`を維持して`update-episode first-episode`→`publish-episode first-episode`を実行します。新しいjob IDで`job-status`が`published`/`free`になるまで待ち、feedのenclosureが**新ドメインのまま、音源pathとMP3本体は変更されない**ことを確認します。元の`EPISODE_JOB_ID`は音源pathとして引き続き使います。

`domain add`がDNS/TLSの準備待ちや移行途中で失敗したら、**成功扱いにせず**`castloop domain list`と両URLの状態を記録してください。workspaceやCloudflareのリソースを削除せず、公開版が案内する同じ`domain add "$CUSTOM_HOSTNAME"`の再実行手順に従います。`public_base_url`の手編集や手動でのDNS/Worker Domain削除はしないでください。

### 9. 独自ドメインを外して`workers.dev`に戻す

```sh
cd "$WORKSPACE"
castloop domain remove
castloop domain list
export RESTORED_BASE_URL="$(sed -n 's/^public_base_url = "\(.*\)"$/\1/p' "$WORKSPACE/castloop.toml")"
test "$RESTORED_BASE_URL" = "$WORKERS_BASE_URL"
curl -fsS "$RESTORED_BASE_URL/podcasts/smoke-show/feed.xml" -o "$WORKSPACE/feed-restored.xml"
grep -F "$WORKERS_BASE_URL/podcasts/smoke-show/feed.xml" "$WORKSPACE/feed-restored.xml"
grep -F "$WORKERS_BASE_URL/podcasts/smoke-show/episodes/first-episode/$EPISODE_JOB_ID.mp3" \
  "$WORKSPACE/feed-restored.xml"
curl -f "$WORKERS_BASE_URL/podcasts/smoke-show/episodes/first-episode/$EPISODE_JOB_ID.mp3" \
  -o "$WORKSPACE/downloaded-restored.mp3"
cmp "$MP3_FILE" "$WORKSPACE/downloaded-restored.mp3"
```

成功時には全Showの正規URLが`workers.dev`へ戻り、独自ドメインの接続が外れていることを`domain list`で確認します。失敗時は状態を記録してworkspaceを保持し、公開版の再開手順を確認してください。試験終了後もCloudflareの検証用bucket・Queue・Workerなどは自動削除されません。公開済みデータや`.castloop/`を独断で削除しないでください。CloudflareのCustom Domainを削除しても関連する証明書は残る場合があります。

## 実施記録（2026-09-25、Wranglerを使用した旧実装）

### 実施環境

- OS / architecture: Linux x86-64
- Node.js `v24.21.0`、npm `11.19.0`、Bun `1.4.2`、Wrangler `4.131.2`
- `npm ci`、`npm run check`、`npm run build:cli`は成功。`npm ci`では`esbuild`と`workerd`のinstall scriptに関する警告が出たが、型チェックとビルドは完了した。
- `dist/castloop --version`: `0.1.0`（当時の実行ファイル）
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
