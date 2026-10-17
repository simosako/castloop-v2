# publication停止の診断と未知の実行tokenの保全

Issue #13のShow公開と、別環境で報告された断続的なEpisode公開停止を扱う。
最初の再調査では別環境のEpisode停止時ログが未取得だった。後続の隔離試験ではcommit時の503と
runtime resource failureを確認したが、Issue #13の全停止事例の原因は確定していない。
本書はソースで確認した問題、修正、観測方法を区別する。

## 重要な訂正: DLQを根拠にした解放は無効

前回の`ae6f2ed`で追加した「一致するDLQ markerで全実行の終了を証明できる」という判断は誤りだった。
[Cloudflare Queuesはat-least-once配送](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)であり、
markerは同じcommitの古い失敗や重複通知でも残り得る。実行tokenやservice invocationとの対応、
現在のconsumer・未完了I/Oの終了を証明しない。concurrency 1や単一残留tokenでも、この問題は解消しない。

- `releaseAbandonedPublication`と、任意の残留`m6_consumer`を返却するhelperを撤去した。
- 管理APIの`release`はservice invocation取得・R2書込・再送より前に409
  `publication_execution_unsettled`で拒否する。
- `release-job`／`publication-release`も解放POSTを送らず停止する。従来のjournal/schemaは読めるが、
  新しい`release_requested`／`released`記録は作らず、未知の過去POSTを再送しない。
- 前回版の解放コマンドは使用しない。DLQ・経過時間・HEAD不在・platformのcanceled表示だけで
  ownerやregistryを編集しない。CASは所有権保護であり、未知の旧I/Oが終了した証明の代わりにはならない。

万能な外部復旧は追加しない。[既存の安全方針](./m6_review_queue.md)に戻し、未知の実行は保全する。
U1は[未検証仮定](./m6_upload_recovery_options.md)のままで、今回解決したものではない。

## Issue #13の保存済みShow証跡

`a8c7e54`の新規serviceで初回Queue invocationがwall 34,982ms / CPU 146msで`canceled`になり、
Show実行tokenとservice invocationが残った。再試行2・3はbusyで拒否され、DLQに到達した。
statusは`processing / validating`、progressは`feed`で、公開先metadata/cover/feedは未作成だった。

証跡branch `test-evidence/show-publication-canceled-20261012`のexportには、feed進捗PUTの後に
凍結request GETの未完了spanがある。これは最初のmetadata書込前のguard付近で止まったことと整合するが、
spanの欠落・終了記録だけでruntime取消の引き金を特定できない。
前回報告の「142回のR2操作」は関連trace記録数と混同しており、R2呼出回数の確定値として使わない。
CPU/wallの値だけでCPU制限超過を排除せず、platform outcomeと例外も照合する。

## Episodeで停止し得る経路

`consumeOwnedPublication`は凍結commit/owner照合後にexecution tokenをCAS取得する。
Episodeは実行専用envとeffectsを用意して、次の処理を順にawaitする。

| 区間 | 主な処理／ログphase |
| --- | --- |
| 受付・実行準備 | `invocation_acquire`、`frozen_commit`、`owner_check`、`execution_acquire`、`execution_context`、`effects` |
| 検証 | `runner_control`、`runner_manifest`、`journal_read`、`verify_staging`、`snapshots`、`unique_guid` |
| `progress: feed` | 音源HEAD/GET/PUT/検証、feed入力、history/current/feed保存、`catalog_advance`、`feed_generation_write` |
| `purge`／`visibility` | delivery gate、cache purge、lifecycle CAS |
| `finished` | `status_write.published`、`owner_release`、`invocation_release` |
| 例外後処理 | `failure_record`、`execution_cleanup`、`invocation_release` |

phaseには`publication.`接頭辞が付く。guardは`guard_owner`／`guard_delivery`／`guard_recheck`へ分けて記録する。
`progress: feed`は音源コピー以外も含み、status/progressの保存時刻にはずれがある。
音源PUT待ち、後続のカタログ/世代保存待ち、完了解放待ちを進捗だけで区別できない。

正常経路に未awaitの公開書込や無限再試行は見つからなかった。ただしruntime取消でcatch/finallyに
到達しない場合や、その後処理のR2 GET/CASが継続失敗する場合はtokenが残る。
acquire CASの応答喪失も、取得していないと推定して解除してはいけない。
`published`になっていてもShow ownerとservice invocationの返却を別々に確認する。

## ソースで確認して修正した問題

