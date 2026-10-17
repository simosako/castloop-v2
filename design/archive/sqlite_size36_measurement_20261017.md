# SQLite開発版: 36件規模の再試験・CPU測定

2026-10-17。管理者から、本番規模の実行試験と測定を必要なら実施するよう新たな指示を受けた。
完了通知から以前の権限を延長するものではなく、この指示に基づく限定した追加試験である。

## 範囲と判定

- 対象は既存の隔離サービス`sq16r-6ec01dc6`だけ。Worker `8ace6fc5-aa21-49f5-ac88-f9d3c50ef82e`、SQLite namespace `ea16615b38a94698805758bf18bb0458`を維持する。
- 実行前にREST配備・namespace・configとnative ready/paused/drainedを照合する。新しいwindow UUIDで一度resumeし、新しいShowへ36 Episodeを逐次公開する。
- 保存済みの実metadataと80,501 bytesの短尺MP3を使用する。MP3 uploadは合計2,898,036 bytes。エピソード数・metadata量の通常規模試験であり、1.5GB原本や300MB音源の転送試験ではない。
- 36件feed、GET/HEAD/Range/304、cover、一覧20/16件を確認する。続いてmetadata-only更新10回を測り、GUID/date/audio URL/hashとMP3 inventory不変を確認する。
- 既存Show・全既存R2 objectのkey/ETag/sizeと既存36件feed bytesを保持する。正常終了時はpauseし、ready/paused/drained・active null・queued zero・feed 503を確認する。
- 外側HTTP・内部cache HTTP/RPC・DO HTTP/RPC/Alarmの各CPUを分ける。通常Workerの10msとDOの既定30秒を混同しない。ジョブ合算CPUは判定条件にしない。
- 保存ログを事前に確認し、試験中は個別ログ到着を待たない。tailは補助監視とし、試験後に保存ログを有限時間で検索する。数値CPUのないイベント・不足probe・収録範囲は明示する。
- CLI wall、公開・upload・metadata更新のwallを記録する。freeze/blocked/failed/CPU超過・未知応答なら新規mutationを止め、要求・journal・IOを保持する。POST/PUT/公開/registrationの再送や置換はしない。
- tmuxと独立supervisor・同一OpenCode sessionへの通知を使う。試験用素材・鍵・個別runner・証跡はGit管理外の`.local-test-data/`に保存する。

配備、activation、資源追加、旧blocked環境の変更、cleanup/deletion、強制解放、migration、domain、権限・課金・CPU上限変更は行わない。
異常停止時は、正常終了用pauseを未知IOの強制終了や解放の代わりに使わない。状況を読み取りで確認して報告する。

## 準備確認

既存隔離サービスのready/paused/drained、正確なWorker/deployment/namespaceと通知先を読み取り確認した。
ソースはpush済み`2403b8e`。アプリ変更はなく、追跡対象の未commit変更は調査文書だけ。
正式Linux単体CLIを再buildし、共通観測部品58件のテストは成功した。

## 起動

UTC 2026-10-17 01:45:14に、独立したtmux/supervisorで一度だけ起動した。
証跡は`.local-test-data/results/20261017/sqlite-size36-c731f967/`、新Showは`size36-c731f967`。
launcherとtmux server/paneのprocess groupが異なり、supervisorの通知先検証とrunner起動を確認した。
実Workerの配備・activationは行っていない。

runner・importするprivate/shared helper・正式バイナリ・metadata・cover・短尺MP3・service configのhashを凍結した。
launcherでは、deploy/init/既存Show変更/未知のwindow・音源等の7種類を拒否し、許可された新規操作とcontrolの二重要求拒否をローカルで確認した。
private scriptの型検査、過去の正式CLI出力のstatus schema、数値0msとsecret非出力のsanitizer検査も通過した。

完了はsupervisorの同一OpenCode session通知と、別の読み取り専用reporterで確認する。
reporterはディレクトリの変更通知で終了記録を待ち、試験・CLI・Cloudflare要求を再起動しない。

測定完了表示は今回のpublic probeと実行区分の観測範囲に限定する。
欠けたログを0msとせず、今後の全操作・全負荷のFree適合やIssue #13恒久解消へ拡大しない。

## 途中停止と読み取り調査

