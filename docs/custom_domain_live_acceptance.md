# 独自ドメインの実機検証手順（専用hostname）

更新日: 2026-10-09。対象は`feature/custom-domains`でビルドしたCLI／Worker。実機検証は未実施。

新しい試験サービスと未使用のhostnameで、**ドメイン追加 → 配信・公開・非公開化・復元 → Worker更新 → ドメイン削除**を確認します。

各節の確認を終えてから次へ進みます。失敗・不一致があれば第9節に従って停止してください。

## 1. 事前準備

| 項目 | 条件 |
| --- | --- |
| Cloudflare account | 管理者のaccount（既存試験と同じ） |
| Zone | 同accountのactive/full Zone。Cloudflareが権威DNSを提供していること |
| 専用hostname | 例: `castloop-test.YOUR_ZONE`。scheme・path・port・wildcardなし |
| hostnameの空き | Dashboardで、同名のA/AAAA/CNAME/NS、Custom Domain、他サービスのWorker Routeがないことを確認 |
| Service／bucket | 未使用の名前 |
| 素材 | 公開してよいJPEG画像、短いMP3（1 KiB以上）、管理者の実在するサイトURL |

ドメイン接続はcastloopで行います。DNS recordやCustom DomainをDashboardで先に作成しないでください。

API tokenにはWorkers／R2／Queuesの管理権限と、Workers Scripts Write、対象ZoneのZone Read／DNS Readが必要です。

### ビルドと結果の保存先

対象ブランチに未コミット変更がないことを確認し、ビルドします。commit IDとSHA-256を記録してください。

```sh
git status --short --branch
git rev-parse HEAD
npm run build:cli -- linux-x64
sha256sum dist/castloop-linux-x64
```

Linux x86-64の試験先へバイナリを配置し、SHA-256がビルド元と一致することを確認します。試験先にはBash、curl、jq、uuidgen、sha256sum、cmpを用意してください。

公開済みv0.2.1にはdomainコマンドがありません。開発版もversion表示は`0.2.1`なので、commit IDとSHA-256で識別します。

以下のplaceholderを実際の値に置き換え、同じBashセッションで実行します。

```sh
CASTLOOP="/absolute/path/to/castloop-linux-x64"
WORKSPACE="/absolute/path/to/new-domain-test-workspace"
EVIDENCE="/tmp/opencode/domain-acceptance-UNIQUE_RUN"
DOMAIN_HOST="castloop-test.YOUR_ZONE"
DOMAIN_BASE="https://$DOMAIN_HOST"
SITE_URL="https://YOUR_REAL_WEBSITE/podcast"
COVER_FILE="/absolute/path/to/cover.jpg"
MP3_FILE="/absolute/path/to/short.mp3"
SERVICE_ID="domtest-UNIQUE_ID"
BUCKET_NAME="castloop-domain-UNIQUE_ID"
WORKERS_SUBDOMAIN="YOUR_WORKERS_DEV_SUBDOMAIN"

umask 077
mkdir -p "$EVIDENCE"
"$CASTLOOP" help domain > "$EVIDENCE/domain-help.txt"
sha256sum "$CASTLOOP" > "$EVIDENCE/binary.sha256"
export CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
read -r -s -p "Cloudflare API token: " CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
```

`SERVICE_ID`は20文字以内で、英小文字・数字をハイフンで区切った名前にします。`WORKSPACE`と`EVIDENCE`はGit管理外に置き、tokenや`.castloop/secrets.json`を報告・Gitへ添付しないでください。`set -x`は使いません。

## 2. 試験サービスを作成する

```sh
"$CASTLOOP" init "$WORKSPACE" \
  --service-id "$SERVICE_ID" --bucket-name "$BUCKET_NAME" \
  --workers-subdomain "$WORKERS_SUBDOMAIN"
cd "$WORKSPACE"
"$CASTLOOP" service-status > "$EVIDENCE/initialized-service.json"
"$CASTLOOP" domain list > "$EVIDENCE/initialized-domains.json"
```

`initialized-service.json`で、`admission.state = paused`、`admission.invocations = []`、`admission.runtime_readiness.worker_version_id = worker_version_id`を確認します。管理URLを`WORKERS_BASE`へ保存して再開します。

