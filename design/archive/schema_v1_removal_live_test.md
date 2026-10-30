# Issue #24: SQLite単独化後の実環境回帰試験

> 試験完了後、管理者承認により初回・再試験のCloudflare専用資源は[2026-10-18に廃棄](cloudflare_issue24_cleanup_20261018.md)した。以下の「環境を保持」は試験終了時の状態。元データ・workspace/journal・非公開証跡は引き続き保持する。

## 合格サマリー

管理者が2026-10-18に試験合格と判断した。製品commit `1171b2a`、Bun 1.4.2のLinux単体CLIを新規Cloudflare隔離環境で検証した。旧環境の途中結果は再利用していない。

| 機能確認 | 結果 |
| --- | --- |
| 方式flag省略の初期化 | schema version 2、SQLite、ready/paused/drained |
| RSS公開 | 短尺3＋通常36 Episode、Show 2、lifecycle 2：計43 job succeeded |
| 整合性・配信 | 全39音源の全量hash一致、HEAD/Range/304、cover、非公開path拒否 |
| 非公開化・復元 | 成功、GUID/日時/音源URL保持 |
| Worker更新 | 配備1回、native反映待機の停止後に明示verify成功。namespace・全39音源・両RSS不変 |
| 終端 | ready/paused/drained、元素材不変、新環境・証跡保持 |

