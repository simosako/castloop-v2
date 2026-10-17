# SQLite実機試験のDO・CPUログ欠測調査

2026-10-17 JST。管理者の指示により、[追加受け入れ](sqlite_followup_verification_20261016.md)の最終試験でDO/Alarmと一部HTTPのCPUログが欠けた理由を調査した。
対象は完了済みの隔離サービス`sq16r-6ec01dc6`だけ。公開・resume・配備・activation・Alarmの起動は再実行していない。
証跡はGit対象外の`.local-test-data/results/20261017/sqlite-tail-reason-43034ebf/`。

## 結論

- **DOは実行されていたが、そのイベントが元のtail採取記録に届いていない。**
  元の試験時間帯を照合したCloudflare GraphQL集計には、同じnamespaceのHTTP 43回・RPC 28回・Alarm 4回がすべてsuccessとして記録されている。
  それに対し、元のtailにはDOイベントが0件だった。
- **tail有効化のDOへの反映待ちは有力な仮説だが、確定していない。**
  元のrunnerはsocket接続直後に試験を始め、DOログの到着を一度も確認していなかった。
  CloudflareはDOのtail有効化にsoftware updateが必要と説明している。
  後日の同じtailでDOログを受信できたこととは整合するが、当時の反映完了時刻は観測していない。
- **長い配送遅延は今回の追加観測では再現しなかった。**
  読み取りGETの外側HTTP 14/14件、相関ID付きDO HTTP 7/7件を取得し、応答完了後の到着は最大57msだった。
  「2秒待てば十分」という保証にも、「2秒で閉じたのが全欠測の原因」という証明にもならない。
- socket接続だけではDOの採取準備完了を証明できず、**必要なログの到着を待たず固定2秒で閉じること**にも不足がある。
  ただし開始前にログ受信を待つことを必須とする必要はない。管理者の指摘により、保存ログを試験後に検索・集計する方式を優先する。
  公開処理の失敗、CPU timeout、修正済みの日時schema不具合を今回の原因とする証拠はない。
- **保存ログ検索の403は、管理者によるWorkers Observability Readの追加後に解消した。**
   元の試験時間帯のデータと数値CPUを検索でき、保存ログ上のAlarm 4件を確認した。
   続く照合では公開HTTPの**19/19 probeを回収し、欠測4件をすべて補完できた**。
   job/Alarmとの完全なCPU対応付けは未完了で、元のmeasurementを一括してcompleteへ変更していない。

## 1. 元の試験を再確認した結果

対象証跡は`.local-test-data/results/20261016/sqlite-followup-d2bfc94b/`。

| 確認項目 | 結果 |
| --- | --- |
| tail接続から終了まで | UTC 22:05:29.165〜22:06:06.984、約37.8秒 |
| socket/collector | native 64 frames、保存64 rows、schema拒否0、採取faultなし |
| 保存されたイベント | 外側HTTP 54、cache HTTP 6、cache RPC 4、DO/Alarm 0 |
| 公開probeのCPU | 19件中15件。最後のRange・304・既存feed・paused feedの4件が欠測 |
| Cloudflare集計 | 同namespaceのDO HTTP 43、RPC 28、Alarm 4、すべてsuccess |
| 確認時のWorker設定 | logs/tracesともenabled、head sampling rate 1、logs.persist/invocation_logsも有効 |

GraphQLの照合範囲はUTC 22:05:00〜22:07:00。adaptive集計は個別traceの代わりではないが、DOが実行されなかったという説明とは一致しない。
期間全体のDO CPU集計は192.705msだった。ただし管理GET/RPC等を含み、4件のAlarmだけのCPUや各公開CPUへ分配してはいけない。
外側Workerの同期間最大CPUは2.666ms。これも個々の欠測probeのCPUを復元する値ではない。

受信済みの64 framesはすべて保存されており、修正済みcollectorが受信したDOイベントだけを捨てたという形跡はない。
`scripts/test-support/worker-tail.ts`に64件で打ち切る上限もない。
socketの正常性は、対象DO・要求の全イベントが配送された証明ではない。

