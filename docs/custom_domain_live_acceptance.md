# 独自ドメインの実機検証手順（専用hostname）

作成日: 2026-10-05

状態: **実行前の手順書。実機検証は未実施。**

対象: `feature/custom-domains`のCLI／Worker（実装commit `4877da0`以降）。

## 1. 目的・範囲

専用M6サービスで **workers.dev公開 → 独自domain追加 → 明示再開 → 公開・停止／restore → 通常deploy → domain削除 → 明示再開** を確認します。

- 本番・既存利用者のhostnameは使いません。原則、新しい試験サービスと未使用のhostnameを使います。
- 実行前にaccount・Zone・hostname・workspace・作成するリソースを管理者が確認してください。この文書の作成では実環境を変更していません。
- Workers Paid、有料オプション、無停止移行、旧形式変換、網羅的な障害注入は対象外です。R2／Queues等の利用料がゼロという保証ではありません。
- 小さいMP3で実施します。既存の[M6の300 MB受け入れ](../design/m6_standalone_acceptance.md)を再利用し、300 MBを再uploadする必要はありません。
- unknown owner／token／lockがある環境は再利用・更新・解放しません。特に`castloop-m6-test-ff3bfd8c`は対象外です。

コードブロックは一括実行用scriptではありません。確認点ごとに止め、コマンドが非0終了・HTTP確認が不一致なら先へ進まず第10節へ移ります。

## 2. 事前準備

### 対象を決める

| 項目 | 条件／記録する値 |
| --- | --- |
| Cloudflare account | 既存の試験と同じ、管理者自身のaccount |
| Zone | 同accountのactive/full Zone。Cloudflareが権威DNS |
| 専用hostname | 例: `castloop-test.YOUR_ZONE`。scheme・path・port・wildcardなし |
| hostnameの空き | 既存のA/AAAA/CNAME/NS、Custom Domain、他サービスのWorker RouteがないことをDashboardで確認 |
| Service／bucket | 未使用の名前。既存v0.1.xサービスを変換・採用しない |
| 素材 | 公開してよいJPEG／PNG、短い正規のMP3（1 KiB以上）、管理者の実在するサイトURL |

DNS recordやCustom DomainをDashboardから先に作らないでください。接続／切断はcastloopに行わせます。別hostnameへの切替・www/apex aliasは試しません。

API tokenは既存のWorkers／R2／Queues管理権限に加え、domain操作のWorkers Scripts Write、対象ZoneのZone Read／DNS Readを確認します。権限不足ならtokenの範囲を見直し、既存DNSや有料planは変更しません。

### バイナリと証拠保存先

ビルド元で対象commitを固定し、ソース差分がないことを確認して実行します。

```sh
git rev-parse HEAD
npm run check
bun test
npm run build:cli -- linux-x64
sha256sum dist/castloop-linux-x64
```

Linux x86-64の試験先にバイナリを置き、ビルド元とSHA-256を照合します。試験先の管理操作はこの単一バイナリのみで行い、Bun／Node.js／Wranglerは不要です。HTTP確認用にBash、curl、jq、uuidgen、sha256sum、cmpを用意します。

**現時点の開発buildもversion表示は`0.2.1`です。versionだけで判定せず、commit・バイナリSHA-256・`help domain`を記録してください。公開済みv0.2.1バイナリでは実施できません。**

以下の値を自分の値へ置き換え、以後は同じBashセッションで実行します。

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

`SERVICE_ID`は20文字以内の英小文字・数字・ハイフンです。上の大文字placeholderをそのまま使わないでください。workspace／証拠保存先はGit管理外とし、`set -x`は使いません。token、管理鍵、`.castloop/secrets.json`を報告やGitへ添付しません。

## 3. 対応Workerを用意する

推奨は新しい試験サービスです。**initは一度だけ**実行します。

```sh
"$CASTLOOP" init "$WORKSPACE" \
  --service-id "$SERVICE_ID" --bucket-name "$BUCKET_NAME" \
  --workers-subdomain "$WORKERS_SUBDOMAIN"
cd "$WORKSPACE"
"$CASTLOOP" service-status > "$EVIDENCE/initialized-service.json"
```

合格条件: initialized／paused、`admission.invocations`が空、runtime readinessが保存済み。`castloop.toml`から`workers_dev_base_url`を読み、`WORKERS_BASE`へ**同じWorkerのHTTPS origin**を設定します。以後これを変更しません。

