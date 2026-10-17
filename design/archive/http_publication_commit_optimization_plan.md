# HTTP publication commitのCPU削減・責務分離案

2026-10-14。調査対象はPush済みの`8f4c1ed3af14bbdb540bd2e04a5f17c9c17c9bff`。
管理者がHTTP受付・Queue検証への変更を承認し、**事前測定をせず実装後に測定する**と指示した。
以下の旧baseline分析を根拠に受付・consumer・CLIを実装した。P0の事前測定とP1の追加guard整理は行っていない。
実装は`818c642`としてcommit/Push済み。残る固定負担の具体案は
[次のHTTP受付改善計画](http_acceptance_fixed_cost_optimization_plan.md)を参照する。
既存の安全条件は[publication停止の診断](../publication_execution_recovery.md)と
[承認済み方針](../m6_review_queue.md)を維持する。

## 結論

HTTP commitの責務を「入力の詳細検証」から「既に確保した公開jobの受付」へ絞り、
詳細なstaging検証を既存Queue consumerに集約する案を推奨する。
consumerは現在も公開書き込み前に同じ検証をしており、新しい処理基盤は不要。

ただし、これは単純な関数削除ではない。HTTPの成功が「staging検証済み」ではなく
「要求を永続化した」ことを示す仕様になるため、receipt、CLI journal、失敗通知の設計を合わせる。
即時staging拒否をHTTPに残す案ではなく、以下の受付契約を採用した。

## 実装した受付契約

- claim/commitのstrict requestに`acceptance_protocol: "queue-validation-v1"`を必須とする。
  旧CLIの要求はowner確保/marker作成前に拒否し、新CLIの要求も旧Workerのstrict schemaで拒否される。
  `service-status`は同じcapabilityを返し、RSS公開は対応確認後に開始する。
- HTTPは`202`と`result: "accepted"`、同じprotocol、`staging_verified: false`、job/manifest/key/createdを返す。
  CLIの応答は`publication-accepted`、journalの最終受付phaseは`accepted`。
  `commit_receipt`にprotocolと`staging_verified: false`を保存し、旧`committed` receiptと取り違えない。
- HTTPからstaging証跡・payload HEAD・base current/historyの検証を除いた。
  凍結control/publication request、予約、manifest hash、現在Show/Episode状態、reserved owner、
  marker PUT直前のowner再照合、service tokenと前後runtime gateは維持した。
- Show/Episode consumerは公開書き込み前の詳細検証を維持し、確定的な入力不一致を型で区別する。
  未開始の`admitted/validating`からの失敗だけ`failed / validation_failed`を保存する。
  既に`feed`以降へ進んだjob、I/O例外、owner/runtime不明は既存のretry/保留経路を維持する。
- consumerは失敗記録保存と全開始済みI/Oのsettlement後にexecutionを返し、service token返却までawaitする。
  Queue handlerが正常終了してから自動ackされる。Show ownerは保持する。
  publicationの`failed` statusは上書き不能で、重複配送は詳細検証・公開を再実行しない。
  CLI/HTTPの明示retryも確定失敗を拒否する。
- stagingの3証跡読取は本文消費まで全settlementを待つ。
  並行した読取のうちI/O例外があれば、別記録の入力不一致だけで恒久失敗と判定しない。
- 旧journalは読み取り互換を保ち、phase/receiptを自動昇格しない。
  受付/PUTの応答喪失は`commit_requested`を保持し、marker観測からPOST再送を許可しない。

自動検証: **1,057 pass / 0 fail（117 files）**、`npm run check`と単一CLI build成功。
旧protocol拒否、受付後のproof/ETag/version/size/base不一致、失敗jobの重複配送、CLI失敗表示、
transient読取時のtoken保全、旧journalの未変換を追加確認した。
公開書き込み後の検証不一致をpre-write失敗へ変えないことと、failed status保存の応答喪失後の重複配送も確認した。
既存の公開・Lifecycle・purge・応答喪失回帰も通過した。