1. **未消費の音源本文**: staging GET後のversion/size不一致、owner再照合失敗、本文未消費のPUT拒否で、
   元実装はbodyを閉じなかった。PUTのPromiseがsettleした後、未lockのbodyをfinallyでcancelし、完了をawaitする。
   PUTが保留中のままcancel/解放しない。本文は全量buffer化せず、checksum・サイズ検証・immutable CASを維持する。
   小さいsnapshotのETag/size不一致でも破棄本文をcancelする。
2. **並列journal/terminal読取のfail-fast**: 元の`Promise.all`は片方のGET例外で、もう片方の開始済みGETや
   未読本文を残してconsumer後処理へ進めた。両方のGETと本文読取を`Promise.allSettled`で待ち、
   その後に例外とschema/identityを検査する。巨大な破棄recordの本文もcancelする。
3. **観測不足**: 以前は終了時ログのみで、保留・強制終了した内部phaseが見えなかった。
   固定phaseの開始ログと対応する終了ログを追加した。catalog/世代保存、実行取得、通常解放、例外後処理も独立計測する。

これらは具体的な不備の修正であり、別環境の実機Freezeの直接原因や解消を証明するものではない。

## ログと読み取り診断

ログはWorkers Logsへ出し、R2に追跡recordを増やさない。

- `worker_phase_started`: `job_id`、固定`phase`、`timing_id`、`started_at`。
- `worker_timing`: 同じ`timing_id`とphase、`outcome`、開始/終了時刻、`duration_ms`。
- `publication_execution_blocked`: 残留tokenでconsumerを拒否したこと。
  `reason_code: retained_execution_token`、`authorizes_recovery: false`。
- `publication_delivery`: 配送attemptsと時刻。繰り返し配信をrequestId/traceIdごとに区別する。

`timing_id`は診断用UUIDで、実行tokenではない。本文・タイトル・メール・秘密・実行/registry token・
任意例外本文を構造化ログに含めない。入れ子phaseの時間は重複するため加算しない。
開始だけのphaseは保留/取消の候補だが、sampling・log失敗・保持期限による終了ログ欠落もあり、解放許可にはしない。

### 別環境で採取する情報

1. CLI/Workerのcommitと配備version、job ID、Show/Episode ID、受付・停止のUTC時刻を固定する。
2. `castloop operation-status publication JOB_UUID`と`castloop service-status`で
   state/phase、progress、ownership、execution_active、dead_letter_present、registry残存を読み取り確認する。
   activeは記録上の所有権であり、生存証明ではない。照会失敗も保存する。
3. 同じjobの全attemptのWorkers Logsを取得する。requestId/traceId、platform outcome/例外、CPU/wallと
   開始/終了の`timing_id`を対応付け、最も内側の終了していないphaseを調べる。
4. retryingでexecutionなしの停止と、execution残留を区別する。前者でもDLQはstatusをfailedへ自動変更しない。
   RSS待機はheld＋DLQ履歴を検知すると停止するが、古い履歴の可能性も表示し、解放を案内しない。
5. `.castloop/`、凍結commit/request、owner、registry、stagingを保持する。手動編集・別jobへの置換・再init・
   強制解放・再配備で未知I/Oを隠さない。通常更新も既存のpause/drain・owner確認を迂回しない。

executionなしの同job retryは既存の厳密なowner/manifest/marker検査を維持する。未知応答や残留tokenを
この診断から昇格させて再送しない。実環境の操作・ログ設定変更は今回実施していない。

## ローカル検証と限界

### commit管理HTTPのCPU削減（2026-10-14）

隔離試験の34件目がcommit時に503で停止した。同時刻・同Worker/versionのGraphQLは
`exceededResources` 1 request / 1 error、CPU 51.298 ms、wall 4.925239秒を示した。
CPU制限超過が有力だが、集計にはjob IDがなく、個別`exceededCpu`や適用CPU上限を取得していない。
`standard`設定や明示limitsの不在からPaid/Free・実効上限を推定しない。
ownerはreserved、commit marker未確認、service invocationが残る。これは未知I/O終了や解放の証明ではない。

承認された順序に従い、不変データの要求内再利用と再parse削減を実装した。

- 最初の厳密検証から凍結control request・publication manifest・予約identity・hashの証明を作り、
  reservedかつexecution未取得のcommit callback内だけで再利用する。callback終了・例外で失効し、
  bucket/targetの変更・入れ子・別要求への持ち越しを拒否する。module全体の可変cacheは作らない。