```sh
WORKERS_BASE="https://ACTUAL_WORKER.ACTUAL_SUBDOMAIN.workers.dev"
INIT_PAUSE_ID="$(jq -r '.admission.pause_id' "$EVIDENCE/initialized-service.json")"
"$CASTLOOP" service-resume "$INIT_PAUSE_ID"
```

既存の**利用許可済み・正常終了した専用M6サービス**を使う場合はinitしません。workspaceを保持し、後述の停止・終了確認を行ってから対象buildの`deploy`を一度実行し、検証済みruntimeで明示再開します。CLIだけを更新してdomain操作を始めないでください。

init／deployの結果が不明なら、この段階で停止します。再実行やworkspace作り直しで回避しません。

## 4. 小さい試験コンテンツを用意する

次のfixtureをこのサービス内だけで作ります。各公開／lifecycle jobの終了を確認してから次の操作へ進んでください。

| Show | Episode | domain追加前の状態 |
| --- | --- | --- |
| `domain-a` | `keep` | active。音源／metadata／revisionの不変確認用 |
| `domain-a` | `hidden` | 一度公開後、unpublishしておく |
| `domain-a` | `gone` | 一度公開後、**この試験データだけを**明示deleteしておく |
| `domain-a` | `draft` | create-episodeのみ。未公開 |
| `domain-b` | `keep` | active。複数Showのfeed切替確認用 |
| `domain-idle` | なし | create-showのみ。未公開Showの不復活確認用 |

公開方法の例です。Show TOMLの内容と`image_path`、Episode TOMLを編集し、GUID／`published_at`は維持します。

```sh
"$CASTLOOP" create-show domain-a --site-url "$SITE_URL"
cp "$COVER_FILE" domain-a/cover.jpg
# Edit domain-a/show.toml before staging.
"$CASTLOOP" update-show domain-a
"$CASTLOOP" publish-show domain-a
"$CASTLOOP" job-status SHOW_JOB_UUID

cd "$WORKSPACE/domain-a"
"$CASTLOOP" create-episode keep
# Edit episode-keep.toml before staging.
"$CASTLOOP" update-episode keep
"$CASTLOOP" update-episode-audio keep "$MP3_FILE"
"$CASTLOOP" publish-episode keep "$MP3_FILE"
cd "$WORKSPACE"
"$CASTLOOP" job-status EPISODE_JOB_UUID
```

UUIDは直前の結果からコピーします。publicationの完了は`server_status.status.state = published`かつ`server_status.ownership = released`です。受付結果だけで次へ進みません。`domain-b/keep`等も同じ手順で作ります。PNGを使う場合は拡張子と`image_path`を揃えます。

`hidden`／`gone`の公開が完了した時点で、**非公開化／削除する前に**音源pathとGUIDを保存します。削除後はmetadataが失われるため後から取得する前提にしません。

```sh
"$CASTLOOP" target-episode domain-a hidden > "$EVIDENCE/fixture-hidden-published.json"
"$CASTLOOP" target-episode domain-a gone > "$EVIDENCE/fixture-gone-published.json"
```

lifecycleは次の形で固定planを確認して実行します。`hidden`はunpublish、`gone`はdeleteへ置き換えます。

```sh
"$CASTLOOP" preview-episode-lifecycle domain-a hidden unpublish > "$EVIDENCE/hidden-plan.json"
# Review the target/action and copy preview.request_sha256.
"$CASTLOOP" lifecycle-execute "$EVIDENCE/hidden-plan.json" REQUEST_SHA256 confirm
"$CASTLOOP" operation-status lifecycle LIFECYCLE_JOB_UUID
```

deleteの承認文字列は`confirm-delete-retain-records`です。対象がこの試験の`gone`であることを確認してから使います。lifecycle完了はstate `completed`、phase `finished`、ownership `released`、`execution_active = false`、`progress.purge_confirmed = true`です。

## 5. 変更前の基準を保存する

```sh
"$CASTLOOP" service-status > "$EVIDENCE/before-service.json"
"$CASTLOOP" domain list > "$EVIDENCE/before-domains.json"
"$CASTLOOP" target-episode domain-a keep > "$EVIDENCE/before-a.json"
"$CASTLOOP" target-episode domain-b keep > "$EVIDENCE/before-b.json"
"$CASTLOOP" list-shows --include-deleted --json > "$EVIDENCE/before-shows.json"
"$CASTLOOP" list-episodes domain-a --include-deleted --json > "$EVIDENCE/before-episodes.json"
```