UTC 01:47:01にrunnerが停止した。**Show 1件＋Episode 14件、計15 jobの公開は成功**していたが、36件完走・metadata-only更新10回・新Showの最終配信gate・正常終了用pauseは未実施である。
通知の`CLI exit=1`はsupervisorが起動した試験runnerの終了コードであり、最後の`publish-episode`自体はexit 0、wall 2.502秒だった。

### 原因

停止はCPU超過や公開runnerのfreezeではなく、`SqliteObservationGuard.assertHealthy()`による監視停止だった。
UTC 01:47:00.903に受信した外側GETのtraceが`HTTP 200 / canceled / CPU 0ms / wall 9ms`だった。
例外・truncation・アプリ失敗ログはなく、collectorの197 frameは全件保存、schema拒否0だった。

保存ログの同一イベントでも`canceled`を確認した。URLにはprovider側のredactionがあり、
`/admin/sqlite-publication/jobs/`という読取経路の種類は分かったが、正確なrequest/job IDは復元できなかった。
sanitizerのUUID一致allowlistを通らずpathが未設定となり、正確なstatus GETだけを再照合対象にする既存ルールに入らなかった。
その結果、次のEpisodeの`create-episode`を起動する前に停止した。cancelが発生したprovider側の原因は未確定である。

未識別のcancelを一律に成功扱いしたり、単にguardを無効にしたりしない。
初回報告では相関IDの追加が必要としたが、後述の追加調査で、保存済みtrace ID/Ray IDによる相関が可能と分かった。
新しいheaderの追加を必須とはせず、まず既存の相関情報を監視に保存し、exact runtime/job再照合へ接続する方法を優先する。

### 保全・現状

読み取り証跡は同ディレクトリの`readonly-stop-966b88c6/`。保存ログ検索と正式CLIの`service-status`/既知の15件の`job-status`だけを実行した。
**15/15 jobのstatusは元の成功記録と完全一致**し、同じversion/config/windowでready/open/drained、active null、queued zeroだった。
runner・supervisor・最後のCLI・tmux server/paneはすべて終了し、stderrは全ファイル空、通知はacknowledgedだった。
pause・resume・公開・upload・registrationの再送、強制解放、配備・削除は行っていない。

試験の原`run-result`・中間report・凍結helperは上書きせず残した。
最初の読み取り調査`readonly-stop-a7c99c1a/`では、CPU filter付きAPI応答にCPUを持たないapplication logも含まれ、private集計scriptが停止した。
これは元の試験停止とは別の、試験後集計の入力仮定の不足である。
private collectorはinvocationと`cf-worker`等のapplication logを区別し、未取得CPUを0へ置換せず別記するよう修正した。
`cf-worker`のpublicationログにCPUがない実例は`log-shape-check.json`にallowlist保存した。
未知形式や本来のinvocationのCPU欠測がある場合はmeasurement completeにしない。
修正前の中間`cpu-summary.json`の`missing_cpu_invocation_ids`には、型をまだ識別できなかったapplication logも含まれる。
その配列30件を、そのまま30 invocationのCPU欠測と報告してはいけない。数値CPUの250件と分離して保存している。

### 停止までの測定値

保存ログから数値CPUを持つ250 eventsを取得した。試験後の読み取り確認のCPUは含めず、元のrunner開始〜停止時刻で絞った。

| 対象 | 取得件数 | CPU最大 |
| --- | ---: | ---: |
| 外側HTTP | 112 | 3ms |
| cache HTTP | 1 | 2ms |
| cache RPC | 15 | 1ms |
| DO HTTP | 106 | 40ms |
| DO RPC | 2 | 1ms |
| DO Alarm | 14 | 10ms |

通常Workerの10ms超過、DOの既定30秒超過は観測しなかった。これは停止までの範囲であり、36件規模の最終CPU測定とは呼ばない。
最初の2 public probeは2/2照合できたが、新しい36件feedや音源配信の測定区間へは到達していない。
application logやAlarmの件数をjob総CPU・全invocation回収の証明に読み替えない。

14 Episodeのcreate/upload/publish合計は91.158秒、中央値6.462秒/件、最大8.071秒。
publishだけでは中央値2.511秒、最大3.611秒だった。ここでの中央値はprivate reporterと同じ上側中央サンプルである。
新規MP3 uploadは1,127,014 bytes。metadata-only更新は0件で、前回の36件完走結果を今回の未完了分へ流用しない。

