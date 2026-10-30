# 管理処理をHTTPから外す設計の比較

2026-10-15。管理者から、細かなCPU最適化ではなくHTTPの責務を見直し、
「保存先を返す→CLIがR2へupload→通知でWorker処理→完了polling」などを比較するよう依頼された。
当初は比較・推奨案。管理者は同日に**案Cの実装とテストを承認**した。
開発ブランチの実装契約・確認結果は[案C実装](async_management_implementation.md)参照。
Cloudflare配備・実機測定・資源/権限/課金変更はこの承認に含めない。他案は比較資料のまま。
[現行HTTP整理](http_execution_cpu_breakdown_20261015.md)、[段階A実測](publication_queue_commit_measurement_20261015.md)、
[先行するclaim移譲案](publication_queue_delegation_options.md)を踏まえる。

## 結論

HTTPで所有権調停・複数recordの整合照合・検証・完了保存まで同期実行する責務分担は、
Workers Freeの10msと相性が悪い。必要な安全確認を取り除くのではなく、
**管理処理を「非同期command→consumerによる実行→小さい結果record」に統一する**方向を推奨する。

現在はstagingをclaim/status/begin/status/settle/status/finishに分け、mutationごとにservice/gateの前後確認を繰り返している。
公開ではclaimをHTTPで行い、statusも多objectのparse/hash/再照合を繰り返す。
CPUはfinish中央値72ms・最大139ms、publication status中央値15ms。statusの反復は観測HTTP CPU合計の約66.5%だった。
この固定負担を残したまま個々のparseだけを減らすことを主方針にしない。

推奨する分担:

| 役割 | 担当 |
| --- | --- |
| 編集・MP3解析・hash・local journal・明示的な操作意思 | CLI |
| 大きなファイルの運搬 | CLI→private R2 REST直接upload |
| 管理commandの搬送 | 既存Queues REST。必要時だけ薄いHTTP adapter |
| admission・現在値検証・CAS・検証・公開・purge・完了記録 | Queue invocation |
| 進捗の反復確認 | CLI→private R2 RESTで小さい結果recordを読む |
| 公開feed/cover/audioのGET/HEAD/Range、cache-safeなlifecycle判定 | 公開HTTP Worker |

## 保存先だけを返す案の評価

方向は妥当だが、**R2 prefixは所有権やアクセス許可そのものではない**。
同じShowで他のupload/publication/deleteが動く場合、別prefixにしただけでは同じShowへの競合を防げない。
現行のadministrator tokenもbucket全体へのREST権限を持ち、返したprefix以外への手動PUTを技術的に禁止するものではない。

HTTPで現在ownerをCAS確認してから即時に「uploadしてよい」と返すなら、現行claimの固定負担が入口に残る。
HTTPを真に薄くするなら、即時応答は**queued/request ID・候補prefix**までとし、
CLIはconsumerが発行した**実際のupload grant**を確認するまでPUTしない。
また、現行tokenを使うCLIではprefixのためだけのHTTP入口をなくし、Queue要求とR2 grantで代替できる。

## 案の比較

| 案 | 利点 | 制約・評価 |
| --- | --- | --- |
| A. HTTPは認証・bounded parse・`await Queue.send()`・queued応答だけ | UI等のclientを受け入れやすい。業務処理のHTTP CPUを除ける | 入口CPUは残る。即時prefixを正式なgrantにしない。Cold startを含め10ms以内か再測定が必要 |
| B. HTTP queued受付→非同期grant→R2 upload→完了request objectの通知 | 管理者の提案に近い。ファイルと完了意思をR2へ置ける | payload毎の通知では不十分。署名済み完了要求・新notification契約・重複/上書き照合が必要 |
| **C. CLI→Queue command→R2 grant→R2 upload→Queue完了command、R2結果polling** | **管理用castloop HTTPを経由しない。段階A・既存API token・Queue/R2を再利用できる** | 非同期admission、grant/result、paused window、未知要求の契約変更が必要。現行CLIでは第1候補 |
| D. commandを最初からR2 inboxへ置き、通知でgrant/完了/公開を実行 | 全commandがR2に残り、messageが保存objectを参照する | REST PUTにCASを仮定できない。署名/body hashをconsumerが確定保存する。namespace/ruleを変更し、producerの上書き・旧通知を扱う必要あり |
| E. Workflowsをorchestratorとして使う | upload等の外部event待ちや長い多段処理を表現しやすい | 新製品の設定・保持・費用/制限確認・移行が増える。step retryは旧IO終了の証明ではない。CPU問題だけなら既存Queueで十分 |
| F. DO/D1にauthoritativeなoperation stateを集約する | R2多objectの状態読取・整合確認を簡素化する可能性 | R2 controlを正とする現行設計を変える大きな移行。HTTP業務処理を残すだけならCPU問題は残る。第一段階には推奨しない |