欠測4件の応答完了からsocket終了までは、順に3,686 / 3,668 / 2,814 / 2,006msだった。
終了直前に欠測が集中するため、到着確認なしの固定待機は改善対象。ただし、試験全体でDOが0件だった理由をこれだけで説明できない。

## 2. pausedのまま行った追加観測

同じWorker version `8ace6fc5-aa21-49f5-ac88-f9d3c50ef82e`、同じconfig・namespaceとready/paused/drainedを前後で確認した。
UTC 22:58:14から2分間、0/5/15/30/60/90/120秒でhealth GETとpaused feed GETを1回ずつ実行し、その後30秒待った。
healthは200、feedは想定どおり503。公開や管理mutationは行っていない。

同時に2種類のtail clientを接続した。

| tail作成body | 外側HTTPの相関取得 | DO HTTPの相関取得 | DOの応答後到着時間 | 外側HTTPの応答後到着時間 |
| --- | ---: | ---: | --- | --- |
| 従来の`{}` | 14/14 | 7/7 | 中央値20ms、最大57ms | 中央値17ms、最大57ms |
| Wrangler既定と同じ`{ "filters": [] }` | 14/14 | 7/7 | 中央値21ms、最大56ms | 中央値17ms、最大56ms |

最初のGETからDOログを取得できた。2秒を超えて届いた相関イベントは0件。
各clientは相関対象外の最後のhealth確認も含め、DO HTTP 8・外側HTTP 15・DO RPC 7の計30 framesを保存した。
schema拒否・採取fault・sampling警告はいずれも0件。
`{}`と明示的な空filterによる違いは再現しなかった。WebSocketの`trace-v1`と`{ "debug": false }`も公式Wrangler実装と一致する。

**両clientは元の試験と同じ既存tail IDを返された。新規tailの有効化直後を再現した比較ではない。**
したがって、約53分後には同じclient/WorkerでDOログを取れることは確認できたが、元の有効化に何秒かかったかは分からない。
Alarmは起動していないため、この追加観測を元のAlarm CPUの欠測補完やAlarm経路の完全採取証明には使わない。

## 3. 仮説ごとの判断

| 仮説 | 判断 |
| --- | --- |
| DOへのtail有効化の反映が間に合わなかった | 有力だが未確定。短い元試験と、後日の同tailでの正常取得は整合する |
| ログ配送が遅く、終了後に届いた | 元試験では未確定。今回のGETでは最大57msで、長い遅延は再現しなかった |
| ログ設定の無効化・明示的sampling | 確認時の設定に該当なし。real-time tail独自のsamplingを完全には除外できない |
| `{}`によるtail filterの不足 | 同時比較で差がなく、原因として再現しなかった |
| collectorのschema拒否・保存漏れ | 元の最終試験は64/64、拒否0で、この説明を支持しない |
| アプリのWebSocketが閉じずflushされない | 対象は通常のGET/RPC/Alarm。公式のWebSocket遅延条件は該当しない |
| 公開処理が動かなかった・CPU制限で停止した | 4 job成功とGraphQLのDO成功記録があり、今回の欠測理由とする証拠なし |

Cloudflareは、DOでtail/dashboard logsを有効にする際にはsoftware updateが必要と説明している。
また、一般のWorker/DO code更新はeventually consistentで、通常秒〜分の差があり得るとしている。
これをtail反映時間の保証や、今回の伝播遅延の確定値に読み替えてはいけない。

公式の「WebSocketが閉じるまでログが遅れる」は**観測対象アプリのWebSocket要求**についての説明であり、tail採取用WebSocketを閉じれば未配送イベントが回収できるという意味ではない。

保存済みWorkers Logsの検索も試したが、権限追加前のtokenではtelemetry keys APIが403だった。
その時点では権限を変更せず停止し、当時の保存ログとの照合は未実施だった。後述のRead追加後に検索可能になったが、tail欠測自体の原因はまだ確定していない。

### 保存ログ検索403の追加調査