実装後のローカル測定は5process×200sample/種別、warmup 30。
記録済み`8f4c1ed`の5回中央値との比較であり、同時のpaired比較やWorkers CPUではない。

| 種別 | 記録済みCPU平均の中央値 | 今回 | HTTP内R2 GET | payload HEAD | staging parse |
| --- | ---: | ---: | ---: | ---: | ---: |
| Show | 2.472ms | 1.911ms | 20→15 | 2→0 | 1→0 |
| 初回Episode | 2.998ms | 2.047ms | 30→18 | 2→0 | 2→0 |
| metadata-only | 2.189ms | 1.482ms | 28→18 | 2→0 | 1→0 |
| audio-only | 2.004ms | 1.330ms | 28→18 | 1→0 | 1→0 |

Show owner確認は5→3、Episode lifecycle確認は6→3。不変記録は各1回を維持する。
元の固定service/runtime負担は残り、ローカルCPU減少からFreeの10ms適合を推定しない。
実機測定の証跡はGit管理しない。安全な取消し・admission非同期化・追加guard整理・契約プラン変更は実装していない。

### 実装後の実機測定

完了済みの隔離テストserviceだけを正式なpause/drain/deploy/resumeで更新した。
測定Worker versionは`1275d4d0-06d7-4eab-a395-ca78fdc99c35`、CLI binary SHA-256は
`93f43de6077bb3319a8148a3415e0ffe6187e745857a03811a954f6aca272d97`。
最後のbuildでも同じbinary hashを確認した。測定時点では新規公開版のreleaseやPushは行っていない。

Show更新、初回Episode1件、既存36件Showのmetadata-only更新3回、最小音源のaudio-only更新1回の
**計6公開が成功**。feed件数と追加音源のGET/HEAD/Range/hashを照合し、各jobのpublished/released、
終了時のservice registryが空で同じruntime versionであることを確認した。
追加MP3 uploadは合計161,002 bytes。既存の大容量音源を再uploadしなかった。
Issue #13のFreezeはこの試験では観測されなかったが、恒久解消の保証ではない。

| 種別 | HTTP commit取得数 | CPU中央値 / 最大 | commit wall中央値 | consumer取得数 / CPU中央値 |
| --- | ---: | ---: | ---: | ---: |
| Show更新 | 1/1 | 16 / 16ms | 2.587秒 | 1/1 / 416ms |
| 初回Episode | 1/1 | 16 / 16ms | 2.955秒 | 0/1 / 未取得 |
| 36件Show metadata-only | 2/3 | 28.5 / 34ms | 3.166秒 | 3/3 / 240ms |
| 最小音源audio-only | 1/1 | 15 / 15ms | 3.014秒 | 1/1 / 213ms |

CPUはlive tailのinvocation全体、wallは該当phase。今回の少数標本のP95を運用保証に使わない。
旧36件Showのmetadata更新は2/3取得でCPU中央値38ms・最大51msだった。
今回の取得分は低いが、historical comparisonであって同時のpaired比較ではない。
Show・初回Episode・音源も旧通常規模試験とdataset/種類が異なり、全取り込みの改善率へ換算しない。

観測結果は`functional-passed-observation-incomplete`。
初回Episodeの照会を試験scriptがShow directoryで実行したため、HTTP照会前のlocal ENOENTで停止した。
受付済みの同じjobをservice workspaceから読み取り照合して続行し、POST/PUTやjournalは再送・編集しなかった。
そのconsumer終了ログとmetadata commit1件のログは未取得で、完成receiptから時間を生成して埋めていない。
tail healthが正常でも全jobのphase取得が揃うとは扱わない。

取得tailのruntime errorは0。GraphQLは263 matching-version groups、error groups 0、最大sample interval 10。
samplingとtail欠落を含むため、未観測の例外がない証明ではない。
先行した試験scriptの内部command名の誤りは配備前に拒否され、未開始を照合して正式`deploy`で進めた。
Opencodeの実行時間制限では停止せず、tmux試験と通知watcherはすべて終了した。

