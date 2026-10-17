# 案C: Queue/R2管理経路の実機測定

2026-10-15。管理者が案Cのcommit・Push・Cloudflare配備・実機CPU測定を別途承認。
**隔離環境への互換配備と7公開が完了。管理HTTPは観測0、freeze/runtime errorはこの試験では観測なし。**
ただし公開feed GETのCPUは最大11ms、通常metadata更新の総wallは前回より増えた。
全HTTPのFree適合・Issue #13の恒久解消・速度向上を主張しない。

## 固定したコードと環境

- ブランチ: `feat/publication-queue-submit`。
- 配備対象ソース: `e60a114`。v0.4.0のmain/tag/releaseは変更しない。
- 正式Linux開発バイナリSHA-256: `99bf784d8c65c59077e27225e4051ae17006fdcd42fc0880dcf5b767554b99f5`。
  package表示は0.4.0のままなのでSHAで区別する。
- Worker version: `26e3452e-3f35-4b57-a1c6-ee84fbd67d55`。
  旧`635e4665-8e4b-43c0-a626-24814ff0b0a1`から、正式なpause/drain/互換update/readiness/resumeを一度だけ実行。
- 対象は前回処理終了済みの隔離サービス`i13-bc656f35`、Worker `castloop-i13-bc656f35-466ebe5f`だけ。
  bucket/主Queue/DLQを作り直したり、別の残留ownerがあるサービスを操作したりしない。
- ローカルは1,116テスト成功、TypeScriptチェック成功。ログcollectorも3種類の`management.*` phaseを保持するよう回帰確認。

## 手順と容量

1. 現在version、service registry、全Show一覧/current owner、正確なQueue/consumer設定をread-only確認。
2. 正式CLIでpause/drain→同じサービスの互換配備→Queue round-tripを含むreadiness→明示resume。
   更新は終了済みの旧versionだけから一度行い、未知deployや停止したmutationは再送しない。
3. 小容量のShow更新、新規Episode、既存Episode音源のみ更新の3公開。
4. 小容量gateが通った後、既存36 EpisodeのShow更新と同じEpisodeのmetadata-only更新3回。
5. feed、少量音源のGET/HEAD/Range、current owner・service token、GUID/公開日時/未変更音源を確認。

通常規模の約1.5 GB音源は再uploadしない。新MP3 PUTは約80 KBの同じ小さいclipを2回に限定する。
metadata/coverと必要な小さい運用recordは追加される。削除・強制token返却・権限/課金変更は含まない。

専用socketのdetached tmuxを使い、起動shellとは別process groupで実行。
command要求/終了、stdout/stderr、journal、tail health・invocationをprivate証跡へ保存する。
完了監視はpidfdの終了通知で待ち、OpenCode側の長時間shellや繰り返しのstatus確認でrunnerを所有しない。

## CPUとwallの測り方

- Cloudflare live tailの`cpuTime`が**invocation全体のCPU（整数ms）**。アプリのtimerやCLI wallではない。
- `management.stage-start`・`management.upload-complete`・`management.publish`のjob/operation ID、
  `management_delivery`のrequest ID・action・主Queueを照合し、1 commandにつき1 primary invocationへ帰属させる。
- `worker_timing.duration_ms`はphaseのwall。認証/config/retention等の前処理を含む全invocation wallとは分ける。
- content試験中はcastloop管理HTTPを呼ばない。完了後のdrain確認もprivate R2のread-only snapshotを使う。
  maintenanceのservice/target等HTTPと、公開deliveryのGET/HEAD/Rangeは別scopeであり、残るCPUも区別する。
- public root HTTPと内部/cache ownerのHTTPが見える場合は別々に集計し、CPUを足して1要求のCPUにしない。
- GraphQL `workersInvocationsAdaptive`は同じscript/version/期間の補助確認。sampling・収録不足を隠してゼロerrorと推定しない。
- Tail終了・期限切れ・truncation・frame/保存失敗は未完了captureとして停止。進行中mutationをkill/再送しない。

Queueの文書上の既定CPUは30秒、wallは15分。HTTP Freeの10msと別のinvocation予算だが、
accountの実効plan/limitを推測せず、成功したCPU値だけから全サービスのFree適合を主張しない。
terminal resultはそのoperationの完了を示すだけで、global token空やQueue backlog不存在を証明しない。

## 証跡

Git管理外の`.local-test-data/results/20261015/management-95caf675/`。
元metadata・音源・local secrets/journal・raw evidenceをGit/GitHubへ送らない。
比較は[段階Aの実機結果](publication_queue_commit_measurement_20261015.md)と行うが、ペア化された同時条件の測定とは扱わない。
実装契約は[案C実装](../async_management_implementation.md)。Issue #13の恒久解消は、この試験だけでは確定しない。

## 実測結果

2026-10-15 01:03:26–01:27:38 UTC（JST 10:03–10:27）。
小容量3公開のgate後に36 Episode規模へ進み、7 publication、8 upload operation、23 primary Queue commandを収録。
tail 8 sessionすべてhealthy/complete、truncationやtrigger未分類はなし。
APIのR2結果とlocal journalはすべて同じrequest ID/hashのterminal結果へ照合した。

