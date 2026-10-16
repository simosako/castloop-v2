# SQLite逐次公開: 実機受け入れ・性能測定

2026-10-16。管理者から動作テストと性能測定の実施指示を受けた。既存環境は変更せず、新規の隔離サービスだけを使う。

## 範囲

- 元sourceはpush済み`4365092`。正式Linux単体CLIを凍結し、tmuxと既存trial supervisorで起動した。証跡・鍵・素材・runnerはGit管理外の`.local-test-data/`に保存する。
- 小容量3件で初期化・公開・配信・更新・非公開化/復元・互換更新を確認し、通過後に36件の実metadata＋短尺MP3へ進む。約1.5GBの原本再転送はしない。大容量転送試験とは区別する。
- CLI wall、DO Alarm CPU/wall、外側gatewayとcache-owner HTTPのCPU/wallを分ける。job/probe identityと収録欠落を明示する。socket接続だけで測定完備とはしない。
- 既存環境の変更、削除、移行、強制解放、権限・課金・CPU上限の変更はしない。subscription参照は403だったため、実planを推測せず有効設定と観測値を報告する。

## 初回初期化で検出したCLI不具合

隔離サービス`sq16-668cbdfa`で、bucket/Worker作成、設定upload、配備、workers.dev有効化は応答を確認して完了した。
初期化は`access_enabled`で停止し、content公開は**0件**。supervisorは停止を検出し、同じOpenCode sessionへの通知確認まで完了した。

原因はCloudflare REST応答のモデル化不足。実際の`GET .../settings`には`exports`がなく、固定したversionの`resources.script_runtime.exports`にのみ存在した。ローカルfixtureは誤ってsettings側にもexportsを返していた。

修正では、固定versionの**必須exports**を使って設定とversionを照合する。ローカルの期待metadataを実証の代わりに使わず、version ID/ETag、単一100%配備、binding、cache、namespaceのWorker/class/SQLite backendを引き続き検証する。実機の読み取りでこの照合が通ることを確認した。

配備済みWorkerは`ab97ab6b-776e-4ed5-9cb7-6ce7678e1760`。native healthはpaused/drained、setupなし、publication_ready=falseを返した。これはDO constructor/SQLiteの初回読取が動く確認であり、Alarm/cache readinessや公開成功ではない。

## 再送しない検証継続

既知の配備receiptとaccess成功が保存され、setupをまだ送っていない場合だけ、明示的な`init-continue-verification`でREST検証と**初回のsetup**を続けられるようにした。
対象phaseは`access_enabled`/`verified`だけ。source/config/metadata hashを元journalへ照合し、nativeのsetup不在・paused/drainedを確認してから送信前に`setup_requested`を保存する。

- resource作成、設定PUT、配備、access変更は一切繰り返さない。
- 既に`*_requested`や`setup_requested`なら継続しない。blocked probeも再実行しない。
- 既に完了したsetupの照合は、従来どおりread-onlyの`init-reconcile`を使う。
- CLI側の応答解析修正後もWorker bundle SHA-256は元journalと一致しており、この修正のためにWorkerを再配備していない。
- 応答形と限定継続の回帰を含む全体テストは1,341 pass / 0 fail（145 files、90.14秒）。型検査・Linux単体CLI buildも成功した。

## 初期化継続と小容量試験

CLI修正`d2da53d`をpushし、元のWorker source hashを保ったまま検証を継続した。初回のnative setupがAlarm/R2/cache/purgeのprobeを完了し、paused / publication_readyで終了した。新たな配備・資源作成はしていない。

その後に明示resumeし、Show 1件と短尺Episode 3件を公開した。メタデータのみ・音声のみ・Show/cover更新、Episode/Showの非公開化と保存snapshotからの復元、個別非公開Episodeの維持を確認した。旧音声保持、メタデータ更新時のMP3 inventory不変、重複publish時のrevision不変、feedの反映、GET/HEAD/Range/304、private pathの404も通過した。小容量は合計13 publication/lifecycle jobsが成功し、最終の機能gateとsupervisor通知も通過した。

最終小容量runnerの42 public probes中、外側HTTPのCPU identityを40件で取得した。後続feed GET 20件中18件のCPUは中央値2 / 最大4ms。外側HTTP全収録89 invocationの最大は4ms、cache owner全収録12 invocationは最大5ms。集計GraphQLの同時間帯Worker最大は5.767ms、errorsは0だった。これらをDO CPUと混同しない。

### 試験側の中断と測定欠落

- 検証継続runnerは正常終了したが、terminalファイル名がsupervisorの規約と異なり、supervisor側は未確認として通知した。完了済みsetupは再送せず、native healthで確認した。後続runnerのファイル名を修正した。
- 最初のEpisodeはpublish CLIが約2.4秒で成功したが、対応Alarmログが届かず、CPU収録ガードが停止した。これはpublicationのfreezeではない。GraphQLのDO invocation集計で、そのAlarmがsuccess / wall約1.702秒であることを補完確認した。個別CPUは補完できていない。
- 元coverは2,173,207 bytesで、試験側のresponse上限2MBを超えた。元データの大きさに合わせて上限を3MBに直した。成功済みの公開は再実行せず、読み取りcheckpointから配信試験を続けた。
- 通常規模Show公開の直後、jobログを持たない別Alarmの`canceled`が届き、監視ガードが停止した。Show jobのsuccessを保持した。後続では、こうした未割当Alarmのcancelを記録し、新規mutation前にnative readiness・drained・直前job成功を読み取り照合する。未完了/blockedがあれば進まず、token返却や同じ要求の再送はしない。cancelのplatform側原因が判明したとは扱わない。
- `succeeded`ログがAlarmではなく並行するDO status HTTPのtraceへ付く例もある。jobログのあるinvocationのCPUを、そのjobのAlarm総CPUとは呼ばない。socket health、全probe収録、Alarm CPU帰属は別の条件である。
- 保存observabilityログの照会は403。権限を拡張しない。DO GraphQLのperiodic CPUは管理HTTP/RPC等を含む期間集計であり、job別CPUではない。