**今回のHTTP CPUは15〜34msで、Workers Freeの10ms目標は未達。**
staging詳細検証のHTTP重複は除けたが、service admission/runtime gateと現在owner/lifecycleの固定負担は残る。
次の候補はその同一境界の確認責務整理。各部分のCPU寄与は未確定であり、
残るgateを外す、未知tokenを返す、admission非同期化やPaid採用を自動的に進めることはしない。

証跡は`.local-test-data/results/20261014/queue-validation-428daa03/`、
前半のtailは`queue-validation-0eec542a/`、local benchmarkは`queue-validation-local/`。
`metrics-summary.json`、`graphql-summary.json`、公開receipt、原本ログを私有保存した。

## 検討時の段階案（実施順序は上記管理者指示を優先）

推奨する順序は次のとおり。

1. **固定負担と検証部分を分けて計測する。** HTTP全体のCPUを基準にする。
2. **同じ安全境界の重複確認を整理する。** 既存仕様のままで効果を比較する。
3. **承認後、詳細検証をconsumerへ集約する。** 受付と検証成功を明確に区別する。
4. 最小受付でも10msを超える場合だけ、admission自体の非同期化を別案として検討する。

1・2は3のための長期的な調査プロジェクトではなく、小さな比較単位とする。
今回のCPU中央値25msから10msへは60%超の追加削減が必要であり、
重複整理だけ、または検証移動だけで達成できるとはまだ保証しない。

## 実測と制約

通常規模試験ではShowとEpisode更新を含む41公開が成功し、Issue #13のFreezeは再現しなかった。
ただしtailの欠落があり、恒久解消やWorkers Free適合の証明ではない。

| 対象 | 取得数 | CPU中央値 / P95 / 最大 | wall中央値 |
| --- | ---: | ---: | ---: |
| 初回Episode commit管理HTTP | 33/36 | 25 / 48 / 53ms | 4.329秒 |
| 初回Episode consumer | 35/36 | 200 / 381 / 384ms | 66.779秒 |
| metadata-only commit | 2/3 | 38 / 51 / 51ms | 4.487秒 |
| audio-only commit | 1/1 | 33 / 33 / 33ms | 4.504秒 |

CPUはlive tailの**invocation全体**の値であり、`publication.commit`内部だけのCPUではない。
wallは対応するphaseの経過時間。両者の測定境界は異なる。
初回Episode1〜36件ではcommit CPUの明確な単調増加は観測されず、固定負担も対策対象になる。

秘密・元ポッドキャストデータを含む証跡はGit管理しない。
保存先は`.local-test-data/results/20261014/normal-8f4c1ed-71073a07/`の
`README.md`、`metrics/summary.json`、`metrics/matched-invocations.json`。

公式仕様上、Workers FreeのHTTP CPU上限は10ms。
Queue consumerもWorkerだが、Queues文書では既定CPU上限30秒、wall上限15分とされている。
今回のaccountの契約・実効上限は未確認で、成功した要求のCPU値から逆算しない。
isolateの一時的な超過許容も、継続運用の余裕として使わない。
CPU強制終了ではcatch/finallyが完了しない可能性があり、残留tokenを時間経過で解除しない。

## 現在の責務と重複

### HTTPの正常な新規commit

`src/publication-admin.ts` → `withM6ManagementInvocation` →
`withPublicationCommitContext` → `commitOwnedPublication`の順に実行する。

1. 認証、本文サイズ制限、strict request parse。
2. service TOML、実行Worker versionとruntime readinessの確認。
3. service invocationのCAS取得、前段delivery gate。
4. 現在のShow owner、予約identity、凍結control/publication request、manifest hash、Episode lifecycleの照合。
5. 既存commit markerの照合。完全一致なら冪等な応答。
6. `verifyPublicationStaging`でbase revisionとstaging証跡・現在payloadを検証。
7. ownerを再照合し、R2 bindingの作成限定PUTで`commit.json`を保存。
8. 後段delivery gate、service invocation返却、strict receipt応答。