同期HTTP/RPCで別Workerへ呼び出すだけ、または`waitUntil`だけにする案はdurable jobの代用にしない。
Queueの実行予算へ移すにはQueue invocationで実行する必要がある。

## 推奨案Cの処理モデル

### 1. Uploadの開始・grant

```text
CLI: local入力検査、同じ未公開draft job ID、upload operation ID、manifest/hash、要求IDを凍結
  → Queue REST: stage-start commandを送信
Queue: 認証・current runtime/window・Show/Episode・現在generation/ownerを確認
  → Show CAS admissionとPUT開始権限を一つの論理操作として確定
  → R2: exact upload session / keys / size / hashのgrantを保持
CLI: 同じ要求hashのgrantをR2で読取確認
  → 正式なgrantを得た1 callerだけがPUTを開始
```

queuedはgrant済みではない。結果不明の送信・開始権限を自動再発行しない。
consumerのgrant作成IOも正確なowned executionで保護し、古い実行が残る場合は重複で新実行を開始しない。
client uploadの待機中、Queue invocation自体は保持し続けない。grant保存等のown IOをsettleして返り、
**durableなShow upload owner**は完了まで残す。HTTP/Queue invocation tokenをclientや次のinvocationへ渡さない。

保存先は例として`staging/uploads/<show>/<draftJob>/<uploadSession>/<asset>`のようにsessionごとに分けられる。
これはkey layout変更例。案Cの実装では現行のShow/Episode draft prefixを維持し、layout変更・移行は行わない。
metadataとaudioのupdateを別々に行う現行操作は維持でき、各updateにこのupload処理を適用する。

### 2. Upload完了・検証

```text
CLI: 全PUTをawait → 全量readbackのsize/hash/ETag/version照合 → 以後PUTしない
  → Queue REST: upload-complete commandを送信
Queue: 同じgrant/owner・明示的settlement・readback receiptsを照合
  → 自分のverification execution取得 → 既存検証runner
  → 検証済みstaged結果をR2に保存 → own IO終了後の終了処理
CLI: R2の小さい結果recordでstaged/failedを待つ
```

現在のbegin/settle/finishに相当する必要な処理は残すが、個別HTTPの往復ではなく、
stage-startとupload-completeの2つの論理commandを中心にconsumer側へまとめる。
初回Episodeでmetadata/audioを別updateするなら、この流れも2回行う。勝手に両者を同時公開しない。
MP3解析・全量readback hashは引き続きCLI、公開MP3保存時のnative checksum照合はR2で行う。
CPU移譲のためにMP3をWorkerへ全量bufferしない。

### 3. 明示的な公開

```text
管理者がpublishを実行
CLI: exact staged refs / base / generation / runtime windowへ束縛した公開要求を凍結
  → Queue REST: publication command
Queue: atomic claim → own execution → commit marker → 詳細検証/公開/purge/完了
CLI: R2で同じ要求のpublished/failed/rejectedを待つ
```

claimまでQueueへ移す点は段階Bに相当する。ただし段階Bだけでなくstagingとpollingの契約も整理する。
**updateによるupload完了はstagedで止め、公開は必ず別の明示的publishを要求する。**
未変更metadata/audio、immutable media/revision履歴、GUID等のidentity、purge後の完了は維持する。
payloadの消去や自動expirationはこの構成変更に含めない。

## 案B/D: R2通知を使う場合の必須条件

R2 event notificationsは既存Queueへ届けられ、prefix/suffixで対象を限定できる。
ただしnotificationは処理の合図であり、内容検証や複数ファイルの完了transactionではない。

1. metadata/cover/MP3それぞれの到着を公開開始条件にしない。
2. 全PUTとreadback終了後、no-more-PUTの意思とreceiptsを含む**小さい署名済み完了要求**を最後に置く。
3. upload完了要求とpublication要求は別namespace/familyにする。CLIが現行publicationの`commit.json`を直接作る方式へ戻さない。
4. その要求だけをnotification filterで起動対象にする。別ruleも同じ既存Queueを使えるが、runtime verificationとの契約変更が必要。
5. consumerは通知の順序・一度だけの配送・全filesの存在を信用せず、現在のgrant/owner・payload・凍結要求を検証する。
6. request ID/body hash/MACを束縛する。REST PUTのIf-MatchをCASにせず、consumerのbinding CASで受理済み要求を確定保存する。
7. producerのPUT応答喪失は同じ要求を保持して停止。object不在や通知未到達から未送信を推定しない。