- Show controlのowner/action/対象/generation/hash/reservation identity/reserved・execution不在、
  Show/Episode lifecycle、staging proofとpayload HEADのversion/ETag/size確認は元の境界に残す。
  processing等からの既存marker照合は従来経路を使用する。markerの条件付きPUTと応答喪失照合も維持する。
- staging JSONを公開の厳密検証factoryで一度parseし、その検証済み値からcontrol request、
  canonical JSON、payload keyを導出する。既存公開helperの入力検証を取り除かず、hashの形式も変えない。
- 通常の新規commitでは凍結control/manifest/予約GETがそれぞれ5→1回、初回Episodeのstaging parseが
  10→2回になる。Show owner確認5回・Episode lifecycle確認6回・HEAD回数は変わらない。

`scripts/test-support/benchmark-publication-commit.ts`は正式管理handlerをmock R2で測る。
旧版`7f89878`と修正版を別Bunプロセスで交互に5回、各modeをwarmup 30回＋200回測定した。
各回のprocess CPU平均の中央値は次の通り（Bun 1.4.2、同じ予約identityありのfixture）。

| commit種別 | 旧版 CPU ms/回 | 修正版 CPU ms/回 | 削減 |
| --- | ---: | ---: | ---: |
| Show | 3.763 | 2.472 | 34.3% |
| 初回Episode | 4.491 | 2.998 | 33.3% |
| metadata-only | 3.456 | 2.189 | 36.6% |
| audio-only | 3.295 | 2.004 | 39.2% |

これはローカルBun/mockのCPUで、Workers CPUや実ネットワークの公開時間ではない。
証跡はGit対象外の`.local-test-data/results/20261014/commit-cpu-e964763e/local/`に保持する。
実機比較は新しい小容量serviceを版ごとに用意し、独立tmuxで逐次実行する。既存の残留token環境は
再配備・再送・解除しない。通常規模試験・有料設定変更・資源削除はこの比較に含めない。
③隣接する重複guardの整理はまだ実装せず、実機結果を見て必要性を判断する。
回帰検証は1044 pass / 0 fail（116 files）、TypeScript検査と単一CLI/内蔵Worker buildが成功した。
対象変更・owner/世代/lifecycle差し替え・HEAD version/size差し替え・期限外scope・不正初期record・
条件付きPUT応答喪失・保留中PUTを検証した。CPU削減は未知の停止jobの復旧を可能にするものではない。

#### 小容量の実機比較結果

Git対象外の`commit-cpu-e964763e`試験は独立tmuxで実行し、2026-10-14（JST）に終了した。
修正版service `i13-bc656f35`はShow＋初回Episode 3件＋metadata-only＋audio-onlyの6公開に成功した。
feed・音源GET/HEAD/Range/SHA-256、完了済み取り込みの再実行、owner/registryの返却も確認した。
旧版service `i13-d46cf12e`は4回のcommitに成功したが、3件目Episodeの状態照会失敗で試験を停止した。

両版で取得できた同じ対象のcommit invocationのLive tail CPU（整数ms）とphase wallを比較した。
各1回の逐次試験で、広い規模や長期の性能保証ではない。

| 同じ対象のcommit | 旧版 CPU ms | 修正版 CPU ms | 旧版 wall ms | 修正版 wall ms |
| --- | ---: | ---: | ---: | ---: |
| Show | 44 | 18 | 5128 | 3599 |
| 初回Episode A | 51 | 21 | 5838 | 4285 |
| 初回Episode B | 38 | 21 | 5621 | 4076 |

修正版のmetadata-only CPUは27msだったが、旧版は更新試験前に止まったため実機比較はない。
初回Episode 1件とaudio-onlyの修正版commit phaseはtailで取得できていない。6 consumerの終了phaseは
揃っているが、それを全commitログの完全配送の証明としない。採取healthが正常でも欠落はあり得る。
GraphQLの秒単位window最大CPUにはRPC/Queueが混在するため、commit CPUとして流用しない。

旧版の最後のEpisodeはmarkerあり・execution token/owner保持・status/progressなし・DLQ markerあり、
serviceにはconsumer invocationが1件残った。GraphQLは公開commit直後のLAXで
`scriptThrewException`（CPU 70.678ms / wall 28.604秒）と、後続の例外1件を示す。
今回の分類は`exceededResources`ではなく、CPU制限超過と断定できない。tailは最初の例外invocation終了前に
停止しており、履歴telemetry queryは403で個別例外を取得できなかった。停止した状態照会のHTTP statusも
旧CLIの出力には残らない。GraphQLは時刻・versionによる照合で、job/traceとの直接結合ではない。
未作成statusから特定の関数や未知I/O終了を推定しない。

