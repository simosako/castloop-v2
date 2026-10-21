# Issue #48: purge障害の切り分けと実機再試験（2026-10-21）

## 承認と境界

ユーザーは[初回停止の報告](do_show_separation_live_verification_20261020.md)を受け、障害分析、修正、新規隔離環境での再試験を承認した。初回の`i48-dc48db43`はblockedのまま保持し、初期化・probe・配備を再送しない。保持サービス、DNS、権限、課金・CPU設定、証明書、既存素材・journalを変更・削除しない。

診断用Workerを1つ新規作成し、空のcached entrypointへtag、prefix、併用の独立した診断要求を送る。公開コンテンツは置かず、未知要求を再送しない。アプリの診断は固定分類だけを記録し、任意例外文を保存しない。

修正後のLinux単体CLIで別の新規サービスを作成し、初回計画と同じ2 Show・各3 Episode、個別Pause/Resume、feed/cover/audio配信、SHA-256・HEAD・Range・304を確認する。最後は全Showを個別Pauseし、全資源・証跡を保持する。

## 切り分けと修正

- 初回の保存ログは`purge_unconfirmed`だけで、API例外と不正な応答形式を区別できない。
- 診断用Worker `castloop-i48diag-2d815560`ではtagのみ、prefixのみ、併用のいずれも`success=true / errors=[]`を確認した。初回障害の直接原因はまだ再現・確定していない。
- 診断scriptは初回に構文検証、次にcache対象entrypoint検証で明確なHTTP 400を受けた。未配備の検証拒否だけを修正し、`fetch`を持つcached entrypointの配備成功を確認した。最初の公開POSTはJSONではない応答で停止し、その要求は再送していない。後続は異なる対象への独立した診断要求である。これらは製品CLIの障害とは区別する。
- `src/sqlite-cache-purge.ts`の診断を改善し、`failure_kind`で`call_threw`と`invalid_acknowledgement`を区別する。例外は`type_error`、`internal_error`、`other`だけに分類し、内容は出さない。
- 未知結果を再送しないこと、明確なrate-limit拒否だけを有限待機すること、成功確認前にready/公開完了へ進まないことは変更しない。元の障害を「修復済み」とは判断しない。

## 再試験結果

### ローカル回帰

- `bun test`: **459 pass / 0 fail**、62 files、55.46秒。例外/不正応答の固定分類、秘密文字列非記録、未知purgeの非再送を含む。
- `npm run check`: 成功。
- `npm run build:cli -- linux-x64`: 成功。生成した単体CLIを実機再試験に使う。

### 実機試験後の診断補強とcommit前確認

ユーザーは再発確認の追加実施を不要とし、次回の詳細調査に必要なログを確認したうえでcommit/pushすることを承認した。以下は実機試験後の追加変更であり、上記の実機artifactや停止中の環境へ適用したものではない。