## canceled理由のCloudflareログ追加調査

管理者の指示により、UTC 01:46:57〜01:47:03の保存ログ・GraphQL・該当traceを再検索した。
証跡は`.local-test-data/results/20261017/sqlite-cancel-reason-1d7e286a/`。
対象アプリへのHTTP要求は発生させず、Cloudflareのログ検索POSTだけを使用した。

### 確認できた直接の理由

**Cloudflare GraphQLでは、該当秒の外側HTTP 1件が`clientDisconnected`に分類されていた。**
Cloudflare公式の定義は「Workerの応答完了前にクライアントが切断した」であり、CPU timeoutとは別の分類である。
同じ集計のCPU最大は622µs（0.622ms）、wall最大は10.815ms、errorsは0だった。
保存ログの`canceled / HTTP 200 / CPU 0ms / wall 9ms`とも、CPU超過でない点は一致する。
HTTP 200は応答statusの記録であり、Cloudflareが応答のライフサイクル全体を正常完了と判断した証明ではない。

### URLが伏せられていても関連ログを相関できた

元のキャンセルイベントには既に`$metadata.traceId`と`rayId`があった。
これらを一致照合すると、同じtraceのDO status GETは**HTTP 200 / outcome ok / CPU 4ms**で、
そのDOログには最後の公開job `c0c7e1c9-218b-4290-be34-5461b9be4c15`の`succeeded`が記録されていた。
したがって、公開処理がcancelされたのではなく、公開状況を取得する外側HTTP接続の切断が試験ガードを発火させたと整理できる。
並行するDO statusのCPUをjob全体やAlarm CPUへ付け替えてはいけない。

該当traceは6 spans / 256ms、記録されたtrace errorsは0件。
DOへのfetch spanにはHTTP 200とresponse body size 281 bytes、外側root spanにはHTTP 200とoutcome canceledがあった。
例外・CPU超過・メモリ超過・timeoutの理由field、`span_not_ended`警告は今回取得した記録にはなかった。
イベントの相関用IDはprivate証跡ではhash化し、認証header・IP・任意error message・URL本文を保存していない。

### まだ特定できないこと

保存ログは`clientDisconnected`より詳細な切断理由を示していない。
Bun/CLIによる明示的cancel、HTTP接続の終了タイミング、途中のネットワーク切断のどれかは、このログだけでは確定できない。
CLIの30秒timeoutを原因とする時間記録ではなく、そのCLIは切断記録の約1秒後にexit 0で終わっていた。
`readSqliteManagementJson`に本文読了後も`reader.cancel()`を呼ぶ実装は残っているが、通常のclosed streamへのcancelはno-opであり、
このコードが今回の切断を起こしたと断定したり、変更だけで原因を解決したと主張したりしない。

実施したのは保存済みログの調査と記録だけ。公開・resume/pause・再配備・設定変更・強制解除はしていない。

## 読み取りの有限retryと監視側の修正

管理者から、通信断は起こり得るため有限retryを実装するよう指示された。以下はローカルのCLI・共通試験部品の修正であり、試験の再開やCloudflare変更ではない。

- SQLite管理GETに限定し、初回を含め最大3試行、1試行最大10秒、試行開始の総予算30秒とする。
  通信/本文読取エラー、Content-Length不足、408/429/500/502/503/504だけを再試行する。
  通常250ms→500msで待ち、`Retry-After`を予算内だけ尊重する。開始済みIO・cleanupのsettlementを待ち、timerも終了時に解除する。
- 401/403・404等の恒久拒否、不正なJSON/UTF-8/header/schema/identity、サイズ超過、cleanup失敗は停止する。
  確認済み`404 / no-store`の未登録publicationだけは従来どおりnullとして返し、200のJSON nullとは混同しない。
- 公開・登録・control・配備のPOST、音源等のPUTは自動再送しない。POST形式の一覧も対象外。
  同じ凍結request/job/generationを読み直すだけで、新しいjobへの置換やblocked解除は行わない。
- `SqliteDraft.wait`の最大300 GETと5分の新規GET開始上限は維持し、内側のretryも実際のGET数へ加算する。
- JSON本文のEOF読了後はreader.cancelを呼ばずlockだけを返す。未完了の拒否入力だけawait cancelする。
  この整理だけで今回のclientDisconnectedの原因が確定・解消したとは扱わない。