| Queue command | n | invocation CPU 中央値／最大 | invocation wall 中央値／最大 |
| --- | ---: | ---: | ---: |
| stage-start | 8 | 64／121 ms | 23.615／27.886 s |
| upload-complete | 8 | 100.5／150 ms | 42.397／45.168 s |
| publish（claim/marker/publicationを含む） | 7 | 238／410 ms | 66.867／102.080 s |

CPUは「command内部の特定phase」ではなく、routing/MAC/config/records/service admission等を含む全Queue invocation。
例えばpublishのcommand phase wall中央値は61.395秒で、全invocation wallの66.867秒とは異なる。
同じinvocationの複数phaseへ同じCPUを表示したり、CPUを加算したりしない。

| 公開操作 | n | Queue CPU 中央値／最大 | CLI publish→queued応答 | staging開始→公開確認/drain・capture確認 |
| --- | ---: | ---: | ---: | ---: |
| 小容量Show metadata/cover | 1 | 410／410 ms | 8.159 s | 208.913 s |
| 初回Episode（metadata/audio別update） | 1 | 293／293 ms | 11.916 s | 267.161 s |
| 小容量audio-only | 1 | 225／225 ms | 10.680 s | 175.410 s |
| 36 Episode Show metadata/cover | 1 | 226／226 ms | 10.301 s | 204.368 s |
| 通常metadata-only | 3 | 238／256 ms | 中央値11.271 s | 中央値172.482／最大175.878 s |

Episode数とのCPU増加傾向はこのsampleでは判断しない。小容量Showと36件Showは各1回で、
warm/cold/JIT/ネットワーク等を制御した比較ではない。

### 管理HTTPと公開配信HTTP

content capture内の`/admin/` HTTPは**0**。claim、staging、statusがHTTPから外れたことを確認した。
1件の小容量feedの内部/cache-owner GETが次のnormal captureへ遅れて混入したが、
管理要求ではなく、Queue command CPUへ混ぜていない。maintenanceのservice/target/setup HTTPもこの集計には含まない。

公開配信は別tailでGET/HEAD/Rangeを確認。すべて200/206と期待bytes/checksumになった。

| 公開root HTTP | n | CPU 中央値／最大 | 10ms超過 |
| --- | ---: | ---: | ---: |
| feed GET（小容量/36件を各3回） | 6 | 4.5／11 ms | 2/6 |
| audio HEAD | 2 | 4.5／6 ms | 0/2 |
| audio GET（全量/Range） | 4 | 4／5 ms | 0/4 |

別invocationの内部/cache-owner GETはfeed/audio各2件、CPU最大2ms。root CPUと加算しない。
feedの11msは小容量の1回目と通常の3回目であり、cold startやEpisode数が原因と断定しない。
管理CPUの移譲は達成したが、公開feedは10msを超えるsampleが残り、**全HTTPで10ms以下は未達**。
特定accountの実効plan/limitは未検証。観測設定は`usage_model: standard`、`limits: null`であり、Free/Paid判定には使わない。
権限・課金・CPU limitの変更は行っていない。

### 機能・保存容量・終了状態

- 7件とも署名済み`published`結果とcurrent Show ownerなしを確認。確認時点のserviceはopen、`invocations: []`、同じ新version。
- 初回Episode、metadata-only/audio-only、36件feed生成、cache purge後の完了、GET/HEAD/Rangeが成功。
- 通常EpisodeのGUID、公開日時、enclosure URL、長さ・duration・SHA-256がbaseと一致。
  38,909,491 bytesの既存音源を再利用し、通常規模の音源再uploadはない。
- 新MP3 PUTは合計**161,002 bytes**。新immutableコピーとstagingにはそれぞれこの分のpayloadが残る。
  metadata/cover・小さいrequests/resultsも増えるため、これを全bucket増分とは呼ばない。削除はしていない。
- runtime error/exceptionは収録tailで0。GraphQLは同version/期間40 groups、最大sample interval 1、error groupsなし。
  GraphQLは補助証跡であり、未収録のexceptionが絶対にないことを証明しない。
- runner exit 0。tmux server/pane、試験Bun child、終了監視は完了。未知mutationの再送・強制token返却はない。

### 前回との比較と残る課題

段階Aで残っていたHTTP CPUはclaim中央値24/最大35ms、status 15/52ms、staging finish 72/139msだった。
これらを10msへ微調整したのではなく、**今回の新content経路では呼ばなくした**。

一方、通常metadata-onlyの総wall中央値は前回110.371秒→今回172.482秒、**約62.1秒（56.3%）増**。
総wallにはstaging、enqueue、R2 polling、own IO/tokenの終了確認、tail到着待ちを含み、ネットワーク条件を統制した測定ではない。
非同期stagingの2 command・retention/grant/result/gate IO・Queue待機が候補だが、内部CPUや遅延の因果分解は未実施。
現時点で「公開まで速くなった」とは言わない。

次の検討候補は公開feedの11msとstagingを含む待ち時間。今回の測定承認だけで別Worker分離、
安全確認の省略、権限/課金変更、残る別環境のtoken解放には進まない。
Issue #13は今回の経路では再現しなかったが、7件の成功を恒久解消やサービス全体のFree保証に拡張しない。