管理者の追加指示により、既存の`CLOUDFLARE_API_TOKEN`だけを使って認証と保存ログAPIを再確認した。
証跡は`.local-test-data/results/20261017/sqlite-observability-auth-53a72b8e/`。token値・token ID・emailは保存・出力していない。
試験対象WorkerのHTTPやAlarmは起動せず、GETと対象Worker/元の2分間に絞った検索POSTだけを使用した。

| 確認 | 結果 |
| --- | --- |
| Account token verify | 200、active。対象accountの既存tokenは有効 |
| User token verify | 401、Invalid API Token。account所有token用ではない確認先だった |
| 同account・対象Workerのsettings GET | 200。account/Workerの取り違えやBearerの付け忘れでは説明できない |
| 保存ログのkeys POST | 403、10000 Authentication error。元の失敗を再現 |
| 保存ログのquery POST | `dry: true`のcount検索でも403、10000。キー検索だけの問題ではない |
| 自分自身のaccount token policy GET | 403、9109。付与済みpermissionとresource scopeは取得できない |

**有効なtokenだが、保存ログAPIへの認可が通っていないことまでは確定した。**
専用のObservability権限不足、またはそのresource scopeが対象に適用されていないことが第一候補。
ただしpolicy GETも拒否されたため、実際にどのpermissionが欠けているかは未確定であり、空のpolicyを確認したわけではない。

公式のkeys/query APIリファレンスは、受け付ける旧permission名を`Workers Observability Write`と記載している。
一方、2026-09-15更新のWorkers権限案内では、ログ・trace・metricsの閲覧は**Metadata Read-Only**で可能と説明されている。
旧Workers Scripts/Tail権限によるsettings取得・リアルタイムtailの成功だけでは、保存ログ検索の認可もあると判断できない。
この記載差を無視し、最初からEditor/Adminや広いWrite権限の追加を要求しない。

Account所有token自体は、公式の互換表でWorkers Observabilityに対応している。
User token verifyの401だけを見てtoken無効と判定したり、user tokenへ切り替えれば必ず直ると判断したりしない。
Workers LogsはFreeでも提供され、現在の文書上Freeの保持期間は3日。元の試験は期間内だが、403のため保存件数・日次上限・実際のCPU fieldは検索できていない。
保持切れやログ0件を確認した結果ではなく、再試験やPaid化を先に行う理由にもならない。

権限追加前に整理した対応順序は次のとおり。後述のとおり、管理者が既存tokenへReadを追加したことで検索は可能になった。

1. 管理者がDashboardの**Manage account → Account API tokens**で、使用中tokenのWorkers/Observability権限と対象scopeを確認する。
   token文字列をチャットへ貼る必要はない。調査目的だけでAccount API Tokens Read等の管理権限を追加しない。
2. 必要なら、対象Workerに限定した**Metadata Read-Only**のログ閲覧用tokenを別途用意し、同じ既存ログのkeys/queryを再確認する。
   これは権限変更・token発行の提案であり、今回実施していない。
   正しくscopeしたRead-Onlyでも拒否される場合は、APIリファレンスとの不一致を調べ、広い権限へ自動昇格させない。
3. 検索できたら、元の時間帯にHTTP/DO/Alarm・jobログと数値CPUがあるかを調べ、元の欠測を回収できるか判定する。
   新たな公開や配備を先に再実行しない。

認証調査scriptのTypeScriptチェックは成功。Cloudflareの権限・設定・資源・契約は変更していない。

### Workers Observability Read追加後の確認

管理者が既存tokenへ**Workers Observability Read**を追加し、再確認を指示した。
証跡は`.local-test-data/results/20261017/sqlite-observability-auth-d5c2175d/`。
同じ対象WorkerのUTC 2026-10-16 22:05:00〜22:07:00だけを検索し、keys・count query・CPU queryのすべてが**200 / success**になった。
したがって今回の認証条件ではWrite権限の追加は不要だった。APIリファレンスの旧Write表記を実機の必須条件とは扱わない。
private診断summaryの`required_permission`はその旧表記であり、後続の`read-permission-interpretation.json`で意味を明示した。
今後のscript出力では`legacy_api_reference_permission`へ名前を改めた。元の証跡は上書きしていない。