domain listは0接続、`configuration_matches = true`、`connections_match = true`、`local_operations = []`であることを確認します。Show／Episode照会に未完了ownerがないことも確認します。一覧が複数ページなら最後まで照会してください。

以下のHTTP記録helperは**公開アクセスだけ**に使います。認証header、`-k`、redirect追跡、mutationの自動retryは付けません。

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

AUDIO_PATH="$(jq -r '.current_revision.enclosure_url | sub("^https?://[^/]+"; "")' "$EVIDENCE/before-a.json")"
check_http before-worker-feed-a 200 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
check_http before-worker-feed-a-warm 200 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
check_http before-worker-audio 200 "$WORKERS_BASE$AUDIO_PATH"
sha256sum "$EVIDENCE/before-worker-audio.body" > "$EVIDENCE/before-audio.sha256"
```

同様に`domain-b`のfeed、cover、音源も取得して基準を保存します。音源pathはRSS／`current_revision.enclosure_url`から取得し、job IDから推測しません。実データのSHA-256／サイズが`current_revision.sha256`／`length_bytes`と一致することを確認します。

R2 Dashboardの**読み取りのみ**で、2つの`keep`の`metadata.toml`、`revisions/`配下のキーと内容のhash、音源キー／サイズ／checksumも保存します。checksumが表示されない場合は短い音源をdownloadしてSHA-256を計算し、ETagをSHA-256の代用にしません。domain操作後とdeploy後に比較します。CLI target照会は`payloads_verified = false`であり、それだけを全履歴・音源の不変証明にはしません。

HTTPを2回取得しただけでは内部cache HITの証明にはなりません。今回は変更前に取得したfeedが変更後に残らないことを確認し、内部HITの実証は既存M6受け入れを再利用します。

## 6. 停止・domain追加・明示再開

```sh
ADD_PAUSE_ID="$(uuidgen)"
ADD_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$ADD_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/add-paused.json"
```

**domain addの前に止めて確認すること:** state `paused`、pause ID一致、invocations空、全Showの登録完了・owner終了、local lock不在。statusが未確認なら読み取りだけを有限回再照会します。pausedや時間経過だけでdrainedとしません。

```sh
check_http add-paused-feed 503 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
"$CASTLOOP" domain add "$DOMAIN_HOST" --operation-id "$ADD_OPERATION_ID" > "$EVIDENCE/add-result.json"
"$CASTLOOP" domain list > "$EVIDENCE/added-domains.json"
"$CASTLOOP" service-status > "$EVIDENCE/added-service.json"
```

追加後の合格条件:

- `result = domain-changed-paused`、操作ID一致。接続は指定hostname／対象Worker／対象Zoneの1件だけ。
- 正規URLは`DOMAIN_BASE`、管理URLは元の`WORKERS_BASE`。設定一致／接続一致がtrue。
- `admission.url_change`なし、invocations空、unfinishedなlocal操作なし。local journalは`completed = true`、remote進捗は`complete`、必要なreceiptを保持。
- Worker version／deploymentは追加前と同じ。R2とlocal設定のhashが整合し、必要なruntime readinessの設定hashだけが更新。
- 公開feed／cover／音源は**両hostとも503のまま**。勝手に再開しない。

TLS準備待ちで終了した場合は第10節に従い、再開しません。追加済みのhostへの秘密なしprobeは次の形で確認できます。

```sh
PROBE_NONCE="$(uuidgen)"
check_http added-probe 200 "$DOMAIN_BASE/.well-known/castloop/runtime?nonce=$PROBE_NONCE"
```

probeのnonce、service ID、Worker名、Worker versionが今回の値と一致し、`Cache-Control: no-store`であることを確認します。証明書検査を無効化した成功やredirect先の200は合格ではありません。

```sh
"$CASTLOOP" service-resume "$ADD_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/added-open-service.json"
check_http added-worker-feed-a 200 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
check_http added-domain-feed-a 200 "$DOMAIN_BASE/podcasts/domain-a/feed.xml"
cmp "$EVIDENCE/added-worker-feed-a.body" "$EVIDENCE/added-domain-feed-a.body"
```

## 7. 両hostの配信・公開・lifecycleを確認する

次の表を**両host**で確認します。`check_http`に一意なlabelを付け、header／body／statusを保存してください。

| 対象／要求 | 期待値 |
| --- | --- |
| activeな2 Showのfeed GET／HEAD | 200。両hostのRSS本文が一致 |
| activeなcover GET／HEAD | 200。画像の内容／サイズが基準と同じ |
| `keep`音源のGET／HEAD | 200。全量hash／サイズ／Content-Typeが基準と同じ |
| `keep`音源 `--range 0-1023` | 206、1024 bytes、Content-Rangeが整合。先頭bytesが全量GETと一致 |
| 取得したETagを`If-None-Match`へ指定 | 304、本文なし |
| 変更前feedのETagをworker側feedへ指定 | 200。新しい独自domain正規URLの本文であり、古いfeedを304で返さない |
| `hidden`の保存済み音源path | 404。RSSから当該GUIDが除外 |
| `gone`の保存済み音源path | 410。RSSから当該GUIDが除外 |
| `domain-idle`のfeed、未公開`draft` | RSSに現れず、未公開Showのfeedは404。R2にdraft用の公開feed／音源を新規作成しない |
| `/system/service.toml`・既知staging path | 404。private内容なし |
| 管理鍵なしの`/admin/health` | 401 |

HEAD／Range／条件付きGETの例です。ETagは保存したheaderから、二重引用符を含む実際の値へ置き換えます。

```sh
check_http added-domain-audio 200 "$DOMAIN_BASE$AUDIO_PATH"
check_http added-domain-audio-head 200 --head "$DOMAIN_BASE$AUDIO_PATH"
check_http added-domain-audio-range 206 --range 0-1023 "$DOMAIN_BASE$AUDIO_PATH"
AUDIO_ETAG='"PASTE_AUDIO_ETAG"'
check_http added-domain-audio-304 304 --header "If-None-Match: $AUDIO_ETAG" "$DOMAIN_BASE$AUDIO_PATH"
OLD_FEED_ETAG='"PASTE_BEFORE_WORKER_FEED_ETAG"'
check_http added-worker-changed-feed 200 --header "If-None-Match: $OLD_FEED_ETAG" "$WORKERS_BASE/podcasts/domain-a/feed.xml"
```

`hidden`／`gone`の音源pathとGUIDは非公開化／削除前に保存してください。`draft`には公開音源URLがないため、URLを捏造して不変を判定しません。

RSSはXMLとして確認し、feed自己参照・cover・**全enclosure**のoriginが`DOMAIN_BASE`であること、GUID／pubDate／ShowのサイトURLが基準と同じことを確認します。保存済みmetadataに古いenclosure originが残ることは仕様です。RSSが現在の正規URLへ組み直されているかを判定します。

追加後の`target-episode`を取り直し、`jq -S '.current_revision'`で変更前と比較します。R2の媒体・metadata・revision inventory／hashも一致させます。世代やservice状態が異なるため、target応答全体の一致は要求しません。

続けて次の**変更入口だけ**を一度ずつ確認します。M6全操作の異常系は再実施しません。

1. 独自domain稼働中に`domain-a/after-domain`を新規公開する。管理操作はworkers.devで成功し、RSSの新enclosureは独自domainになる。
2. `domain-a/keep`をunpublish → 完了確認 → restore → 完了確認。warm済み音源が両hostで404になり、restore後に同じbytes／GUID／revisionで200へ戻る。
3. `domain-b`をShow unpublish → 完了確認 → restore → 完了確認。両hostのfeed／cover／音源が404 → 元の200へ戻る。

Show操作は`preview-show-lifecycle domain-b unpublish`または`preview-show-lifecycle domain-b restore`でplanを作ります。各操作後に上のHTTP確認を繰り返し、`hidden`／`gone`／`draft`は復活していないことを確認します。headerのcache HIT表示だけでpurge成功を判定せず、変更後の状態／内容も確認します。

## 8. 独自domainを保持した通常deploy

```sh
"$CASTLOOP" domain list > "$EVIDENCE/pre-deploy-domains.json"
"$CASTLOOP" target-episode domain-a keep > "$EVIDENCE/pre-deploy-a.json"
DEPLOY_PAUSE_ID="$(uuidgen)"
DEPLOY_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$DEPLOY_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/deploy-paused.json"
```

第6節と同じ終了確認をしてから実行します。

```sh
"$CASTLOOP" deploy --operation-id "$DEPLOY_OPERATION_ID" > "$EVIDENCE/deploy-result.json"
"$CASTLOOP" service-status > "$EVIDENCE/deployed-service.json"
"$CASTLOOP" domain list > "$EVIDENCE/deployed-domains.json"
"$CASTLOOP" service-resume "$DEPLOY_PAUSE_ID"
```

合格条件: 新しいWorker versionと検証済みreadinessでpaused完了し、明示再開できること。domainの`id/hostname/service/zone_id`、正規URL／管理URL、Episode current revision全体、媒体／履歴が維持されること。第7節の配信表を再確認します。domainの再接続やデータ変換はしません。

## 9. domain削除・workers.devへの復帰

```sh
REMOVE_PAUSE_ID="$(uuidgen)"
REMOVE_OPERATION_ID="$(uuidgen)"
"$CASTLOOP" service-pause "$REMOVE_PAUSE_ID"
"$CASTLOOP" service-status > "$EVIDENCE/remove-paused.json"
```

同じ終了確認をしてから進めます。

```sh
"$CASTLOOP" domain remove --operation-id "$REMOVE_OPERATION_ID" > "$EVIDENCE/remove-result.json"
"$CASTLOOP" domain list > "$EVIDENCE/removed-domains.json"
"$CASTLOOP" service-status > "$EVIDENCE/removed-service.json"
check_http removed-paused-feed 503 "$WORKERS_BASE/podcasts/domain-a/feed.xml"
"$CASTLOOP" service-resume "$REMOVE_PAUSE_ID"
```

合格条件:

- 接続0件、正規URL／管理URLは`WORKERS_BASE`、設定／接続一致、URL owner／invocation／unfinished local操作なし。
- 削除操作ではWorker versionが変わらず、paused完了 → 明示再開となる。
- worker側の全feed URLはworkers.devへ戻る。**独自domain中に公開した`after-domain`も含む全enclosure**が戻る。
- 音源path／bytes、metadata／revision／GUID／pubDate／サイトURLを維持し、非公開／削除／draftは復活しない。
- 第7節のworker側HTTP確認が合格する。独自hostnameは対象Workerへ到達しなくなる。

切断後の独自hostはDNS未解決、TLSエラー等もあり得るため、HTTP 404だけを必須にしません。Dashboardの接続解除と新しいnonceのprobeで確認し、反映待ちは読み取りだけを有限回行います。同じWorker probeが返り続ける場合は不合格です。削除操作の再送、残った証明書の手動削除、Zone全体のDNS変更は行いません。

試験終了時は、新しいpause IDでサービスを停止し、invocations／ownerが空であることを記録します。**Worker／bucket／Queue／DLQ／操作記録は保持します。** リソース一式の削除は別途対象を確認した操作で行い、本手順の完了処理には含めません。

## 10. 失敗時の停止・続行条件

| 状況 | 対応 |
| --- | --- |
| TLS待ち。接続receipt確認済み、pending／execution token／lockなし | DNS/TLSの読み取り確認後、同じhostname・操作IDのaddを明示再実行。resumeしない |
| 確認済みpurge失敗 | 原因解消後、同じ固定要求を続行。別job／新hostnameで回避しない |
| 管理API応答喪失／local設定未同期 | domain listとjournalを保存。同じ要求のsettledなreceipt／進捗をCLIが検証できる場合だけ同じコマンドで続行 |
| Cloudflare PUT／DELETEそのものが不明、Worker実行token／lock残存 | **停止・保持。再送／強制解放／時間による失効／設定書換えをしない** |
| 未知のinit／deploy、期待と違う接続／設定／Worker | 停止し証拠を保存。採用・再初期化・再配備・自動rollbackしない |

自然発生した失敗だけを扱います。実機で通信切断、強制終了、purge権限の剥奪等を意図的に行う試験は今回は不要です。復旧に失敗してblockedのままなら、合格扱いせず未完了として報告してください。

## 11. 実施結果の最小記録

- 実施日、account／Zone／専用hostname／Worker／bucket、build commit／バイナリSHA-256。
- init（または事前更新）、add、通常deploy、removeの操作ID・pause ID・Worker version。
- 2 Showの切替、両host GET／HEAD／Range／304、private経路、非公開・削除データの不復活。
- 媒体／metadata／revision／GUID／pubDateの不変、canonical URLの往復、lifecycle／新規公開、完了時のowner解放。
- エラーがあれば、allowlistedなreason codeと未完了状態。秘密や任意例外文、公開metadata本文をGitの結果報告へ複製しない。
- 最後のpaused状態、保持リソース、未解決事項。実施していない項目を合格としない。

参照: [利用・復旧手順](custom_domains.md)、[実装計画](../design/custom_domain_plan.md)、[M6既存受け入れ](../design/m6_standalone_acceptance.md)、[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