既存保存ログのtrace ID/Ray IDが過去イベントの調査に有用な点は変わらない。
一方、今後の正式CLI status GETには非秘密の`X-Castloop-Status-Request`へ既存の凍結request UUIDを載せる。
共通tail collectorはこれをUUIDとしてallowlist保存し、URLがredactedでも、正確に対応付くGETのcancelを「読取照合待ち」へ分ける。
native HTTP 200またはresponse前のcancelだけが候補で、POST・未知GET・ID矛盾・例外・truncation・公開/purge失敗は従来どおり停止する。

cancelを受けただけでは新規mutationへ進めない。
CLIによる完了確認、同じruntime/config/version/windowとcompleted update、ready/drained、正確なrequest/job/hashのsucceededを再GETで照合した後に限り、
試験ガードの照合待ちを解消する。所有権や実行tokenを変更する操作ではない。
過去のheaderなしredactedイベントを、この新しい条件で自動採用・成功扱いしたり、元試験を再起動したりしない。

修正後の全自動テストは**1,419 pass / 0 fail（151 files、94.11秒）**。
型検査、private runnerの型検査とLinux単体CLI buildも成功した。
通信/本文断、有限retry・deadline・300回上限、cleanup settlement、POSTの再送禁止、schema/identity不一致、
redacted status GETと凍結requestの対応付け、照合前mutation禁止、秘密非出力を回帰確認した。
Worker bundle SHA-256は既存配備と同じ`3681b1aa8400bbc7f449be49dfacbc85fb020521c27bbd1d69aea5bdb308f504`で、Workerコードの配備変更は不要だった。
この修正の実機再試験、既存サービスのresume/pause、公開の再開、commit/pushは行っていない。

## 管理者の追加指示による残り試験の再開

上記修正の報告後、管理者から実機試験を再開するよう明示指示を受けた。
UTC 03:37:44に、別証跡`.local-test-data/results/20261017/sqlite-size36-b72bef82/`で
継続用runnerを一度だけ起動した。元の証跡・終了記録・凍結バイナリは上書きしていない。

- 同じShow `size36-c731f967`、同じWorker/deployment/namespace/configを使用する。
  事前の読み取り確認はready/open/drained、active null、queued zeroで、既存window
  `b6e9b73b-039a-4824-9ee7-111b88199744`を維持していた。resumeは再送しない。
- 新しい正式CLIバイナリは`2403b8e`上の有限GET retry修正を含む未commit作業ツリーからbuildした。
  起動時にバイナリ・runner・共通helper・アプリソース・fixtureのhashと差分をprivate証跡へ凍結した。
  Worker bundle hashは既存配備と同一であり、配備・activationは行わない。
- runnerは成功済み15 jobのnative/local statusと凍結request、14 Episodeのrevision/GUID/date/audio、
  既存object inventory、未開始22 Episodeを読み取り照合してから、新しい操作だけを開始する。
  成功済み公開、Show登録・公開、resume、既存Episodeへの音源再upload、配備の再要求はscope checkで拒否する。
- 残り22 EpisodeのMP3 upload予定は1,771,022 bytes。その後、36件feed・配信・20/16件一覧と
  metadata-only更新10回を確認し、元の未要求pause operationを一度だけ使って正常終了する。
- 前半14件と後半22件は中断とCLI修正を挟んでいるため、連続36件の性能ベンチマークとはしない。
  今回の22件の時間、10回更新の時間、合計公開件数を分離する。ジョブ合算CPUは判定条件にしない。

継続用scriptの型検査、Linux単体CLI再build、差分の空白検査は成功した。
完了通知を検証済みの独立tmux/supervisorと、変更通知で待つ読み取りreporterの起動を確認した。
この節は再開時点の記録であり、残り試験の完了を意味しない。異常時は再送・強制解放せず停止する。

## 継続試験の完了結果

UTC 03:41:51にsupervisorの正常終了通知を受信し、保存済みの結果・stderr・通知outbox・process終了を確認した。
この確認でCloudflare要求の再実行・再送は行っていない。
証跡は`.local-test-data/results/20261017/sqlite-size36-b72bef82/`。

### 機能と保全