```sh
WORKERS_BASE="$(jq -r '.workers_dev_base_url' "$EVIDENCE/initialized-domains.json")"
INIT_PAUSE_ID="$(jq -r '.admission.pause_id' "$EVIDENCE/initialized-service.json")"
"$CASTLOOP" service-resume "$INIT_PAUSE_ID"
```

CLIの管理操作は常に`WORKERS_BASE`へ接続します。この値は以後変更しません。

## 3. 試験コンテンツを作成する

以下のShow／Episodeを作成します。公開・非公開化・削除は、処理完了を確認してから次の操作へ進みます。

| Show | Episode | ドメイン追加前の状態 |
| --- | --- | --- |
| `domain-a` | `keep` | 公開中 |
| `domain-a` | `hidden` | 公開後、unpublishで非公開化 |
| `domain-a` | `gone` | 公開後、deleteで削除 |
| `domain-a` | `draft` | create-episodeのみ。未公開 |
| `domain-b` | `keep` | 公開中 |
| `domain-idle` | なし | create-showのみ。未公開 |

`domain-a/keep`の作成例です。Showの`image_path`は`cover.jpg`にします。

```sh
"$CASTLOOP" create-show domain-a --site-url "$SITE_URL"
cp "$COVER_FILE" domain-a/cover.jpg
# Edit domain-a/show.toml before staging.
"$CASTLOOP" update-show domain-a
"$CASTLOOP" publish-show domain-a
"$CASTLOOP" job-status SHOW_JOB_UUID

"$CASTLOOP" create-episode domain-a keep
# Edit domain-a/episode-keep.toml before staging.
"$CASTLOOP" update-episode domain-a keep
"$CASTLOOP" update-episode-audio domain-a keep "$MP3_FILE"
"$CASTLOOP" publish-episode domain-a keep "$MP3_FILE"
"$CASTLOOP" job-status EPISODE_JOB_UUID
```

UUIDは各publishの出力にある`job_id`へ置き換えます。公開完了は`job-status`の`server_status.status.state = published`かつ`server_status.ownership = released`です。他のShow／Episodeも表のIDで作成します。

`hidden`／`gone`は、公開完了後、非公開化／削除する前に音源URLとGUIDを保存します。

```sh
"$CASTLOOP" target-episode domain-a hidden > "$EVIDENCE/fixture-hidden-published.json"
"$CASTLOOP" target-episode domain-a gone > "$EVIDENCE/fixture-gone-published.json"
```

非公開化の例です。planの対象・actionを確認し、`REQUEST_SHA256`を`preview.request_sha256`、UUIDを実行結果の`job_id`へ置き換えます。

```sh
"$CASTLOOP" preview-episode-lifecycle domain-a hidden unpublish > "$EVIDENCE/hidden-plan.json"
"$CASTLOOP" lifecycle-execute "$EVIDENCE/hidden-plan.json" REQUEST_SHA256 confirm
"$CASTLOOP" operation-status lifecycle LIFECYCLE_JOB_UUID
```

`gone`の削除では対象を`gone`、actionを`delete`、planファイル名を`gone-plan.json`、承認文字列を`confirm-delete-retain-records`にします。非公開化・削除・復元の完了条件は、`operation-status`の`server_status`が以下をすべて満たすことです。

- `status.state = completed`、`status.phase = finished`
- `ownership = released`、`execution_active = false`、`progress.purge_confirmed = true`

## 4. 変更前の設定・RSS・画像・音源を保存する

```sh
"$CASTLOOP" service-status > "$EVIDENCE/before-service.json"
```

以下の関数はHTTP statusを確認し、headerとbodyを`EVIDENCE`へ保存します。公開URLだけに使い、認証header・証明書検査の無効化・redirect追跡は付けません。