①不変データ再利用＋②再parse削減は実装済み。
通常commitでは凍結control/publication requestと予約のGETはそれぞれ1回になったが、
Show ownerの確認5回、Episode lifecycle確認6回は残る。
これは通常経路のfixture/sourceの回数であり、競合・既存marker経路の上限ではない。

### HTTP外側にも固定負担がある

`src/m6-management.ts`、`src/lifecycle-delivery-gate.ts`、`src/service-admission.ts`では、
callbackの前後でruntimeと現在のservice tokenを確認する。
gateはそれぞれ「service読取 → cached entrypointのruntime RPC → service再読取」を行う。

競合のない取得・返却も含め、外側だけでservice admission GETは7回、CAS PUTは2回、
cached runtime RPCは2回。別にservice TOML GETが1回ある。
schema parseやJSON生成も繰り返す。
**詳細検証を移しても、この固定負担は自動的にはなくならない。**
R2待ち時間そのものはCPU時間ではないため、GET数の削減率をCPU改善率とは扱わない。

### consumerでも同じ詳細検証を行う

`src/publication-consumer.ts`はmarker、凍結要求、現在ownerを確認し、executionをCAS取得する。

- Show runner: `src/publication-show-runner.ts`で`verifyPublicationStaging`を実行した後、
  metadata/coverのhashと形式、feed入力等を検証して公開snapshot/cover/feedを書き込む。
- Episode runner: `src/publication-episode-runner.ts`で対象snapshotを検証し、
  `verifyPublicationStaging`とGUID検査を通してからimmutable音源保存へ進む。
- 公開途中の再試行でも、現在のowner/execution、progress、baseとの整合を確認する。

HTTP検証の成功は、その後payloadが変わらないことの証明にはならない。
したがってconsumerの検証を消してHTTPの結果を信頼する案ではなく、
consumerを公開直前の正式な検証責任者にする方が自然である。

## 推奨設計: 最小受付HTTP＋既存consumer

```text
CLI: local入力検証・upload/readback・既存claim
  → HTTP commit: 認証・稼働/所有権・凍結要求照合・marker作成
  → R2 commit markerの通知 → 既存Queue
  → consumer: 所有権取得・詳細検証 → 公開反映 → purge → 完了/所有権返却
```

claimが確保したShow単位の排他は維持する。受付HTTPで新しい公開ownerを取り直さない。
Queueの順序、同時実行数1、配送回数だけでは排他を保証できない。

| 処理 | 置き場所 | 判断 |
| --- | --- | --- |
| ローカルTOML、MP3解析、hash/readback、変更後のlocal入力検出 | CLI | 実装済み。維持するが、server側の許可判定の代用にはしない |
| 認証、本文上限、strict identity、service/runtime readiness、service token | HTTP | 未確認のruntimeへの受付や更新中の書き込みを防ぐため維持 |
| 正確なShow/job/generation/予約、凍結manifest hash、reserved/no execution | HTTP | marker作成の権限。別jobや古いclaimを受付しない |
| Show/Episode lifecycleの許可、marker前の現在owner再確認 | HTTP | 最初の改修では維持。省略は別の排他証明がある場合だけ |
| staging request/progress/statusのparse・hash・突合 | consumer | HTTPと重複する詳細検証。公開前に必ず実行 |
| payload HEADによるETag/version/size、base current/history、再利用audioの確認 | consumer | 受付時ではなく使用前の現在値を検証 |
| TOML/coverの内容、GUID、音源保存、feed生成、purge、完了保存 | consumer | 既存の責務を維持。音源全量buffer/hashをWorkerへ移さない |

### 永続化と応答

- 既存の`commit.json`とR2通知を使う。markerは引き続き最後に作成し、受付後のdraftは凍結する。
  ただし「詳細なstaging検証が完了したmarker」から「検証・公開を要求するmarker」へ意味が変わる。
  現行のpublish契約を変更するため、管理者承認と設計/利用案内の更新が必要。
