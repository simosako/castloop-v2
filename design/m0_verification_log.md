# M0 技術検証記録

## 2026-09-23: Wrangler・認証・読み取り権限（計画の項目1）

対象: この環境で設定済みのCloudflareアカウント。アカウントID・token・既存リソース名は記録しない。**Cloudflareへの書き込み・課金設定の変更は行っていない。**

| 確認 | 結果 |
| --- | --- |
| プロジェクトのWrangler | `node_modules/.bin/wrangler --version` → **4.131.2**。リポジトリの`package.json`に依存関係あり |
| 環境変数のAPI token | `wrangler whoami --json` → 認証成功、対象アカウントと`CLOUDFLARE_ACCOUNT_ID`が一致。account-owned tokenのverify API → **active** |
| 対話ログイン | API tokenを外して`wrangler whoami --json` → `loggedIn: false`。この環境ではWrangler OAuthの動作は未確認 |
| Queues | `wrangler queues list` → 成功（**読み取りのみ確認**） |
| Workers | APIでWorker scripts一覧・account settings・workers.dev subdomainを取得 → 成功（**読み取りのみ確認**） |
| R2 | `wrangler r2 bucket list` → **失敗、code 10042**: `Please enable R2 through the Cloudflare Dashboard.`。R2の有効化が先決で、tokenのR2権限は未判定 |
| 権限一覧・契約 | account token詳細API → 403（code 9109）、account subscriptions一覧API → 403（code 10000）。このtokenでは付与済み書き込み権限と実際のWorkersプランをAPIから確定できない。Workers account settingsの`default_usage_model: standard`はFree/Paidプランの証明ではない |

**判定:** WranglerとAPI tokenの基本認証、Workers/Queuesの読み取りは合格。R2・Worker deploy・Queue作成/consumer設定・R2 Event Notification作成などの**書き込み権限は未検証**。Freeプランでの運用を前提にするが、プラン自体は現tokenで照会できなかったためユーザー側のDashboard表示を確認する。認証できたことと作成権限があることは区別する。

**次の操作:** 管理者がCloudflare Dashboardの **Storage & databases → R2 → Overview** で対象アカウントのR2 subscriptionを有効化する（無料月間使用枠はあるが、別途checkoutが必要）。Workers/QueuesがFreeのままであることもDashboardで確認する。完了後に`wrangler r2 bucket list`を再実行し、検証用の命名・片付け手順を決めてから最小のR2 bucket/Queue/Worker作成で書き込み権限を確認する。対話経路の検証が必要な環境では別途`wrangler login`を行う。