```sh
check_http() {
  local label="$1" expected="$2" code
  shift 2
  code=$(curl --disable --silent --show-error \
    --connect-timeout 10 --max-time 60 \
    --dump-header "$EVIDENCE/$label.headers" \
    --output "$EVIDENCE/$label.body" \
    --write-out '%{http_code}' "$@") || return 1
  printf '%s\n' "$code" > "$EVIDENCE/$label.status"
  test "$code" = "$expected"
}

for SHOW_ID in domain-a domain-b; do
  "$CASTLOOP" target-episode "$SHOW_ID" keep > "$EVIDENCE/before-$SHOW_ID.json" || exit 1
  AUDIO_PATH="$(jq -er '.current_revision.enclosure_url | sub("^https?://[^/]+"; "")' "$EVIDENCE/before-$SHOW_ID.json")" || exit 1
  check_http "before-$SHOW_ID-feed" 200 "$WORKERS_BASE/podcasts/$SHOW_ID/feed.xml" || exit 1
  check_http "before-$SHOW_ID-cover" 200 "$WORKERS_BASE/podcasts/$SHOW_ID/cover.jpg" || exit 1
  check_http "before-$SHOW_ID-audio" 200 "$WORKERS_BASE$AUDIO_PATH" || exit 1
done

AUDIO_PATH="$(jq -r '.current_revision.enclosure_url | sub("^https?://[^/]+"; "")' "$EVIDENCE/before-domain-a.json")"
```

各音源の`sha256sum`と`wc -c`の結果を、対応するJSONの`current_revision.sha256`／`length_bytes`と比較してください。

R2 Dashboardから、両Showの`public/episodes/<showId>/keep/metadata.toml`と、その隣の`revisions/`内の全TOMLをダウンロードします。キー一覧と、キーと同じディレクトリ構造のファイルを`$EVIDENCE/r2-before/`へ保存してください。各変更後に同じキーを取得し、一覧と各TOMLの内容を比較します。

## 5. 停止してドメインを追加する

```sh
ADD_PAUSE_ID="$(uuidgen)"
ADD_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$ADD_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/add-paused.json"
"$CASTLOOP" domain list > "$EVIDENCE/add-paused-domains.json"
```

**共通確認（各変更前・再開前・試験終了時）:**

- `service-status`の`admission.state = paused`、`pause_id`が今回のID、`invocations = []`。
- `target-show domain-a`／`domain-b`／`domain-idle`で`unfinished_show_operation = false`。直前の処理は第3節の完了条件を満たすこと。
- `domain list`の`configuration_matches = connections_match = true`、`local_operations = []`、`admission.url_change`なし。

処理中なら照会を続け、終了を確認してから進みます。

```sh
check_http add-paused-feed 503 "$WORKERS_BASE/podcasts/domain-a/feed.xml" || exit 1
"$CASTLOOP" domain add "$DOMAIN_HOST" --operation-id "$ADD_OPERATION_ID" > "$EVIDENCE/add-result.json"
"$CASTLOOP" domain list > "$EVIDENCE/added-domains.json"
"$CASTLOOP" service-status > "$EVIDENCE/added-service.json"
```

共通確認に加え、追加結果を確認します。

- `add-result.json`は`result = domain-changed-paused`。`operation_id`は`$ADD_OPERATION_ID`と一致。
- `added-domains.json`の接続は指定hostname／Worker／Zoneの1件。`public_base_url`は`$DOMAIN_BASE`、`workers_dev_base_url`は`$WORKERS_BASE`。
- `added-service.json`の`worker_version_id`は`before-service.json`と同じ。
- 両hostの公開feed／画像／音源は503。

確認後に再開します。

```sh
"$CASTLOOP" service-resume "$ADD_PAUSE_ID"
```

## 6. 両hostの配信・公開・非公開化・復元を確認する

`WORKERS_BASE`と`DOMAIN_BASE`の両方で以下を確認します。`check_http`のlabelは重複しない名前にしてください。