①②のcommit CPU削減は確認できたため、owner/HEAD確認を減らす③は今回は見送る。
consumer例外は未解決の別調査対象として保全し、Issue #13全体の解消とは宣言しない。
通常規模試験、既存停止環境の再配備、失敗jobの再送・解放、資源削除、Pushはこの比較では実施していない。
実機CPUの照合は`metrics/matched-commit-comparison.json`、集計・取得範囲は`metrics/`、
読み取り診断は`inspection/`、全試験の証跡は同じGit対象外directoryに保持する。

### 長時間試験のlive tail採取

2026-10-13の隔離試験では、製品のログ出力ではなく試験用採取コードに不備があった。
同じWorkerへのtail作成POSTが同じIDを返す場合があり、補助観測者の終了時DELETEが
本観測者と共有するtailを削除した。WebSocketはcloseせず、ログ配送だけが停止することを再現した。
そのため、切断イベントがないことや、取得分のoutcomeがokであることを全期間の正常性の証拠にしない。

- `scripts/test-support/worker-tail.ts`を試験用採取helperとして使用する。正式CLI/Workerには組み込まない。
- 観測者終了では自分のWebSocketだけを閉じる。tail作成receiptだけで排他的な所有権を推定せず、
  共有tailへのDELETEを自動実行しない。remote tailは既存の期限で失効する。
- 初期設定の送信、相関ping/pong、tail IDの一覧照合、期限、close/error、truncated/parse/保存失敗を確認する。
  healthログにはtail ID・期限・固定reason・close codeを残すが、WebSocket URLや任意close reason・HTTP headerは保存しない。
- 採取の異常はその試験の不完全な証跡として保持する。接続を戻しても過去の欠落を解消した扱いにしない。
  次の変更コマンドを開始しないが、すでに実行中の変更コマンドやconsumerをkillしない。
  逐次取り込みCLIを1コマンドで起動した場合は、そのコマンドのsettlementを待つ。helperは内部Episode境界へ介入しない。
- helperのhealth正常は輸送・保存確認の範囲であり、platformのsamplingや欠落がない完全配送の保証ではない。
  開始/終了phaseとjob件数を別途照合し、入れ子の時間は加算しない。
- heartbeatの期限判定は仮想timer、native control frame疎通は実pong受信で分けて試験する。
  10ms周期と固定sleepによるnative試験の時間依存性、遅延再現と検証範囲は
  [Issue #29の調査](worker_tail_heartbeat_tests.md)を参照。収集器の期限や欠測判定は緩和しない。
- 長時間試験そのものもOpenCodeのLocation寿命から独立した管理プロセスで起動する。
  これはログ採取の修正とは別の対策で、未知の既存owner/tokenを解放する根拠にはしない。

採取helperの12回帰テストと実Bun WebSocketのping/pong確認が成功。隔離Workerでも、同じIDの補助観測者を
WebSocket closeだけで終了した後に本観測者がログを受信し続けることを確認した。
この修正後の全自動テストは1033 pass / 0 fail（115 files）、TypeScript検査は成功した。

### 公開処理の回帰検証

- 音源PUT、catalog、feed世代、published status、Show解放、service解放をそれぞれ保留し、
  開始のみのphaseと適切な残存ownerを検証した。I/O完了後は通常のpublished/releasedへ進む。
- version不一致・owner照合例外・未消費PUT拒否でcancel完了を待ち、開始済みjournal/terminal GETと本文読取も待つ。
- 後処理のR2継続失敗ではtokenを保持し、後続consumerがbusyとして拒否されることを確認した。
- Show/初回Episode/metadata-only/audio-onlyと、古い一致DLQがある稼働中音源PUTでも、releaseはR2・
  journal・Queueを変更しない。CLI/RSS待機も解放・再送へ誘導しない。

mockはruntime強制取消、300MB実転送、Cloudflareの応答本文や制限の再現ではない。
既存の300MB受け入れを無効にせず、今回のストリーム修正を実機合格と呼ばない。

ローカル検証は`bun test` 1021 pass / 0 fail（114 files）、`npm run check`、
`npm run build:cli`のLinux単一CLI/内蔵Worker buildが成功した。Cloudflareへの配備・再送・token解除は未実施。
