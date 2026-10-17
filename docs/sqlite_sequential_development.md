# SQLite逐次公開方式の開発版

`feat/sqlite-sequential-publication`向け。**公開済みv0.4.0の機能ではない**。
2026-10-16の最初の実機試験は15件目のpurge段階でblockedとなった。別途承認された新環境では、修正版`da7c4bd`で小容量・36件公開・metadata-only 10回・一覧を通過し、pausedで終了した。観測runnerの中断とCPU欠測は残るため、全Free適合・恒久的なIssue #13解消・release受け入れとは区別する。詳細は[測定記録](../design/sqlite_sequential_measurement_20261016.md)を参照。
2026-10-17 JSTの[追加確認](../design/sqlite_followup_verification_20261016.md)では、同じ隔離サービスの互換更新と正式RSSの3 Episode公開も通過した。更新時のversion伝播待ちと観測schemaを修正し、完了済み配備・activationを繰り返さずpausedで終了。最終試験でもCPU/jobログの欠測は残る。
新しい隔離環境だけを対象とし、既存サービスや旧journalを変換しない。

## 対応範囲

- 1サービスにつき1つのSQLite-backed DO。明示公開をFIFOで一件ずつAlarm実行する。
- Show登録、Show/Episodeのローカル作成、素材upload、公開、status、pause/resume、fresh init。
- metadata-onlyは既存音源を再利用。audio-onlyはmetadataのbaseも照合する。
- GET/HEAD/Range/条件付き応答は既存配信部品を利用し、外側gatewayが毎回DOの最新配信判定を見る。
- `list-shows`/`list-episodes`はSQLiteの20件ずつの一覧。`--json`、`--include-deleted`、`--cursor`に対応し、R2のmetadata列挙はしない。cursorはruntimeと検索条件へ束縛する。ローカルだけのdraftは含めない。
- Show/Episodeの非公開化・保存済みsnapshotの復元は、preview→hash確認→`lifecycle-execute`で同じFIFOへ送る。
- レビュー済みのローカルRSS取り込みは`publish-rss-import DIRECTORY`でShow→Episodeの順に公開できる。
- 同じconfig/SQLite schema/namespaceのcode-only互換更新を`deploy`で扱う。明示pause/drain後に実行し、新versionのprobe後もpausedを維持する。
- 新規環境はworkers.devのみ。**物理削除、独自ドメイン、既存移行、公開jobのretry/releaseは未対応**。旧方式へfallbackしない。

## 初期化

次は管理者が新環境の作成・配備を承認した場合の操作例。隔離試験への承認を、既存サービスや別環境の変更許可として流用しない。

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
- SQLite cache ownerはtag/prefixを1回のpurgeへまとめる。明確なrate-limit拒否だけは同じrunning実行内で12秒間隔・最大6 attemptsを行い、保存をやり直さない。未知応答・恒久拒否は停止する。この有限待機はblocked jobのretry/release機能ではない。
- 凍結後は素材を変更しない。次の編集では、既知の完了/確定入力失敗を確認・archiveして別draft IDに進む。

## 互換Worker更新

```sh
castloop service-pause PAUSE_OPERATION_UUID
castloop service-status
# Wait until paused, drained and publication_ready are all true.
castloop deploy --operation-id UPDATE_UUID
castloop service-status
castloop service-resume NEW_WINDOW_UUID
```

未完了job、blocked、未確認runtime、設定変更、別namespace、古いcontent schemaがある場合は配備へ進まない。
更新準備をDOへ保存した後は、更新完了までresume・登録・公開・配信を閉じる。新versionでAlarm/R2/cache owner/purgeを再検証し、成功してからreadyにする。
R2 payloadの書換えやresource作成は行わない。キューがdrainedでも未登録uploadがないとは判断せず、物理削除の許可に使わない。

unknownな準備/配備/activationを再送しない。配備receiptと正確なsetup完了を読取確認できる場合だけ、次を使える。

```sh
castloop update-service-reconcile UPDATE_UUID
```

これはGETによる照合とローカル記録の確定だけで、未知deployの採用・再配備・probeの再実行・強制解放を行わない。
独自ドメインや設定変更、schema変換はこの更新コマンドの対象外。

RESTの配備成功直後でも、DOがしばらく旧versionで応答する場合がある。
CLIは一致するprepared状態の旧versionだけを有限回GETで観測し、記録済み新versionになるまでactivationしない。
この待機だけで停止し、journalが`verified`（配備応答・REST照合済み、activation未要求）の場合に限り、次で続けられる。