- 不正なpurge応答の`result_kind` / `success_kind`に型だけを記録する。返却値や任意fieldは保存しない。
- 初期化/更新probe失敗に`probe_stage`を記録し、設定読取・設定照合・cache owner照会・owner照合・purge・完了保存等のどこで止まったかを区別する。service ID、実行Worker version、config hash、操作IDも記録する。
- 秘密値・任意例外文を出さないこと、失敗後の再起動Alarmでもpurgeを再送しないこと、readinessの安全条件を保持することをローカルで確認した。再発時の保全・ログ照合手順は[操作ガイド](../docs/sqlite_sequential_development.md#異常時)を参照する。
- 最終`bun test`: **461 pass / 0 fail**、62 files、58.76秒。`npm run check`とLinux単体CLI buildも成功。
- この追加補強の再配備・再発確認・実機再試験は行っていない。次に変更を含むWorkerを配備してから追加fieldが有効になる。

### Cloudflare実機

**計画した2 Show・各3 Episodeの機能確認は成功した。** 初回purge障害は再現しなかったため、今回の成功を根本原因の特定・恒久解消とは扱わない。変更した製品codeは未確認purgeの診断だけであり、再送・purge省略・readiness条件の緩和はしていない。

- 実行区間: 2026-10-21 **07:56:11〜07:57:41 JST**（UTCでは10-20 22:56:11〜22:57:41）。単体CLIの59コマンドはすべてexit 0。
- Artifact: commit `4b58bb4`＋`src/sqlite-cache-purge.ts`の診断改善。CLI SHA-256は`9be2dd1f30954572b1ba73314121321cf70bd6bd0f9d75c6eb3d333472ce865f`。変更sourceのhashも私有証跡に記録した。
- 初期化と各Showのnative SQL/Alarm/R2/cache probeがreadyになった後、Show公開2件、Episode公開6件の計8 jobすべてで`succeeded`を確認した。

| 確認 | 実機結果 |
| --- | --- |
| Show A/Bの登録 | 各Showとも初期paused/ready/drained。Aを公開・openのままBを新規登録できた |
| 同じEpisode IDの分離 | 両Showで`first` / `second` / `third`を使い、別Showのmetadata・音源URLへ混入しない |
| Episode公開 | 各Showで10秒80,501 bytes、30秒240,579 bytes、60秒480,488 bytesの3件を公開 |
| Aの個別Pause | Aのfeed/cover/既存音源が503。Bはopenのまま3件目を公開し、feed/音源を配信できた |
| 全Showがpaused | 集約はpaused/drained、全体windowはnull |
| AだけResume | Bは503/pausedを維持。Aは再開直後に以前と同じfeedを配信し、続けて3件目を公開できた |
| BのResume | Aの公開でBのfeed SHA-256は変わらず、元の3件を配信できた |
| Feed / 一覧 | 各feedは3 item、catalogも各3 published。Show一覧は2 published |
| Cover | 各GETが200。配信SHA-256と2,173,207 bytesの原本が一致 |
| Audio | 全6件の全量SHA-256・サイズが原本と一致。HEADは200・正しいContent-Length、Rangeは206・先頭128 bytes一致、If-None-Matchは304 |
| Feedの条件付き取得 | open時にETag一致で304。paused時は条件付きでも503 |
| 操作記録 | Showを明示した未完了一覧はA/Bとも空。未知IOの取消・削除・再送は行っていない |
| 終了処理 | A/Bを個別Pause。両方ready/paused/drained、queued 0、active null、maintenance null |

### 保存ログの補助照合

対象Worker・実行区間に絞った`dry: true`の一時照会を5ページ取得し、重複除去後9,187 recordsを確認した。返却記録内に異なるDO IDが3つあり、Show AとBのR2操作は別DO IDに帰属していた。namespace objects一覧はHTTP 200でも空を返したため、DOの不存在・削除・個数の証拠には使っていない。

返却記録に`sqlite_cache_purge`の失敗診断、`runtime_probe_failed`等の構造化エラーはなかった。error levelのHTTP記録は意図したpaused配信の503、spanは新規公開先へのR2 HEAD不在（code 10007）だった。`POST /admin/sqlite-operations/commands`にHTTP 200・outcome `canceled`の記録が1件あったが、CLIは成功応答を保存し、後続公開と最終状態も確認できたため、これを未知要求の再送や公開失敗へ読み替えていない。cancelの発生原因自体は未調査。

これは返却された保存ログの照合であり、全platform invocation・CPUの完全捕捉やFree適合の測定ではない。nativeの同時IO・blocked時の独立性、共有更新、300MB公開、purge rate-limit待機は今回の機能試験に含めない。

### 保持資源と証跡

| 種別 | 保持対象 |
| --- | --- |
| 再試験Service | `i48-0147da37` |
| Worker | `castloop-i48-0147da37-00c35208` |
| Private R2 bucket | `castloop-i48-0147da37` |
| 管理・配信origin | `https://castloop-i48-0147da37-00c35208.simosako.workers.dev` |
| 最終状態 | `publication_ready=true / paused / drained=true / show_count=2 / paused_shows=2` |
| 初回停止環境 | `i48-dc48db43`をpaused/blockedのまま保全。診断後のGETでも状態を確認 |
| 診断用Worker | `castloop-i48diag-2d815560`。秘密鍵認証付き、公開payloadなし、保持 |

再試験workspaceとCLI出力、配信hash、入力source/artifactのhash、最終REST/native照合、保存ログとmanifestは`.local-test-data/results/20261021/i48-0147da37/`、診断用証跡は同日付の`i48diag-2d815560/`に保存した。原本・秘密鍵・操作ID・生ログはGitへ追加しない。全資源を保持し、後日のcleanupには別の明示承認を要する。