CPU確認は、同じservice/versionと数値`$workers.cpuTimeMs`の存在で絞り、eventType・entrypoint・durableObjectId別に集計した。

| 保存ログのDO invocation分類 | CPU付き集計件数 | CPU最大 |
| --- | ---: | ---: |
| DO fetch / SqlitePublicationService | 36 | 37ms |
| DO alarm / SqlitePublicationService | 4 | 7ms |
| DO jsrpc / SqlitePublicationService | 4 | 1ms |

このqueryはDO identityを持つgroupの確認であり、外側HTTPの全件数や全probeの照合ではない。
またAlarmのCPUだけを公開ジョブ全体のCPUとは扱わない。RPC等の集計件数は先のGraphQL集計と同一ではなく、完全なcoverageや恒久的Issue #13解消・Free適合を宣言する根拠にはしない。
フィールド一覧では外側HTTP用のprobe headerとCPU fieldも確認できたが、元の19 probe/job identityとの全件照合は今回実施していない。

自分自身のtoken policy GETは引き続き403だったが、保存ログの読み取りは成功している。
保存ログを読むためにAccount API Tokens Read等のtoken管理権限を追加する必要はない。
検索はすべて`dry: true`。agentは権限・設定・資源を変更せず、公開・resume・配備・Alarmを再実行していない。
次は再試験ではなく、取得可能になった既存保存ログのprobe/job/CPU照合を進められる。

### 元の公開HTTP 19件の保存ログ照合

管理者の再確認指示により、UTC 2026-10-17 01:27に元の試験時間帯を保存ログAPIで検索した。
証跡は`.local-test-data/results/20261017/sqlite-probe-reconciliation-d2093e24/`の`sanitized-events.json`と`reconciled-summary.json`。
同じservice/version、数値CPUとprobe headerの存在で絞った検索が200 / successとなり、19件のイベントを取得した。

元の19個のprobe UUID、Worker/version、stateless fetch・既定entrypoint、method、status、日時、独立したevent IDを照合し、**19/19件を確認した**。
既にtailで取得できていた15件のCPU値も、保存ログと**15/15件一致**した。
URLから元のpathを独立に一致確認できたのはfeedの7件。音源12件はallowlistに一致するpathを抽出できなかったが、
元の一意なprobe header等による照合を行い、未知のURL・本文・認証headerを証跡へ保存していない。
最初の厳格path照合で7/19となった中間summaryは残し、同じ取得済みイベントをオフラインで照合した最終結果を別ファイルへ保存した。
追加API呼出や新しいHTTP要求のCPUで穴埋めしていない。

| 元のtailで未取得だった公開HTTP | status | 保存ログCPU |
| --- | ---: | ---: |
| 最後の音源Range GET | 206 | 1ms |
| 同じ音源のETag条件付きGET | 304 | 1ms |
| 既存36件Showのfeed再確認 | 200 | 1ms |
| pause後の新RSS feed | 503 | 0ms |

この19件の公開HTTP probeではCPU最大**1ms**、中央値**0ms**だった。
0msはCloudflareが返した数値であり、未取得を0へ置換した値でも、処理量が厳密にゼロという意味でもない。
元のtailで報告した「外側HTTP全54件の最大2ms」は、管理HTTP等を含む別の母集団であり矛盾しない。

したがって、**公開HTTPの欠測4件は保存ログで回収済み**。ただし「時間を置けば必ずtailが回収できる」ことの証明ではなく、
今回の再確認ではRead権限追加後の保存ログ検索を使った。元のtail欠測の原因・保存完了時刻は確定していない。
job/Alarmの完全なCPU対応付けや全HTTPのFree適合は別の確認であり、元の`measurement: incomplete`を上書きしていない。
公開・resume・配備・activation・Alarm・サービス設定変更は行っていない。
診断scriptの型検査と、認証header・query文字列・本文を保存しないsanitizerのローカル検査は成功した。

### FreeのCPU制限に対する判定