```sh
castloop update-service-verify UPDATE_UUID
```

これは読み取り専用ではない。凍結source/config/metadataと既知receipt/namespaceを再照合し、新native versionで**初回activation/probeだけ**を行う。
配備・準備・R2 uploadは繰り返さない。`activation_requested`や未知prepare/deployには使えず、完了後はpausedのまま。

## ローカルRSS取り込みの公開

既存の`import-rss`で作ったローカル取り込みをレビューした後、サービスrootで実行する。

```sh
castloop publish-rss-import ./reviewed-import
```

既存/削除済みShowを採用せず、新しいShowとして順次公開する。元のGUID・permalink属性・公開日時を保持し、音源は新しいサービスへ保存する。
途中のEpisodeも完了ごとに公開され、全件一括の原子公開ではない。最後にpublic feedのmetadata・件数・identity・内部音源URLを照合する。
subscriber移行や旧ホスト撤去の完了を意味しない。

再実行は完了済みの公開を繰り返さない。保存済みpublication jobがある公開途中停止は、**そのjob IDのstatusを読むだけ**で照合・待機する。
未確認のupload/登録/ローカルinstallは自動再実行しない。取り込み元の編集、別draftへの置換、不明な要求の再送で先へ進めない。
公開前にstaged receiptをレビュー済みmetadata/cover/audioと照合し、事前検証後の素材差し替えも拒否する。

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
管理APIの読み取りGETは、一時的な通信・本文読取エラー、408/429/500/502/503/504だけを**初回を含め最大3試行**する。
1試行は最大10秒、試行開始の総予算は30秒で、待機は通常250ms→500ms。`Retry-After`が長い場合は予算内だけ尊重する。
開始済みIOと応答cleanupの終了を待ち、時間切れだけで旧IOを切り離して次を始めない。
401/403等の恒久拒否、JSON/schema・identity不一致、不正header、サイズ超過、cleanup失敗は再試行しない。
公開完了待機では、再試行も既存の最大300 GETに数え、5分を過ぎて新しいGETを開始しない。進行中のGETには別のtimeoutがある。
これはstatus/health等の読み直しであり、公開・登録・pause/resume・配備のPOST、素材PUT、POST形式の一覧要求を再送する機能ではない。
再試行診断は固定reason・HTTP status・回数・経過時間・対象URLのhashのみで、鍵・URL・本文や任意例外文は出さない。

既に凍結した`publish-*`を再度呼んだ場合も、同じ要求のstatus確認だけを行う。
`failed`は公開書込前の確定的な入力/base失敗、`blocked`は途中停止・書込不明・purge失敗等であり、後続を停止する。
時間経過やHEAD不在で解除しない。blockedのretry/releaseは提供していない。

初期化では、R2/Worker作成・PUT・配備・公開設定の各要求前にjournalを保存する。
途中停止後の`init`はmutationを繰り返さない。
`init-reconcile INIT_UUID`は、配備receiptと正確なsetup identityが保存され、
**サーバーで既にready/paused/drainedの完了を読取確認できる場合だけ**ローカル記録を確定する。
未知deployの探索・採用・再配備や強制掃除を行うコマンドではない。

配備とworkers.dev有効化が応答確認済みで、REST検証だけが停止し、setupをまだ送っていない場合は、次の明示操作で検証と初回setupだけを続けられる。

```sh
castloop init-continue-verification INIT_UUID
```

対象は元journalの`access_enabled`/`verified`だけ。凍結source/config/metadata hashが一致し、native setupが存在せずpaused/drainedの場合に限定する。
resource作成・設定PUT・配備・access変更は再送しない。`setup_requested`やblockedのprobeを再試行するコマンドでもない。

物理deleteと未登録uploadのsettlement契約は未実装。現行staging keyだけでは未登録音源をEpisodeへ確実に対応付けられない。空のキューを根拠にbucketやprefixを削除しない。

## 検証の限界

ローカルではBun SQLite、模擬R2/Cache/Cloudflare REST、実CLI entrypointの独立processによるwalkthroughを実施した。
Worker/DO classは実platform型で型検査・browser bundle化し、Linux単体CLIには新旧両Workerを埋め込む。
**模擬storageのtransaction/AlarmとCloudflare実機のoutput gate・再配送、模擬purgeと実Workers Cache purgeは区別する。**
小容量・36件公開・正式RSS・互換更新の実機機能確認は通過したが、新経路の300MB実機公開、実機purge rate-limit retry、完全なDO/Alarm CPU採取は未確認。
Issue #13恒久解消、全Free適合と実機release readinessはまだ示していない。