- marker PUTと`Queue.send()`の二重書き込みを新たに行わない。R2とQueueを1つのtransactionとは扱わない。
  通知遅延・重複・再試行枯渇は、保持したR2 jobと既存の明示的な同一job retryで扱う。
- 応答は例えば`202 / accepted`とし、`accepted`、検証中、`published`、`failed`を区別する。
  既存の`committed` receiptを無説明で流用しない。
- CLI/Workerの対応をcapabilityとreceipt schemaで確認する。journalも受付receiptと未知要求を区別し、
  旧CLIが新しい成功応答を「staging検証済み」と誤認しないようにする。
  この変更に必要な互換更新だけを設計し、汎用version frameworkや旧形式変換は追加しない。
- HTTPの応答喪失、marker PUT応答喪失、強制終了は読み取り照合で扱う。
  markerが存在しても公開成功とはしない。HEAD不在だけで再送・解放を許可しない。
  consumerはHTTPの完了応答より先に開始し得るため、受付receiptは現在の実行状態を保証しない。

### 検証失敗を新しいFreezeにしない

検証移動前のShow/Episode runnerは、検証例外も`retrying`として保存してthrowしていた。
Queue retryが尽きた後もDLQがstatusを自動的に`failed`へ変えるわけではない。
このまま詳細検証だけを移すと、従来HTTPで拒否した入力でもCLIがpending待機を続ける。

非同期化では次を同時に実装する。

1. 詳細検証のうち、確認できた入力・hash・対象の不一致等を型付きの確定的失敗として区別する。
   I/O例外、所有権不明、読取不能をすべて恒久失敗へ変換しない。任意の例外文字列は保存しない。
2. **公開payload/snapshot/feedを書き始める前の、移動対象の検証失敗**を`failed / validation_failed`として
   現在owner/tokenを照合して保存する。途中まで公開を書いたjobをこの経路へ流さない。
3. すべての開始済みI/Oがsettleした通常終了経路だけexecution/service tokenを返す。
   durableな失敗記録と終了処理に成功した後で配送をackする。保存・終了処理が不明なら既存の有限retryへ戻す。
4. 重複配送は同じjobの失敗記録を照合して公開へ進めない。CLIは失敗を表示して待機を終了する。
5. Showのpublication ownerは失敗表示だけで解放しない。`failed / held`と残留tokenを区別して表示する。
   frozen draftの編集、新job作成、期限による自動取消しは許可しない。

確定失敗後にShowを使い直すための限定的な取消しを提供するかは、別途承認事項。
現在の安全なabandon操作の未定義を隠さず、同じjobの調査・明示retryの限界を利用案内に示す。
汎用的な外部強制解放の完成を本改善の前提にはしない。

## 既存仕様を保った追加最適化

### 同じ境界の確認責務を1つにする（③）

検討時は`verifyPublicationStaging`末尾のowner確認とcommit直前の確認が重複候補だったが、
詳細検証のconsumer集約でこのHTTP重複は既に消えた。
現在の初期contextとcommit入口の間にはmanifest hashのawaitがあり、
commit入口と最終owner確認の間にはmarker GETがある。
残る3回のowner確認を一律に同じ境界とは扱わない。
service取得/返却のsnapshot共有、同一loopback probe、現在値の再parse削減は上記の次計画で整理した。

- bucket/service/Worker version/job/generation/予約identityに束縛し、callback終了後は無効にする。
- marker GET、staging/base検証、runtime RPC等のawaitの後とmarker PUT直前は現在ownerを再確認する。
- 再parseの削減と現在値の取得を分ける。変更されたShow/Episode/service controlを古いsnapshotで許可しない。
- service token取得時のCASで検証したsnapshotを初期runtime確認へ使えるか検討する。
  version/readinessとの一致まで検証した証明が必要で、token取得だけでは代用できない。
