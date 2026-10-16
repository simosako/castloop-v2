# SQLite逐次公開方式の開発版

`feat/sqlite-sequential-publication`向け。**公開済みv0.4.0の機能ではなく、Cloudflare実機受け入れ・性能測定は未実施**。
新しい隔離環境だけを対象とし、既存サービスや旧journalを変換しない。

## 対応範囲

- 1サービスにつき1つのSQLite-backed DO。明示公開をFIFOで一件ずつAlarm実行する。
- Show登録、Show/Episodeのローカル作成、素材upload、公開、status、pause/resume、fresh init。
- metadata-onlyは既存音源を再利用。audio-onlyはmetadataのbaseも照合する。
- GET/HEAD/Range/条件付き応答は既存配信部品を利用し、外側gatewayが毎回DOの最新配信判定を見る。
- `list-shows`/`list-episodes`はSQLiteの20件ずつの一覧。`--json`、`--include-deleted`、`--cursor`に対応し、R2のmetadata列挙はしない。cursorはruntimeと検索条件へ束縛する。ローカルだけのdraftは含めない。
- Show/Episodeの非公開化・保存済みsnapshotの復元は、preview→hash確認→`lifecycle-execute`で同じFIFOへ送る。
- 新規環境はworkers.devのみ。**物理削除、deploy/互換更新、独自ドメイン、既存移行、RSSのサーバー公開連携、retry/releaseは未対応**。旧方式へfallbackしない。

## 初期化

次は管理者が新環境の作成・配備を承認した場合の操作例であり、本開発作業中に実行したものではない。

```sh
castloop init ./new-service --publication-protocol sqlite-sequential-v1 \
  --service-id my-service --bucket-name UNIQUE-PRIVATE-BUCKET \
  --account-id ACCOUNT_ID --workers-subdomain YOUR_SUBDOMAIN \
  --operation-id INIT_UUID
```

`UNIQUE-PRIVATE-BUCKET`は実際には小文字の有効なR2 bucket名へ置き換える。
Cloudflare認証は`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`だけを使う。
tokenには資源作成・Worker配備・R2操作・DO namespace確認に必要な権限が必要だが、自動拡張しない。
Wrangler、Node.js、別R2 credential、Queues/D1/DLQは不要。

`castloop.toml`はschema version 2。管理秘密鍵と凍結journalはgit-ignoredな`.castloop/`へ保存する。
初期化はresource/APIの設定・version/ETag/namespace/単一100%配備を照合し、
さらに**実DOのSQL、Alarm、R2設定読取、同versionのcache ownerとpurge**を確認する。
REST設定を読んだだけではreadyにしない。完了時はpausedのまま。

```sh
cd new-service
castloop service-status
castloop service-resume NEW_WINDOW_UUID
```

SQLite方式のresume UUIDは**新しい受付window**であり、init UUIDやpauseコマンドのUUIDとは別にする。
`service-status`のdrainedは受け付けた公開jobについてのsnapshotであり、未登録uploadの不存在や回復権限を示さない。

## Show/Episodeの公開

```sh
castloop create-show my-show --site-url https://YOUR_REAL_WEBSITE/
# Edit my-show/show.toml and place its JPEG/PNG cover file.
castloop update-show my-show
castloop publish-show my-show

cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first
```

- `create-*`は公開しない。`update-*`は一意のR2 keyへのuploadとローカルreceipt保存だけで、サーバーのstage-start許可を待たない。
- MP3上限は300,000,000 bytes。MP3解析・サイズ・全量readback/hash・ETag/versionを確認した素材だけを公開manifestへ登録する。
- 初回Episodeにはmetadataと音源が両方必要。その後はmetadata-only/audio-onlyが可能。
- `publish-*`は要求をローカルへ凍結してDOへ送信し、完了を最大300回・新規poll開始5分まで待つ。
- `accepted/queued`は公開成功ではない。`succeeded`は保存・purge・SQL完了記録が成功した**その操作**の結果。
- 凍結後は素材を変更しない。次の編集では、既知の完了/確定入力失敗を確認・archiveして別draft IDに進む。

## 非公開化・復元

サービスrootで、例えば次のように操作する。

```sh
castloop preview-episode-lifecycle my-show first unpublish > plan.json
# Review the target, action and request_sha256 in plan.json.
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm
castloop job-status JOB_UUID
```

Show単位は`preview-show-lifecycle my-show unpublish`、復元は`restore`を指定する。
previewは読取だけ。`lifecycle-execute`の`queued`は完了ではなく、同じjobの`succeeded`まで確認する。
非公開化は全revisionの直リンクを止め、Episodeだけの場合はfeedからも除外する。payloadは削除しないため、ストレージ使用量は減らない。
Show停止は子Episodeの状態を上書きしない。Show復元でも個別停止Episodeは復活しない。
復元はGUID・日時・音源URL・revisionを変えず、未公開のローカル編集も取り込まない。
Episodeの停止/復元世代を照合するため、一度停止・復元を挟んだ古いdraftが同じrevisionを根拠に公開されることはない。

## 異常時

```sh
castloop job-status JOB_UUID
castloop service-status
```

応答不明でもPUT/POSTを自動再送せず、同じupload keyや別jobへ置換しない。
既に凍結した`publish-*`を再度呼んだ場合も、同じ要求のstatus確認だけを行う。
`failed`は公開書込前の確定的な入力/base失敗、`blocked`は途中停止・書込不明・purge失敗等であり、後続を停止する。
時間経過やHEAD不在で解除しない。blockedのretry/releaseは提供していない。

初期化では、R2/Worker作成・PUT・配備・公開設定の各要求前にjournalを保存する。
途中停止後の`init`はmutationを繰り返さない。
`init-reconcile INIT_UUID`は、配備receiptと正確なsetup identityが保存され、
**サーバーで既にready/paused/drainedの完了を読取確認できる場合だけ**ローカル記録を確定する。
未知deployの探索・採用・再配備や強制掃除を行うコマンドではない。

物理deleteと未登録uploadのsettlement契約は未実装。空のキューを根拠にbucketやprefixを削除しない。

## 検証の限界

ローカルではBun SQLite、模擬R2/Cache/Cloudflare REST、実CLI entrypointの独立processによるwalkthroughを実施した。
Worker/DO classは実platform型で型検査・browser bundle化し、Linux単体CLIには新旧両Workerを埋め込む。
**模擬storageのtransaction/AlarmとCloudflare実機のoutput gate・再配送、模擬purgeと実Workers Cache purgeは区別する。**
Issue #13恒久解消、FreeのHTTP 10ms適合、36件性能目標、実機release readinessはまだ示していない。