参照: [R2有効化手順](https://developers.cloudflare.com/r2/get-started/)、[Queues Freeプランの枠](https://developers.cloudflare.com/queues/platform/pricing/)、[Queues Freeプランの保持期間](https://developers.cloudflare.com/queues/platform/limits/)。

## 2026-09-23: R2有効化後の実機検証（項目1・2・4の一部）

R2 subscription有効化後、`wrangler r2 bucket list`が成功した。API tokenとWrangler 4.131.2で **検証専用bucket・Queue・DLQの作成、WorkerのdeployとR2 binding/Queue consumer設定、R2 object put、通知rule作成**に成功した。専用リソース名は`castloop-m0-e87da5b3ca`（bucket/Worker/Queue）、`castloop-m0-dlq-e87da5b3ca`（DLQ）。テスト用コードは[`../experiments/m0/worker.ts`](../experiments/m0/worker.ts)、アカウント固有のWrangler設定・Workerの管理用secretはgit管理外の`/tmp/opencode/castloop-m0/`に置いた。検証完了時はこれらの専用リソースと実験オブジェクトだけを片付ける。

| 検証 | 実測と判定 |
| --- | --- |
| 管理操作の認証 | Workerの保護された操作はsecretなしで`401`。HTTPクライアントの既定のPython User-AgentではCloudflareの`403 / 1010`になり、識別可能なUser-Agentを指定するとWorkerの`401`/正常応答に到達した。管理操作の正式な認証方式はなお設計が必要 |
| 原子的な条件付き作成 | R2 bindingの条件付きPUTで、同一Showへ**12件を並行送信×3回**。各回とも`201`が1件・`409`が11件で、R2の所有jobIdは唯一の勝者と一致。同じjobIdの再要求は`200`。異なるShowの並行要求は両方`201` |
| 所有者の解放・再受付 | R2 objectのETag一致時だけ`held → free`へ条件付きPUT。別jobIdによる解放は`409`、解放後の別jobIdの再受付は`201`、古いjobIdの解放は`409`で新所有者は保持された。無条件DELETEは使用していない |
| R2通知→Queue | `staging/` prefix・`commit.json` suffix・object-createの通知ruleを作成。Show/Episodeのcommit marker計2件が同じQueue consumerからR2の実験記録へ到着し、TOML/MP3の個別upload計2件は到着しなかった |

**この時点の判定:** R2条件付きPUTを使った受付・所有者照合は実Cloudflareで確認した。公開snapshotやfeedを更新せず、予約中に停止したCLIの診断・復旧、途中停止後のconsumer再入、処理中の旧consumerを残したまま予約を解放した場合の公開データ巻き戻しを防ぐ方式は未実証。後続のretry/DLQ、cache purge、MP3上限の結果は次節に記録する。Workerデプロイが成功したことから実行時の書き込み権限は確認できたが、契約プランのAPI照会とWrangler OAuthは引き続き未確認。

## 2026-09-23: 配信・purge・失敗配送・上限音源（項目4〜6）

上記と**同じ専用リソース**だけを使用。Wrangler設定でWorkers Cachingを有効化し、R2の`m0/public/`の実験ファイルだけを公開した。管理用GET応答は`Cache-Control: no-store`。DLQは同じWorkerに専用consumerを追加し、検証のため配送内容の識別情報をR2へ記録した。

| 検証 | 実測と判定 |
| --- | --- |
| 配信とcache | feed・画像・短い有効MP3の各GETは`MISS → HIT`、本文とbyte lengthが一致。HEADは`200`、MP3の`Range: bytes=0-9`は`206`で10 bytesと`Content-Range`が一致し、範囲外は`416` |
| Queue handlerからのpurge | feedと画像を同じキーで上書き後、GETは**古い内容のHIT**。`staging/shows/m0-cache-.../commit.json`の通知を受けたQueue handlerからfeed/画像のtagをpurgeすると、R2のpurge結果は`success: true`。両URLは新内容の`MISS → HIT`となり、音源はHITのまま。Queue handlerとfetch handlerを同じWorker entrypointで動かす方式が成立 |
| 自動retry・DLQ | 1回だけ一時的失敗を注入した通知は2回目で処理成功。常に失敗する通知は3回配送（初回＋`max_retries: 2`）された後、単一DLQのconsumerに届いた。恒久的失敗は理由をR2へ記録して通常ackし、公開処理・DLQへの配送を行わなかった。DLQ到達時にjob statusを自動で更新する処理は設けていない |
| Wrangler最大MP3 | MP3フレームとID3 paddingから作った**正確に300,000,000 bytes**の有効MP3を`ffprobe`でduration **7499.988秒**・320 kb/sとして解析。WranglerのR2 uploadに**20.6秒**で成功。Wranglerで読み戻した300,000,000 bytesのSHA-256がローカルと一致（読み戻し6.7秒）。検証後は大容量のR2 objectを削除済み |

purge失敗時の再試行も、**初回だけpurge結果を人工的に失敗扱い**にして検証した。Queueによる2回目の配送では実際のtag purgeが成功し、R2に残した試行記録は`false → true`。feed・画像は新内容の`MISS`へ切り替わり、音源はHITのままだった。Cloudflareのpurge APIが実際に失敗した事例ではないため、実APIのエラー条件の網羅を主張しない。公開済み音源の重複コピーも行っていない。

**この時点の残件:** (1) 受付後／marker前のCLI停止、途中停止・古いconsumerの再入を公開snapshotまで含めて安全に回復する方式（所有者の条件付き解放だけでは他の公開objectの遅延書き込みを防げない）、(2) OAuthログイン、Free契約のDashboard確認。300 MB超の入力をCLIでupload前に拒否するのは実装時の仕様であり、M0では超過ファイルの転送は試さない。`max_retries: 2`は**実験設定**であり本番値の決定ではない。検証用bucket・Queue・DLQ・Workerと小さな実験データは続くM0のため保持する。

### 予約後／marker前の停止と遅延通知（項目3の部分確認）

検証専用Showでjob Aを受付し、markerを作らず停止した状態ではjob Bの受付は`409`。管理者による中断を模擬して、所有者Aの予約だけをETag付き条件付きPUTで解放するとBは`201`で受け付けられた。その後でAとBのcommit markerをアップロードし、consumerが**所有jobIdと一致しないAの通知を拒否し、Bだけを処理**したことをR2実験記録で確認した。

この実験の`/finish`は検証用の手動操作で、markerの不在やconsumer実行中でないことを**判定していない**。実装ではmarker作成と予約解放の競合、および`processing`中に解放した後の旧consumerの遅延書き込みを防ぐ受付状態遷移が不可欠。上記の部分確認をもってM0項目3の合格とはしない。

### 重要: 所有者照合だけでは旧処理による巻き戻しを防げない

同じ検証Worker内の**模擬公開キー**`m0/unsafe-current/<showId>`を使って、所有者Aが照合を通過した後に処理を一時停止させた。実験用の`/finish`でAの予約を解放してBを受け付け、Bが`unsafe-current`へ書いた後にAの処理を再開すると、**予約はB所有のまま、模擬公開キーはAの内容に巻き戻った**。本番の`public/`キーは使用していない。

したがってR2の条件付きPUTによる**受付の原子性は実証済み**だが、それだけで公開全体の安全性まで合格とはしない。次の検証では単一受付記録に`held`/`processing`/終端状態を持たせ、consumerの処理中には管理操作から予約を解放できないようにする。停止・DLQ到達後の解放には、旧処理が再び公開キーを書けないことをどう確認するかも必要。Queueの1並列や各書き込み前の所有者再確認だけでは「確認後に解放→遅れて書き込み」の競合をなくせない。これを安全に証明できなければ追加の原子的な調整手段または公開データの確定方式の変更を検討する。

### `processing`中の解放禁止と同一jobでの再開（項目3の追加確認）

同じR2単一オブジェクトに`held → processing → free`の状態遷移を追加し、`held`の管理解放とconsumer開始相当の`processing`への遷移をETag条件付きPUTで競合させた。**5回中すべてでどちらか一方だけが成功**。`processing`が勝った場合、別jobの受付と管理解放はいずれも`409`、旧jobの公開書き込み後にだけ`complete`して次jobを`201`で受け付けた。途中停止を模擬した`processing`は同じjobIdの`begin`で再開でき、旧jobの完了前には次jobを受け付けなかった。

**なお未証明:** `complete`を誤って旧処理の終了前に呼べば前節の巻き戻しは再発する。実装では`complete`はconsumer自身が全書き込みとpurge成功後にのみ行い、管理側が`processing`を任意に解除しないことが必須。**全retryが尽きてDLQに入った`processing` jobの安全な再開/中断（旧実行が完全に停止したという判定）**、R2 statusと予約の書き込み途中で停止した場合の照合、および固定キーfeed/画像の冪等な公開処理は今後のM0/M2検証事項。再試行が永続的に失敗するjobの予約をどう解放するかが決まるまで、項目3は完了扱いにしない。

失敗時に無理に次jobを受け付けず、同じShowの公開を止めて管理者が復旧する方式の検討は[`m0_failure_recovery_proposal.md`](./m0_failure_recovery_proposal.md)を参照。

## 2026-09-23: 簡素な停止・同job再試行方式の実機ミニ検証

検証専用Workerに[`../experiments/m0/verify_recovery.py`](../experiments/m0/verify_recovery.py)の実行経路を追加し、既存の専用bucket・Queue・DLQで実施した。`staging/shows/m0-gate-.../<jobId>/commit.json`のR2通知から同じQueue consumerを起動し、`m0/gate/`内の**模擬公開キー**だけを書き換えた。本番のfeedやmetadataは操作していない。最終版Workerでは`processing → free`を管理用HTTP経路から実行できず、Queue consumer内でのみ完了する。確認済みの実行IDは`69766be1`。検証時のQueue設定は`max_batch_size: 1`、`max_concurrency: 1`、`max_retries: 2`。

| ケース | 実測 |
| --- | --- |
| `reserved`取消し vs `processing`開始 | 4回並行実行し、各回`200`が1件・`409`が1件。開始が勝った場合の取消し・次job受付は`409`、管理用`/complete`は`404`。完了・解放はconsumerが担当 |
| 模擬公開キーへの途中書き込み後に停止 | immutable模擬入力を置いて初回を人工的に失敗させた。Queueの2回目で同jobが模擬公開キーを確定し、status=`published`後に予約は`free`。試行記録は2件 |
| status記録後・予約解放前に停止 | 初回はstatus=`published`の後に人工的に失敗。2回目は同jobの完了済みstatusを読み、予約を解放。模擬公開キーと予約所有者はいずれも同jobで一致 |
| 失敗を継続してDLQへ | 3回の配送後にDLQ到着を確認。statusに失敗理由を残し、予約は`processing`のまま。管理取消し・同Showの次job受付は`409`。別Showの受付とQueue処理は成功 |
| 遅れた旧commit | `reserved`のAを取消してBを受付。AのcommitがBの処理前に届いた場合とBの完了後に届いた場合の両方で、旧jobは所有者不一致として拒否され、模擬公開キーはBのまま |

**判定:** 同一Showを止めて同jobを再試行し、失敗し続ければそのShowをブロックする**MVP回復方式の中心動作は合格**。遅延書き込み中の旧jobを無理に解放する方式は採用しない。検証用の`/begin`は管理側から状態競合を作るためだけに残した入口であり、製品実装ではconsumer専用とする。確認済みの初回実行ではデプロイ直後の`/gate` GETに一度`404`があり、直後の再実行と最終版での実行は成功した。原因は未特定で、上記の合格判定は最終版での完走結果に基づく。

**M0全体は継続:** 実際のShow/Episodeメタデータ・feed・固定キー画像を使った途中停止からの収束、M0計画の全停止点、Queue一時停止を伴う例外的な手動中断は未検証。OAuth経路とDashboardのFreeプラン確認も未完了。CLIでの300 MB超の事前拒否はCLI実装時のファイルサイズ判定とし、超過ファイルをCloudflareにuploadして試すM0項目にはしない。実験は状態遷移と模擬公開キーの検証であり、実際の公開フローの合格と混同しない。

## 2026-09-23: 300,000,000 bytesダミーファイルの往復検証（項目6）

同じ専用R2 bucketの`m0/size/`に、ローカルでランダムバイトを**正確に300,000,000 bytes**書き出したダミーファイルをWrangler 4.131.2の`r2 object put --remote --file`でuploadした。所要時間は**21.5秒**。`r2 object get --remote --file`で別のローカルファイルとしてdownloadし、所要時間は**14.3秒**。ダウンロード後のサイズは300,000,000 bytesで、元ファイルとの**全バイト比較が一致**し、双方のSHA-256も`a50f014a1accbf7e11112008584425347497d8eb3b9f02df2ac1d94a3a6698a6`で一致した。検証後は専用R2 objectとローカルの両ファイルを削除した。

**項目6の上限転送について合格:** ダミーデータの完全なファイル往復と、先に確認した同サイズの有効MP3の転送・duration解析の両方を実測した。300,000,000 bytesを超えるファイルは送っていない。製品CLIではファイルサイズをupload前に判定して超過をエラーにする仕様とし、Cloudflareが超過ファイルを受け付けるかは保証対象にしない。