- 追加32 job（残り22 Episode公開＋metadata-only更新10回）がすべて成功した。
  前半の15 jobを含む累計47 jobは、Show公開1＋Episode公開36＋更新10で、job IDも47件すべて一意だった。
- 36件feed、GET/HEAD/Range/304、cover、一覧20/16件、更新後feedの内容を確認した。
  metadata-only更新はGUID/date/audio URL/hash/sizeを保持し、MP3 inventoryを変更しなかった。
- 元の253 objectのkey/ETag/sizeと既存36件Showのfeed bytesを保持した。
  継続開始時に存在した328 objectも、新Showのfeedと更新対象Episodeのcurrent metadataの2 keyを除いて保持した。
- 新MP3 uploadは今回1,771,022 bytes、前半との累計2,898,036 bytes。
  最終R2 inventoryは458 objects / 35,481,838 bytesだった。
- 最終状態は同じWorker/version/namespaceのready/paused/drained、active null、queued zero、公開feed 503。
  freeze、blocked/failed、CPU上限超過、canceledは今回観測しなかった。

### 時間

| 対象 | 件数 | 中央値 | 最大 |
| --- | ---: | ---: | ---: |
| Episode create＋metadata/audio upload＋publish | 22 | 6.259秒 | 7.667秒 |
| 上記のpublishコマンドのみ | 22 | 2.467秒 | 2.655秒 |
| metadata-only update＋publish | 10 | 3.264秒 | 4.813秒 |

残り22 Episodeの連続区間は139.527秒だった。
中央値は、偶数件では中央2値の算術平均を使用している。
前半14件と後半22件は中断・CLI修正を挟んでおり、36件連続公開の総wallとして合算しない。
短尺音源によるエピソード数・metadata量の通常規模試験であり、大容量音源の転送性能を示すものではない。

### 各invocationのCPU

試験終了後の保存ログ検索で、数値CPUを持つ765 eventsと、CPUを持たないapplication context 64件を分離した。
公開probeは**60/60**を対応付け、未知区分0、取得したinvocationのCPU欠測0、適用上限超過0だった。

| 区分 | 取得件数 | CPU最大 | 適用するCPU上限 |
| --- | ---: | ---: | ---: |
| 通常Worker・外側HTTP | 342 | 3ms | Free 10ms |
| 通常Worker・cache HTTP | 17 | 5ms | Free 10ms |
| cache RPC | 32 | 0ms | 通常Worker側の記録 |
| DO HTTP | 282 | 19ms | DO既定30秒 |
| DO RPC | 60 | 1ms | DO既定30秒 |
| DO Alarm | 32 | 11ms | DO既定30秒 |

0msは保存ログの数値表現であり、欠測の置換ではない。
DOの19ms/11msへ通常Workerの10ms制限を適用せず、ジョブ全体のCPU合計も判定条件にしない。
今回確認した通常HTTPの経路・負荷では10ms目標を満たした。
`measurement: complete`は今回のprobeと取得した実行区分の観測範囲を意味し、
platform上の全invocation回収、未試験経路・将来負荷を含むFree全面適合やIssue #13の恒久解消を保証するものではない。

### 監視・終了確認

正式CLIの179コマンドは全件requested/settledが対応し、終了コードはすべて0だった。
181個のstderrファイル（runner/supervisorを含む）はすべて0 bytesで、wrapper/supervisorもexit 0だった。
通知outboxは`passed / acknowledged`、tailは500 invocationを受信し、拒否frame 0、capture faultなし、照合待ち0で終了した。
tmux server/pane・supervisor・runner・最後のCLIのPIDはいずれも終了済みだった。

今回、読み取り通信断やGET retryの発動は記録されなかった。
したがって、修正版CLIで正常完走したことは確認できたが、実機で障害を再現してretry分岐を検証したとは扱わない。
通信断・有限retry・期限・mutation非再送の分岐は前述の自動回帰で確認している。
配備・activation・追加resume・成功済み要求の再送・削除・強制解放・権限/課金/CPU上限変更は行っていない。
この完了通知は、追加の公開・再開・cleanup等の権限を与えるものではない。

参照：[Workers errors — Client disconnected by type](https://developers.cloudflare.com/workers/observability/errors/#worker-errors)、
[Workers tracing](https://developers.cloudflare.com/workers/observability/traces/)、
[Workers Trace Events](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/)。