- cached runtime RPCの前後の再確認と後段gateの必要性は更新・pause・cache切替との競合で評価する。
  「markerしか書かないから不要」という理由では削除しない。
- 後段gateの最後に検証したservice snapshotを返却CASの初回に使う案も比較する。
  ETag条件付き保存が競合したら現在値を再取得し、他のinvocationを古いsnapshotで消さない。
  全I/O終了後の自分のtoken返却だけに使い、後段gate自体を削除する案ではない。

現行commitは`m6_recovery`、新規claimは`m6_admin`として登録する。
paused時に既知jobのrecoveryを許す現在の方針を、CPU対策のついでに変更しない。
tokenを保持中の更新禁止と、要求終了時の返却責務も維持する。

### 追加の小さな検証済みreceipt（必要な場合だけ）

claim時にfull publication manifestのhashをserver側で検証し、ownerまたは凍結受付記録に結び付ければ、
commitでfull publicationを再parse/hashする負担を減らせる可能性がある。
現在のownerの`request_sha256`はcontrol requestのhashであり、full publication hashではない。
client申告のhashだけを比較する変更では、その不足を埋められない。

導入するならjob/対象/generation/予約/full manifestをserverのCAS・凍結記録へ束縛し、
作成応答喪失と既存記録の完全一致を検証する。初回は既存のrequest内contextを使い、
新しい永続記録・owner schema変更はCPU profileで残る負担を確認した場合だけ検討する。

## 比較した外出し案

| 案 | 評価 |
| --- | --- |
| 既存consumerへ詳細検証を集約 | **推奨。** 同じ検証が既にあり、追加基盤不要。受付成功と検証成功の区別が必要 |
| 非同期prepareで検証receiptを作り、その後HTTP commit | 即時commit拒否の契約を保ちたい場合の代案。同じQueueを使えるが新しいphase/通知経路/CLI往復が増える。receipt後に変わるpayload/base/ownerの再確認も必要 |
| CLIへ全検証・marker PUTを移す | 不採用。local検証は現在のserver ownerを保証しない。R2 REST PUTのCASは前提にできず、binding CASを維持する |
| claimやstaging finishへ検証を寄せるだけ | 別のHTTPへ10ms問題を移す可能性がある。後の状態変更により古い証明にもなる |
| `waitUntil()`で応答後に検証 | 不採用。同じHTTP実行のCPU予算の解決にならず、応答/切断後の延長は最大30秒。独立したdurableなQueue処理ではない |
| 別WorkerのHTTP/RPCへ分割 | 呼出側/呼出先の予算と所有権の受け渡しを確認する必要がある。名前やentrypointを分けるだけで10ms問題を解決したとしない |
| Durable Objects / D1 / Workflowsの導入 | 今回は不要。既存R2 CAS・Queue・journalの役割を移す費用が大きく、具体的な不足の測定後に再検討 |
| 独立Bun processでpublication consumerを運用 | HTTP CPUは減らせるが、常時稼働・認証・pull/ack・停止復旧を新たに運用する。現行のCloudflare完結構成を優先 |

最小受付のservice/runtime固定負担だけで10msを超えるなら、検証を移すだけではFree適合しない。
その場合の次案は「HTTPは小さなintentの永続化だけ、Queueがclaim/admissionも実行」。
ただし即時owner確保や競合拒否の意味、受付からclaimまでの編集禁止、pause/更新との競合、
未知応答の照合が変わるため、今回の関数整理に混ぜず別設計・承認とする。
Workers Paidの採用も運用上の選択肢だが、自動変更・課金変更はしない。

## 開発と測定の計画