| 対象／要求 | 期待値 |
| --- | --- |
| 2 Showのfeed GET／HEAD | 200。GETのRSS本文が両hostで一致 |
| 2 Showのcover GET／HEAD | 200。GETの画像が`before-<showId>-cover.body`と`cmp`で一致 |
| 両Showの`keep`音源 GET／HEAD | 200。GETの音源が`before-<showId>-audio.body`と`cmp`で一致。Content-Length／Content-Typeは`current_revision.length_bytes`／`content_type`と一致 |
| `keep`音源 `--range 0-1023` | 206。本文1024 bytes、`Content-Range: bytes 0-1023/<全体サイズ>`。本文は全量GETの先頭1024 bytesと一致 |
| 取得したETagを`If-None-Match`へ指定 | 304、本文なし |
| 変更前feedのETagをworkers.devのfeedへ指定 | 200。feed自己参照・画像・全音源URLは`$DOMAIN_BASE/`で始まる |
| `hidden`の保存済み音源path | 404。RSSから当該GUIDが除外 |
| `gone`の保存済み音源path | 410。RSSから当該GUIDが除外 |
| `domain-idle`のfeed、未公開`draft` | 未公開Showのfeedは404。RSSに`draft`なし。R2に`domain-idle`の公開feedや`draft`の公開音源がない |
| `/system/service.toml`・試験jobの`/staging/`配下URL | 404。非公開ファイルの本文を返さない |
| 管理鍵なしの`/admin/health` | 401 |

HEAD／Range／条件付きGETの例です。ETagは対応する`.headers`ファイルの値（二重引用符を含む）へ置き換えます。変更前feedのETagは`before-domain-a-feed.headers`から読みます。

```sh
check_http added-domain-audio 200 "$DOMAIN_BASE$AUDIO_PATH"
check_http added-domain-audio-head 200 --head "$DOMAIN_BASE$AUDIO_PATH"
check_http added-domain-audio-range 206 --range 0-1023 "$DOMAIN_BASE$AUDIO_PATH"
AUDIO_ETAG='"PASTE_AUDIO_ETAG"'
check_http added-domain-audio-304 304 --header "If-None-Match: $AUDIO_ETAG" "$DOMAIN_BASE$AUDIO_PATH"
OLD_FEED_ETAG='"PASTE_BEFORE_WORKER_FEED_ETAG"'
check_http added-worker-changed-feed 200 --header "If-None-Match: $OLD_FEED_ETAG" "$WORKERS_BASE/podcasts/domain-a/feed.xml"
```

両ShowのRSSを`before-<showId>-feed.body`と比較します。`atom:link`のfeed自己参照、画像、全`enclosure`のURLは、先頭の`$WORKERS_BASE`だけが`$DOMAIN_BASE`へ置き換わること。既存EpisodeのGUID／pubDateとShowのサイトURLは変わらないことを確認してください。

両`keep`の`target-episode`を再取得し、変更前・変更後のJSONそれぞれから`jq -S '.current_revision'`で抜き出した出力を比較します。R2のキー一覧・TOMLも第4節の保存内容と一致すること。metadata内の音源URLは変えず、RSSだけが新しいドメインのURLを使います。

続けて以下を実施し、各処理の完了を第3節の条件で確認します。

1. `domain-a/after-domain`を新規公開。RSSの新しい音源URLが独自ドメインになること。
2. `domain-a/keep`をunpublishして両hostの音源が404になること。その後restoreして、同じ音源／GUID／revisionで200へ戻ること。
3. `domain-b`をShow unpublishして両hostのfeed／画像／音源が404になること。その後restoreして元の200へ戻ること。

Showのplanは`preview-show-lifecycle domain-b unpublish`／`restore`で作成します。実行方法は第3節と同じです。各操作後、`hidden`は404、`gone`は410、`draft`はRSSにないことも確認してください。

## 7. ドメインを保持したWorker更新

```sh
"$CASTLOOP" domain list > "$EVIDENCE/pre-deploy-domains.json"
DEPLOY_PAUSE_ID="$(uuidgen)"
DEPLOY_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$DEPLOY_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/deploy-paused.json"
```

第5節の共通確認を行ってから更新します。

```sh
"$CASTLOOP" deploy --operation-id "$DEPLOY_OPERATION_ID" > "$EVIDENCE/deploy-result.json"
"$CASTLOOP" service-status > "$EVIDENCE/deployed-service.json"
"$CASTLOOP" domain list > "$EVIDENCE/deployed-domains.json"
```

共通確認に加え、以下を確認して再開します。