| 今回の実測 | 値・解釈 |
| --- | --- |
| 通常36件、1,496,055,589 bytes | **485.53秒（約8分6秒）**。CLI開始から最終RSS照合までのwall time |
| 短尺3件、801,568 bytes | **25.99秒**。同じく公開command全体のwall time |
| Linux binary | 83,580,384 → 82,621,920 bytes（約1.15%減） |
| runtime TS | 17,653 → 4,997行（約71.7%減。集計範囲は[実装記録](schema_v1_removal_plan.md#基準と測定方法)） |

今回のwall timeはupload・readback・逐次公開・purge・待機を含み、Worker CPU時間や純粋な転送速度ではない。合格判定時点ではCPU/tail数値は未採取だったが、下記「保存ログによるCPU追加確認」で今回のCPUを追加照会した。過去の3/5msを本patchの測定値として流用しない。比較対照のない単発試験のため速度改善・全Free適合・300MB境界を保証しない。最初の試験は外側240秒timeoutの設定ミスで中断し、約8分必要だった再試験で是正した。異常終了後の診断・回復・cleanupは[Issue #40](https://github.com/simosako/castloop-v2/issues/40)へ分離した。

非公開の再試験証跡217ファイルのmanifest SHA-256は`89ac7a75b06e73ba780ba2963671eb81bdab9ac8408ae1bc901f0b6b87ff2a3e`。秘密・本文・job IDやraw journalはGitへ追加しない。

## 承認と範囲

2026-10-18、管理者が既存ローカルPodcastデータを用いた計画作成と順次実施を指示した。新規隔離サービス1件のWorker・private R2・SQLite DOを作成し、workers.devで試験する。対象はservice `i24-20261018`、bucket `castloop-i24-20261018`。既存`sq16r-6ec01dc6`、DNS・独自ドメイン・証明書・権限・課金・CPU上限は変更しない。終了時はpauseして保持し、削除しない。

製品commitは`1171b2a`。Linux単体CLIを使用する。元データ`.local-test-data/`を変更せず、新規の非公開試験workspaceに素材とTOML・import.jsonだけをコピーする。旧`.castloop/`や公開journalは採用しない。証跡・秘密・job IDは新workspaceのgit-ignored領域に保存し、本文やメールアドレスを本書へ転載しない。

## 順序と合格条件

1. 事前確認：account環境変数の存在、対象名の非存在、CLI build/hash、コピー素材のサイズ・SHA-256、importの不足項目とMP3検査。`minimal`3件（計801,568 bytes）、`normal`36件（計1,496,055,589 bytes、最大62,853,537 bytes）。全件300,000,000 bytes以内。
2. flag省略の`init`：schema version 2、SQLite protocol、ready/paused/drained。同じprivate bucketと新規namespaceを記録する。Queueは作成しない。
3. 新windowでresumeし、正式`publish-rss-import`でminimalのShow＋3 Episodeを公開。各jobのsucceededとRSSのGUID・日時・件数・内部音源URLを確認する。
4. GET/HEAD/Range/条件付きGET、カバー、音源の全量SHA-256、未承認system/stagingパス・旧runtime probeの非公開を確認する。キャッシュwarm後も配信identityを維持する。
5. minimal Episodeのunpublish→restoreをpreview/hash確認付きで実施。同じjobのsucceeded、feed除外・復元、既存音源URLの拒否・復旧、GUID/日時/音源hash不変を確認する。
6. 正式RSS公開でnormalのShow＋36 Episodeを順次公開。全job成功、RSS36件と元identityの一致、全音源全量hash一致。既存minimalの公開状態も保持する。通常サイズMP3を使うが300MB境界試験ではない。
7. pause/drain→同一codeのWorker更新1回→native readinessを確認。同じnamespace/config、RSS・音源identity不変。新windowでresume後にも配信・一覧を確認し、最後はready/paused/drainedで保持する。

各段階の合格後だけ次へ進む。未知PUT/POST・blocked・identity/hash不一致で停止し、凍結journalを保持する。変更要求を再送せず、statusのGETで照合する。配備成功checkpoint後の既知の検証停止は、現行更新契約に沿う明示verifyのみを使用できる。故障注入・強制解除・migration・cleanupは行わない。

### 長時間試験の実行方法（中断調査を受けた修正）

- 実環境への逐次mutationを含むbatchを、短い外側timeoutで起動しない。実行ツールでは`background: true`か明示`timeout: 0`を指定する。foregroundの既定timeoutに依存しない。backgroundの場合は完了通知を待ち、同じcommandを二重起動しない。
- 開始時刻・終了時刻・exit code・stdout/stderrを新規の非公開ファイルへ保存する。監視は元processを終了させず、進捗journalとGETだけで行う。長時間経過だけでは再起動しない。
- CLI内部のPUT/readback・管理GET・job待機の有限予算は維持する。外側のbatch実行時間と、単一要求／単一jobの予算を混同しない。
- 起動手順の修正は、今回中断した操作の再送許可ではない。既存の未知PUTと凍結RSS cursorはそのまま保持する。

## 記録と限界

段階ごとに実行時刻・exit code・jobの終端・取得hash・readinessを非公開保存する。ローカル検査とnative結果を区別し、未実施を成功に数えない。CPU/tail完全収録・性能保証・Free全負荷適合・U1保証・Issue #13恒久解消を主張しない。

## 実施結果

- 事前REST読取で対象accountのworkers.dev subdomainを確認。既存Worker/bucketは保持環境各1件のみで、新規対象名は存在しなかった。
- Linux単体CLIをbuildし、86素材ファイルをコピー前後のSHA-256で照合した。試験後にも元86ファイルのhash不変を確認した。
- **入力方式の修正**：コピー先にはRSSダウンロード完了記録がないため、最初のRSS公開はpreflightのENOENTで停止した。登録・upload前の停止であり公開失敗ではない。絶対pathに束縛された完了記録を捏造・書換えず、元の取り込みディレクトリを読み取り入力とした。元のdownload完了記録は素材検証用に読むが、旧公開journalは採用しない。新しい公開状態は専用workspaceへ保存する。

| 段階 | 実測結果 |
| --- | --- |
| 既定init | 成功。service schema 2、SQLite、ready/paused/drained。Worker `castloop-i24-20261018-4bc9485d`、namespace `5358feb40a744914bb1748873782e41b` |
| minimal RSS | Show＋Episode 3件成功。正式RSS runnerのmetadata・GUID・日時・内部音源照合を通過 |
| minimal配信 | 3音源の全量SHA-256・HEADサイズ・Range先頭1024 bytes・304、カバーhash、system/staging/旧runtime probeの拒否を確認 |
| 非公開化・復元 | 両job succeeded。warm済み音源URLは停止時404、feedは2件。復元後3件、元GUID/日時/音源URLと全量hashが不変 |
| normal RSS | **36件中18件まで公開成功、19件目の音源PUT段階で中断**。実行ツールの240秒timeoutでprocess終了。19件目upload journalは`put_requested`でreceiptなし、RSS journalはstep 78の`command_requested`。製品エラーや公開失敗と断定しないが、未知PUTとして保全し再送しない |
| 終端照合 | Show 2＋Episode 21＋lifecycle 2＝計25 jobを別の正式job-statusでsucceeded確認。normal一覧はpublished 18件。未完了音源uploadはこの成功数に含めない |
| 終了 | 明示pause後ready/paused/drained、active null、queued 0。drainedは未登録uploadのsettlement証明ではない。既存保持環境への要求・変更なし。新規環境と全journalを保持 |
| 後続 | normal残り18件、normal全量公開配信hash、Worker更新は**未実施**。停止条件に従って進めていない |

通常音源試験は長時間processをtimeoutなし／backgroundで起動すべきだった。本試験ではharnessの上限指定により途中終了させてしまい、同じ公開commandを再実行していない。未知uploadを推測でverifiedへ変更したり、RSS stepを進めたり、lockを削除したりしない。継続にはこの未知結果と現行CLIの回復契約の検討が必要であり、今回の試験結果を全36件合格と扱わない。

Pythonの初回配信GETは既定User-Agentで200を得られず、curlで200を確認後、明示User-AgentのGETで通過した。pause後のnormal feed GETは503で、現行配信契約はserviceがopenでない間503を返すため、pause中の503を公開破損とは数えない。検査のための再resumeは行わなかった。

2026-10-18 04:34 UTC時点のnative終端を照合した。最終REST一覧は新規＋保持のWorker/bucket各2件、Queue 0件。raw証跡230ファイルとSHA-256 manifestは、このworktreeの`.local-test-data/issue24-live/`へ非公開保存した。製品source変更、migration、未知PUT/POST再送、削除、権限・課金・CPU上限変更、GitHub更新・追加commit/pushは行っていない。

## 240秒中断の原因調査

**直接原因は試験実行者がshell toolへ指定した`timeout: 240000`であり、製品CLIの240秒制限ではない。** toolは`Command exceeded timeout of 240000 ms`を返し、その後processの非存在を確認した。OS signalの種類は採取していない。終了を製品の正常なtimeoutエラーと読み替えない。

時刻は2026-10-18 UTC。log作成時刻はfilesystem birth time、journal時刻はローカルfile mtimeであり、API各要求の送受信時刻そのものではない。

| 証拠 | 時刻／観測 |
| --- | --- |
| normal実行log作成 | 04:29:35.513 |
| 1件目の音源verified | 04:29:57.835 |
| 1件目の公開済みdraft最終記録 | 04:30:01.142 |
| 18件目の音源verified | 04:33:29.408 |
| 18件目の公開済みdraft最終記録 | 04:33:33.692 |
| 19件目のmetadata verified | 04:33:35.146 |
| 19件目音源のput_requested保存 | 04:33:35.426 |

240秒の外側期限はlog作成から約04:33:35.5に当たり、直前まで進捗がある。18件の音源は計699,982,133 bytes。公開済みdraftの記録間隔は最小10.24秒、中央値12.03秒、最大16.18秒で、単一jobが240秒停止した形ではない。36件・約1.50GBのupload、全量readback、公開側の読取・書込、purge、status待機を逐次実施するbatchであり、240秒以内の完了保証はない。各要求への時間の内訳は採取不足のため確定しない。

### codeとローカル検証

- `sqlite-rss-publication.ts`は各actionをawaitする逐次loopで、全importを240秒で打ち切るtimerはない。
- `verified-r2-put.ts`は単一uploadのPUT＋全量readbackに既定300,000ms、`sqlite-draft.ts`は単一公開jobの状態照会に最大300回／新規poll開始5分の予算を持つ。これはimport全体の上限ではなく、今回の19件目PUTもその予算を使い切る前に外側から終了させられた。
- 実音源36件のpreflightだけをローカルで再実行：36件、1,496,055,589 bytes、8.62秒で完了。再公開やCloudflareへの要求は行っていない。この時間は今回の検査値であって性能保証ではない。
- RSS逐次公開、未知upload非再送、draft、PUT/readbackの既存回帰試験：`bun test packages/cli/src/sqlite-rss-publication.test.ts packages/cli/src/sqlite-draft.test.ts packages/cli/src/verified-r2-put.test.ts`、**47 pass / 0 fail**。36件公開の模擬試験を含むが、実機全36件の完了証拠ではない。

今回の中断原因として製品bugは確認されなかったため、製品sourceのtimeout延長・検証省略・並列化・未知IO回復機能は追加しない。修正対象は上記の試験起動手順とRSS操作ガイド。未知PUTを残した現環境の再開・再送は本調査では行っていない。

## 新規環境での再試験

管理者が途中結果を再利用せず、新規で最初から再試験することを承認した。新serviceは`i24r-20261018`、private bucketは`castloop-i24r-20261018`。前の`i24-20261018`と保持環境には要求を送らず、旧journal・payloadを保全する。手順・停止条件は本書の段階試験に従い、mutationを含むbatchは外側`timeout: 0`で実行する。

private証跡保存先は`.local-test-data/issue24-retest/`。同じLinux binaryのSHA-256は`25f75eb34c9fe86b1225339254801cbfec6059510e61444447ab290db0e2febf`。入力は元のminimal/normalとdownload完了記録を読取検証し、新規workspaceに新しいdraft・公開journalを作る。初回initは方式flag省略、exit 0。以後の結果は確認後に記録する。

### 再試験の結果：全段階完了

2026-10-18 UTC。**通常音源36件を最後まで公開し、配信検証とWorker更新後の保持確認も完了した。** 元の中断環境は再開・再送・削除していない。

| 項目 | 結果 |
| --- | --- |
| 初期化 | flag省略でservice schema 2。Worker `castloop-i24r-20261018-8f638a69`、新しいSQLite namespace `c4488fa6c37f43dc9ea1b4c567a5fb05`、ready/paused/drained |
| 短尺3件 | RSS公開成功。全量audio hash、HEADサイズ、先頭Range/Content-Range、ETag条件付き304、cover hash、private path/旧probe拒否を確認 |
| lifecycle | 短尺1件をunpublish→restore。両job succeeded。停止中はfeed 2件・既存audio URL 404、復元後3件でGUID/日時/音源URL不変 |
| 通常36件 | 正式RSS公開command exit 0。05:15:45.261〜05:23:50.787、**485.53秒（約8分6秒）**。約1.50GBの全36件を順次完了。RSS runnerのmetadata・GUID・日時・内部音源URL照合も通過 |
| 公開job | Show 2＋Episode 39＋lifecycle 2＝**43 job**を正式job-statusで別途succeeded確認。upload journal **80件すべてverified** |
| 配信検証 | 全39音源の全量SHA-256が元MP3と一致。全件HEAD/Range/304、両coverとprivate path gateを確認 |
| Worker更新 | 新operationでcode-only配備1回。REST成功後にnative旧versionの有限待機120回へ到達し、初回deploy commandはexit 1。journalはverified、activation未要求。再配備せず正式`update-service-verify`を1回実行し、exit 0、journal ready、native readiness完了 |
| 更新前後 | version `a6ed34fc-5689-45cd-8f9d-50e0d366303c` → `f54c678d-9f82-4af5-bcdb-b21f15ab6151`。同じnamespaceをREST settingsでも照合。resume後に全39音源を再取得してhash/URL/サイズ一致、両feedのbytesも更新前と完全一致。Show/Episode一覧も確認 |
| 終端 | 最終pauseと05:32 UTCの照合でready/paused/drained、active null、queued 0。新規環境とjournalを保持。元86素材ファイルのSHA-256不変 |

namespaceの初回値はinit receipt、更新後はREST settingsで照合した。Worker名はローカル`castloop.toml`とREST要求で束縛し、後述の非公開証跡に保持する。既知のnative反映待機停止は隠さず、配備自体の失敗や再送成功として扱わない。

非公開証跡217ファイルとSHA-256 manifestを再試験directoryへ保存した。公開／uploadの途中結果を旧試験から採用せず、前回の受け入れ確認用scriptのみを使って新環境へ検査を行った。元データとの不変照合では前回の入力hash manifestを参照した。既存2環境の配備・resume・公開・削除、DNS/権限/課金/CPU上限変更、journal手動昇格、unknown再送は行っていない。

この結果は今回の36件・実サイズ音源・code-only更新の機能回帰を示す。300MB境界、異常終了からの回復／cleanup（Issue #40）、CPU/tail全回収・性能保証・全Free適合・U1解決は未検証である。

## 保存ログによるCPU追加確認

管理者の指示で、成功した再試験Worker `castloop-i24r-20261018-8f638a69`の**2026-10-18 05:13:00〜05:32:16 UTC**をWorkers Observabilityの保存ログで照会した。試験の合格判定は変更しない。配備・resume・公開・設定変更・tail作成はせず、`dry: true`の検索POSTのみを使用した。

初回の検索は1分間の2000件上限に達したため集計せず、再取得では該当区間を30秒へ分割した。最終21区間はすべて上限未満、query statisticsの`abr_level`は1。application log・spanをinvocationから分離し、境界の重複をmetadata IDで除いた。CPU付き`cf-worker-event` **1,985件**、2つの試験versionのみ、取得invocation内のCPU欠測・truncatedは0、outcomeは全件okだった。数値はproviderの`$workers.cpuTimeMs`で、0msもproviderの記録値として扱う。

| 区分 | 取得invocation数 | p95 CPU | 最大CPU | 10ms超 |
| --- | ---: | ---: | ---: | ---: |
| 外側HTTP | 910 | 1ms | **3ms** | 0 |
| cache HTTP | 90 | 3ms | **5ms** | 0 |
| cache RPC | 47 | 0ms | **2ms** | 0 |
| DO HTTP | 563 | 5ms | **26ms** | 3 |
| DO RPC | 330 | 0ms | **2ms** | 0 |
| DO Alarm | 45 | 6ms | **7ms** | 0 |

通常Worker側の計1,047 invocationは取得範囲ですべて10ms以内。DO HTTPの10ms超は**11／19／26msの3件**で、通常Workerの10ms枠とは区別する。[WorkersのFree CPU枠](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)はHTTPごと10ms、[DOのCPU枠](https://developers.cloudflare.com/durable-objects/platform/limits/)は既定30秒であり、DOの26msをFree HTTP超過とは判定しない。CPU上限超過outcomeは今回取得分にない。CPUをtrace全体・job全体へ合算して10msと比較しない。

通常36件の公開commandの正確な時間帯だけでは、通常Worker側374件・最大2ms、DO側376件・最大19ms。全試験区間の上表は初期化・短尺・lifecycle・配信・更新の観測も含む。p95は取得値を昇順に並べたnearest-rankで算出した。

**結論：今回取得できた通常Workerの記録では10ms以内に収まる目処がある。** 保存設定はhead sampling 1・invocation logs/persist有効だったが、provider側の欠落がないことや全invocation回収は証明していない。probe IDによる全要求の照合、job単位のAlarm CPU帰属、将来の全負荷・300MB境界の保証はない。trace内のspanやCPUのないapplication logを0ms invocationとして数えていない。

allowlistで本文・header・任意例外・URL詳細を除いた取得記録と集計は`.local-test-data/issue24-cpu/retrieval2/`に非公開保存した。manifest SHA-256は`79caf748d3113ae0ddac0872a0dfc4155c307c96cf938ee83abf6c39d729ce8b`。本書の集計・観測条件・証跡参照をGitで保持し、生ログ・journalは非公開領域に保持する。追加確認によるruntime・実環境設定の変更はない。