管理者の再確認指示により、2026-10-17時点の公式Workers/DO制限と、元の試験時間帯のCPU集計を照合した。
追加検索の証跡は`.local-test-data/results/20261017/sqlite-free-cpu-audit-fd774ef9/`。
同じservice/versionと数値CPUに限定した、execution model/event type別とnamed entrypoint/event type別の読み取り検索だけを行った。

**Workers Freeの通常HTTP実行は10msだが、SQLite DOのHTTP/RPC/Alarmは既定30秒の別枠である。**
DOはFreeでも利用できるため、「無料枠で動作する」ことと「DOを含むすべての実行を一律10msへ収める」ことは同じ要件ではない。

| 実行区分 | 観測済みCPU最大 | FreeのCPU制限に対する判断 |
| --- | ---: | --- |
| 公開配信HTTPの19 probe | 1ms | 19/19件照合済み、10ms以下 |
| 外側HTTP（管理要求を含むtail採取範囲） | 2ms | 観測範囲は10ms以下 |
| SqliteCachedAssets HTTP / RPC | 2ms / 1ms | 観測範囲は10ms以下 |
| SqlitePublicationService DO HTTP / RPC | 37ms / 1ms | 10ms対象ではなく、既定30秒以下 |
| 同DO Alarm | 7ms | 10ms対象ではなく、既定30秒以下 |

今回の追加保存ログ集計でもstateless fetch最大2ms、SqliteCachedAssets fetch最大2ms・RPC最大1msだった。
ただしgroupingの件数はtail・probe検索・GraphQLと一致せず、すべてのinvocationを回収した証明にはしない。
通常Workerの観測済み10ms超過はないが、管理HTTP・内部呼出を含む全invocationの取りこぼし確認と、
初期化・互換更新・各ライフサイクル・大容量等の未評価経路まで含むCPU網羅性は未完了である。
過去の別versionの正常結果や19件の公開probeだけを、最新versionの全操作の証明へ拡大しない。

不足として整理すべきなのは**対象となる各実行のCPU測定範囲**であり、公開ジョブ単位のCPU合算や完全なjob対応付けをFree CPU判定の必須条件にはしない。
DOも含め一律10msという別の性能目標なら37msは未達だが、無料枠のCPU制限違反を示す値ではない。
この読み取り調査では公開・配備・設定・プラン・CPU limitを変更していない。

## 4. 次回の測定方式

1. ログ採取・保存を事前に有効にし、試験中は個々のログ到着を待たず試験を実行する。
   開始前のDOログ受信を必須のgateにはせず、保存ログを試験後に検索・集計する方式を優先する。
2. 終了後、配送・保存の遅延を考慮し、必要なprobe ID・job開始/完了・Alarm CPUのcoverageを有限時間で確認する。
   期限切れはmeasurement incompleteとし、公開要求を再実行しない。
   tailを併用する場合は試験前から接続して保存し、固定2秒ではなくcoverage/期限で終了する。試験後の接続で過去のtailを取得できるとは扱わない。
3. 採取のhealth、保存の完全性、要求単位のcoverageを引き続き分離する。
   jobログが同時DO HTTPに付いた場合、そのCPUをAlarm全体のCPUにはしない。
4. 既存tail再利用か新規有効化か、最初のDO到着時刻、要求応答からログ到着までの時間を残す。
   事前GETの確認を補助診断として行っても、その成功だけで以後のAlarmログ配送まで保証しない。

今回は調査と結果の記録のみ。アプリや共通runnerの変更・commit/push、agentによる権限追加、公開再試験は行っていない。
サービスはready/paused/drained、active=null/queued=0のまま。追加観測のrunner/supervisorは終了し、通知もacknowledgedになった。

## 参照

- [Durable Objects known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)
- [Workers real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
- [Wrangler tail作成実装](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/tail/createTail.ts)
- [Wrangler tail filter実装](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/tail/filters.ts)
- [Telemetry keys API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/keys/)
- [Telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)
- [Account API tokensと互換表](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Workers Logsと保持期間](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [Durable Objects CPU limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sqlite-backed-durable-objects-general-limits)