この段階だけでIssue #13恒久解消、Free適合や36件性能目標の達成を示したとはしない。

## 通常規模: 14件成功、15件目でblocked

通常規模Showの既知の公開完了を読み取り照合して、Episodeの逐次公開から継続した。**14/36件が成功し、15件目で`blocked / execution_failed`となったため後続を停止した。** CLIは約2.37秒で失敗を報告し、supervisorも停止を検出して通知確認まで完了した。無反応のfreezeやOpenCodeの時間制限による中断ではない。

### 測定値（修正前の実機）

| 対象 | 観測値 |
| --- | --- |
| 成功14件のcreate→metadata upload→audio upload→publish完了 | 合計89.940秒、中央値6.130秒、最大9.919秒/件 |
| そのうちpublishコマンド | 中央値2.410秒、最大2.470秒、n=14 |
| MP3 upload | 15件目を含め1,207,515 bytes。原音源の再転送なし |
| 管理経路の外側HTTP CPU | tail 97件、最大1ms。GraphQLの同時間帯Worker最大1.870ms、platform errors=0 |
| DO Alarm wall | GraphQLの15 invocationで最大2.037秒 |
| DO CPU | periodic期間集計315.093ms。status HTTP等も含み、job別/AlarmだけのCPUではない |

tailのAlarm frameは3件しかなく、14成功jobのうち8件はjobログも未収録。**platformのsuccess / errors=0は、アプリのpublication成功を示さない。** 実際に15件目はblockedである。36件完成feed、36件metadata-only 10回、20/16件pagination、code-only互換更新の実機gateは未実施のまま停止した。

### 停止箇所

失敗jobは`a03e7cc4-ab8c-4aab-810b-add5f753952a`（sequence 29）。読取調査で次を確認した。

- 音声、revision履歴、current metadataは凍結jobの内容でR2に存在し、音声hashも一致した。
- 固定feedは15件目を含む内容まで保存されていた。
- 同時間帯にcache ownerの`invalidate` RPCが実行された。executorではfeed書込後の最後の副作用がこのpurgeだけであるため、失敗箇所を**cache purge段階**へ絞れた。
- SQLiteは14件目までの承認状態を保ち、当該Showのfeedは外側gatewayから503となった。途中書込を公開扱いにしていない。
- serviceはopen / publication_ready=trueだが、active=blocked / drained=false。完了ではなく、後続公開・互換配備へ進めない状態である。

旧実装はtagとprefixを**別々の2回**のpurgeとしていた。公式文書では、Workers Cachingのpurgeはaccount/zone planにかかわらずFree tierの制限を使い、tag/prefix等は5 requests/min、bucket 25。連続公開による制限到達が有力だが、旧実装が拒否内容を保持しておらず、**rate-limit拒否かRPC障害か、どちらのpurgeが失敗したかは確定していない**。

## 停止後の修正（ローカル検証のみ）

- SQLite cache owner専用の`purgeSqliteCache`でtag/prefixを同じ1回のpurgeにまとめた。公式APIのunion semanticsを使い、対象範囲は維持する。既存のR2方式のpurge helperは変更していない。
- `success:false`の応答があり、providerのメッセージが既知のrate-limit表現に一致する場合だけ、**同じ実行内**で12秒間隔・最大6 attempts（待機合計最大60秒）のpurge再試行を行う。provider本文は保存せず、固定の診断分類だけを出す。未知/恒久拒否、例外、応答形不明は再試行せず停止する。表現を認識できない拒否も安全側に停止する。
- 待機中もjobはrunning、Show配信は503のまま。R2音声・metadata・feedは繰り返し書かず、purge成功後だけSQL完了へ進む。job/POSTの再送やblockedの解除・再開ではない。
- 公開失敗にjob/request IDと固定の失敗phaseを付ける。音声、revision、current metadata、feed、cover、purgeを区別し、例外文・metadata本文・鍵をログへコピーしない。
- 関連回帰53 pass / 0 fail。最終の全体`bun test`は**1,349 pass / 0 fail（146 files、97.23秒）**。型検査とLinux単体CLI buildも成功した。36件の模擬rate-limit回帰はローカル検証であり、36件実機完走とは区別する。

修正版はこのblocked環境へ配備していない。試験用processは終了し、証跡・途中出力・jobを保全した。強制解除、削除、新環境の追加作成、permission/plan/CPU上限変更は行わない。blockedの安全な復旧または別の新規隔離環境について管理者と決めるまでは、36件再試験へ進めない。Issue #13恒久解消、全HTTPのFree適合、release readinessは未確立。

## 公式仕様の参照

- [Workers Cache purge: 同時指定・結果・常にFree tierの制限](https://developers.cloudflare.com/workers/cache/purge/)
- [Purgeのaccount単位token bucketと5 requests/min / 25 burst](https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits)
- [DO analytics: invocation wallとperiodic CPUの区別](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