- `deployed-service.json`の`worker_version_id`が更新前と異なり、`admission.runtime_readiness.worker_version_id`と一致。
- `pre-deploy-domains.json`と`deployed-domains.json`の`domains`（`id/hostname/service/zone_id`）、`public_base_url`、`workers_dev_base_url`が一致。

```sh
"$CASTLOOP" service-resume "$DEPLOY_PAUSE_ID"
```

両hostからRSS・画像・音源をGETして200を確認します。RSSのfeed自己参照・画像・全音源URLは`$DOMAIN_BASE/`で始まり、画像・音源は第4節の保存ファイルと`cmp`で一致すること。両`keep`の`current_revision`とR2のキー一覧・TOMLも比較します。

## 8. ドメインを削除してworkers.devへ戻す

```sh
REMOVE_PAUSE_ID="$(uuidgen)"
REMOVE_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$REMOVE_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/remove-paused.json"
```

第5節の共通確認を行ってから削除します。

```sh
"$CASTLOOP" domain remove --operation-id "$REMOVE_OPERATION_ID" > "$EVIDENCE/remove-result.json"
"$CASTLOOP" domain list > "$EVIDENCE/removed-domains.json"
"$CASTLOOP" service-status > "$EVIDENCE/removed-service.json"
check_http removed-paused-feed 503 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
```

共通確認に加え、以下を確認して再開します。

- `remove-result.json`は`result = domain-changed-paused`。`operation_id`は`$REMOVE_OPERATION_ID`と一致。
- `removed-domains.json`は`domains = []`。`public_base_url`と`workers_dev_base_url`はともに`$WORKERS_BASE`。
- `removed-service.json`の`worker_version_id`は削除前と同じ。

```sh
"$CASTLOOP" service-resume "$REMOVE_PAUSE_ID"
```

workers.devからRSS・画像・音源をGETして200を確認します。RSSのfeed自己参照・画像・全音源URLは`$WORKERS_BASE/`で始まること。独自ドメイン中に公開した`after-domain`も確認してください。両`keep`の`current_revision`、画像・音源、R2のキー一覧・TOMLは変更前と一致すること。`hidden`は404、`gone`は410、未公開コンテンツは公開されていないことも確認します。

DashboardでCustom Domainの接続がなくなったことを確認します。次のURLへ認証なしでGETし、対象Workerの`service_id`／`worker_name`が返らないことを確認してください。DNS未解決やTLSエラーでも構いません。

```sh
curl --disable --silent --show-error --connect-timeout 10 --max-time 60 \
  "$DOMAIN_BASE/.well-known/castloop/runtime?nonce=$(uuidgen)"
```

試験終了時は新しいpause IDで停止し、第5節の共通確認を行います。Worker／bucket／Queue／DLQと操作記録は保持します。

## 9. 失敗した場合

サービスを再開せず、`service-status`と`domain list`の出力を保存します。workspaceと`.castloop/`を保持してください。

- TLS準備待ち・確認済みのcache purge失敗は、原因解消後に同じhostname・操作IDのコマンドを再実行します。CLIが続行を拒否した場合は停止します。
- 接続／切断要求の結果が不明、lock／実行tokenが残っている、init／deployの結果が不明な場合は、再実行や強制解放を行いません。時間経過だけで終了と判断しないでください。
- HTTPや保存データの比較が不一致なら、そのファイルと操作IDを残して調査します。

応答喪失・設定同期の復旧条件は[利用・復旧手順の「エラー時」](custom_domains.md#エラー時)を参照してください。

## 10. 結果を記録する

`$EVIDENCE/result.md`に以下を記録します。

- 実施日、account／Zone／hostname／Worker／bucket、commit ID／バイナリSHA-256。
- init・add・deploy・removeの操作ID、pause ID、Worker version。
- 第5〜8節の各確認項目の合格／不合格／未実施と、対応する保存ファイル名。
- 最後の停止状態、保持したリソース、未解決事項。エラーは`reason_code`を記録し、秘密やmetadata本文を報告へ転載しないこと。

参照: [利用・復旧手順](custom_domains.md)、[実装計画](../design/custom_domain_plan.md)。