この方式も可能だが、現在のCLIは既にQueues RESTを使えるため、完了意思を直接Queueへ送る方が、
request-object書込・notification rule・body照合の搬送路を一つ減らせる。
R2 inboxに要求原本を送信前から残す利点を重視するなら案Dを選べるが、それだけで未知IOを解決したとは扱わない。

## Pollingは管理HTTPへ戻さない

反復pollingは認証付きR2 RESTの小さいoperation/result recordで行う。
consumerが要求hash・operation identity・現在のowned完了証拠を確認してから結果を書く。
CLIも自分のfrozen requestと照合し、他の要求のresultや破損recordを採用しない。

- compact progressは待機表示用。必要な証拠を削って公開成功を判定しない。
- terminal receiptはそのoperationの完了を示すもので、現在service全体のtoken空・将来の新admission許可を示さない。
- 次の操作開始、復旧、update/drain判断は現在のowner/runtimeを再確認する。単一result/HEADを強制解放の根拠にしない。
- 待機間隔はbackoffできる。期限で切るのはCLI待機だけで、処理取消やtoken解放ではない。
- Queue保持をjob ledgerにせず、unfinished/recoverable recordsとfrozen要求をR2/local journalに残す。

CLI→R2読取はruntime RPCの能動的なreadiness検証を代替しない。consumerが実行前にcurrent readinessを検証する。
成功result保存後にservice token返却やnative duplicateが残る場合もあるため、resultをglobal quiescence証明にしない。

## 非同期admission・失敗の意味

- queued時点でownerをまだ取れていない要求を、grantedやclaimedと呼ばない。
- 新規admissionはopenだけ。pausedでdrainできる既知のadmitted ownerとは区別する。
- worker/config/明示的admission windowへMACを束縛する。service token出入りで変わるgenerationや時刻だけをwindowにしない。
- pause/resume・更新・URL変更前の未admitted要求を、新windowで勝手に開始しない。backlog不存在をregistry空から推測しない。
- current Show/Episode generationが変わったらrejectし、caller要求を自動修正しない。
- admission前のrejected/unclaimedと、admission後のfailed/heldを区別する。ownerなしの拒否をlifecycle job statusへ無理に保存しない。
- 入力失敗ではfrozen draft/必要なownerを保持し、unknown IO・残留execution・DLQ履歴から自動解放しない。
- 移譲しても[単一REST PUTの未検証仮定U1](m6_upload_recovery_options.md)は解決しない。multipartやU1解消を今回の必須ゲートにしない。

## Public Workerとconsumerの物理分離

CPU予算の切替には既存scriptの`queue()`で十分なので、最初から別Workerを必須にしない。
管理を外した後も公開HTTPのcold start等に問題があれば、最小のpublic delivery Workerとprivate consumer Workerへの分離が候補。
ただしcold startの現在CPU寄与は未計測であり、分離の効果を断定しない。

分離する場合、現行の「実行version=cache owner version」証明はそのまま使えない。
public/consumer/cacheのidentity・binding・配備済みversion組を証明し、両方のpause/drain/update/readinessを設計する。
version照合の削除や一方だけのresumeで通さない。公開パスのlifecycle/cache安全条件も維持する。
private R2をpublic化したり、CLIへR2公開URLを返して配信Workerを省いたりしない。

## 推奨する進め方

個別endpointを順番に微調整するのではなく、まず上記の**async upload→staged→explicit publish→R2 result**を一つの設計契約としてレビューする。
確認するのはtransport（案CかR2 inbox）、window/競合拒否、grantの一度だけの利用、完了証拠、未知IOの保持、CLI互換性である。

承認後は新規Show等の汎用operation engineを作らず、upload/publicationの限定commandと既存runnerで小さい縦断経路を実装する。
protocol/capabilityを揃え、旧CLIへの自動fallbackや結果不明の再送をしない。
小容量から36 Episode更新へ測定し、管理HTTPが呼ばれないこと、Queue CPU/wall、重複・owner保全、media/identity/purgeを確認する。

登録・一覧・standalone target inspection・lifecycle・deploy/domainなどの既存操作は、案C実装でも新方式へ変更しない。
公開GET/HEAD/Range等もCPU測定が必要で、管理HTTPを外しただけで**全サービスのFree適合を保証しない**。
新製品・費用/権限・既存環境の配備・データ変換は別途承認とする。

## 参照

- [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Queues HTTP publish](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [既存Queue移譲案](publication_queue_delegation_options.md)