| 段階 | 作業・成果物 | 次へ進む条件 |
| --- | --- | --- |
| P0 | 現行HTTP全体のbaselineと、管理wrapper/所有権/marker/staging検証の小さなprofile。既存fixture/benchmarkを拡張 | 削減対象と残る固定負担を区別できる。追加基盤や公開の検証bypass endpointは作らない |
| P1 | 隣接確認の③を小さく実装。entrypointを通した回帰と操作数比較 | 現在値・token・runtimeの境界が保たれ、効果がある |
| P2 | 承認後、consumerへの集約、型付き検証失敗、receipt/capability/CLI journalを1つの変更単位で実装 | 受付と公開成功の区別、失敗通知、未知要求保全、旧CLIとの誤認防止が確認できる |
| P3 | 最小セット → 通常規模。小さいmetadata-only/audio-only更新も比較 | 機能・所有権返却と実機HTTP CPUの両方を確認 |
| P4 | 残る負担に応じてserver受付receipt、またはadmission非同期化を判断 | 10ms目標未達の原因を測定してから別案を選ぶ |

CPUの内訳は既存の`performance.now()`ログだけでは測れない。これはI/Oを含むwall時間。
ローカルCPU profile/fixtureは候補の順位付けに使い、BunのCPU改善率をWorkersのCPU改善率とはしない。
実機では同じ入口・dataset・Worker versionを対応付け、変更ごとのinvocation CPUを比較する。
詳細ログには測定コストがあるので、比較時のログ条件も揃える。

### 必要な回帰

- Show、初回Episode、metadata-only、audio-only。stale local入力の拒否を維持する。
- 異なるmanifest/owner/generation/予約、処理中execution、変化したlifecycleの受付拒否。
- staging証跡不一致、payload ETag/version/size変化、base revision不一致。
  移動した検証が失敗した場合、公開音源/snapshot/feedへの書き込みがないこと。
- HTTPとconsumerの重複、marker競合、既存markerの完全一致、Queue重複と有限retry。
- marker/受付応答喪失、通常失敗の全I/O settlement、強制終了を模したtoken保全。
- paused時の新規admin禁止と既知recovery、更新/version/readiness変更との競合。
- purge成功前に公開完了としないこと、immutable音源/履歴、非公開path、削除との排他。
- 恒久検証失敗のCLI待機終了、重複配送で再公開しないこと、failed ownerの無断解放がないこと。

既存の300 MB・Lifecycle・互換更新の受け入れは再利用する。
新しい全故障マトリクス、旧形式変換、fresh-init fault harnessは追加しない。
実装時は`bun test`、`npm run check`、単一CLI buildを実行する。

### 性能の判定

- 新規/既存marker、Show/Episode/metadata-only/audio-onlyを分け、HTTP全体のp50/P95/最大・取得数を報告する。
- warm/cold相当の実行、同じShowの件数違いを記録する。coldの確認のために未終了jobを再配備しない。
- Freeを目標とするなら**P95を7〜8ms程度、観測最大を10ms未満**に収める余裕を狙う。
  これは開発目標であり、有限のsampleから将来の最大CPUを保証するものではない。
- commitだけでなくclaim/status/staging等のHTTPも確認し、「commitが通ったのでservice全体がFree適合」としない。
- consumerのCPU/wall、commitからpublished/releasedまでを比較する。HTTPが速くても完了待ちの改善とは限らない。
- tail欠落・adaptive sampling・ログ条件を明記する。tmuxによる独立実行と、既知の完了境界でのtail切替を継続する。
- 小さい試験を先行し、大きい音源の再uploadをCPU比較のためだけに繰り返さない。
  残留owner/tokenのある旧試験serviceを解放・更新・再実行しない。

## 残る判断

1. 確定失敗のShow ownerを返す限定的な取消し操作を別途提供するか。
2. 実装後の測定でも最小HTTPが10msに収まらない場合に、追加guard整理やadmission非同期化まで進めるか。

課金プラン変更や残留owner/tokenの強制解除、既存資源の削除は行わない。

## 参照した公式仕様（2026-10-14）

- [Workers CPU・wall・CPU計測](https://developers.cloudflare.com/workers/platform/limits/)
- [QueuesのCPU/wall上限](https://developers.cloudflare.com/queues/platform/limits/)
- [Queuesのat-least-once配送](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [waitUntilの寿命とQueueへの外出し](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
