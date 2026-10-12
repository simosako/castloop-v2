# M7 RSS逐次公開の所要時間分析・改善計画

2026-10-12。時間ログと公開consumerの不変記録再利用を実装し、別環境の追試でconsumerの約23%短縮を確認した。追加のカタログ方式とstaging finishの不変記録再利用も実装した。追加改修の実機性能は未測定で、Cloudflareの設定変更や追加の実機操作は行っていない。

管理者確認: 時間記録と計測用300秒待機に加え、カタログによる対象削減→staging finishの不変記録再利用→別環境での再測定という順序を承認済み。正式版の既定待機上限は未決定で、性能改善後の実測を見て判断する。

## 結論

標準CLIの120秒待機では、正常に完了する公開jobを確認しきれず停止した。300秒版で全36件が公開できたことは機能の確認になるが、標準CLIの受け入れ完了でも性能改善でもない。

コードと追加実測で確認した主要な改善対象は、**層をまたいだ安全確認の重複による直列R2 I/O**と、**各公開で繰り返すEpisode一覧の読み取り**。第1改修の不変記録再利用は実機で効果を確認できた。管理者の指摘を受け、並列数を増やす前に読み取り対象を減らす方針へ見直した。Showごとの公開Episode情報を1つのR2 objectにまとめ、変更対象だけを再検証する。RSS専用の公開エンジンや一括公開APIは作らない。

待機の実用性と処理速度は別問題として扱う。待機延長だけで調査を完了させず、速度のためにowner検証・全量readback・purge確認を外さない。

## 確認した証跡

- [Issue #10追記](https://github.com/simosako/castloop-v2/issues/10#issuecomment-6118624570)
- 証跡branch: `test-evidence/rss-import-retest-a19efb4-timeout300`
- 固定commit: `44566bd8f3bdb52398d6ca84b9978a2842642f97`
- 以下はそのcommitの `design/acceptance/rss-import/20261012-retest-a19efb4-timeout300/` 以下。
  - `standard-120s/result.md`
  - `timing-investigation/findings.md` / `timing-summary.json`

標準版は18件目と21件目で待機上限に到達。停止後の照会では当該jobが`published / released`だった。300秒版は同じimportの続きを完了した。Workerは`a19efb4`のままで、試験patchはCLIの公開待機上限とテスト期待値の変更だけだった。

6〜18件目の13jobについての時間は次のとおり。

| 区間 | 平均 | 最小〜最大 |
| --- | ---: | ---: |
| metadata staging開始記録→最終ローカル保存 | 29.3秒 | 28.2〜30.1秒 |
| audio staging開始記録→最終ローカル保存 | 33.5秒 | 31.6〜34.8秒 |
| publication要求作成→サーバーprogress finished | 94.5秒 | 82〜121秒 |
| commit応答保存→サーバーprogress finished | 85.4秒 | 72.6〜112.6秒 |

metadataは平均2,447 bytes、audioは平均約39.7 MB。次の公開要求まで156〜188秒かかっている。metadataの29秒は単純な転送量では説明しにくく、制御処理の固定的な負担が有力な調査対象になる。

これらはjournalの作成日時・mtimeとR2 progress時刻からの区間集計で、純粋なupload時間やWorker CPU時間ではない。progress finishedの後にもterminal status保存・Show owner解放・service invocation解放・CLI照会がある。18件目はcommit応答からfinishedまで約113秒で、残り約7秒にその処理が収まる必要があった。最終release時刻は未記録のため、どこで残りの時間を使ったかは断定できない。

## 改修前のコードから分かったこと（a19efb4時点）

### 1. 120秒はimport全体ではなく、各commit後の公開完了待ち

`packages/cli/src/rss-import-publication.ts:144-163`の`waitForJob`は、各公開receiptの後に開始する。metadata/audio stagingの時間はこの120秒には含まれない。

- `Date.now() + 120000`と最大120回の両方で制限している。
- 各回は状態照会を**awaitした後に**1秒sleepする。照会時間も予算に入るため、1秒間隔で120回照会できるわけではない。
- 終了条件は`published`かつ`released`。finished progressや`published / held`だけでは次へ進めない。この条件は正しい。
- `packages/cli/src/m6-admin-json.ts:82-88`のHTTP要求にも別の120秒timeoutがある。待機ループは進行中の照会を残り時間で打ち切らないため、厳密な120秒上限ではない。

今回のstderrは公開待機ループの上限到達を示すもので、uploadや管理POSTの120秒timeoutが起きた証拠ではない。

### 2. stagingにも多数の管理APIとR2操作がある

`packages/cli/src/staging-operation.ts:49-117`と`local-draft-operation.ts:42-79`では、1回のstagingに次の順序を通す。

`claim → status → begin → REST PUT・全量GET照合 → status → settle → status → finish`

これは管理APIだけで7往復あり、前段のtarget照会などは別途必要。metadataとaudioでそれぞれ実行する。各変更APIには`withM6ManagementInvocation`のservice登録・runtime/gate確認・登録解除もある。

さらに`src/staging-verification.ts`のfinish処理は、verification token、progress、status、payloadを確認・保存する際に`requireStageVerification` / `requireStageUpload`を繰り返す。音源自体はWorkerで全量hashせずHEADとCLI receiptを検証している（`verifyPayload:63-65`）。「WorkerでMP3 hashして遅い」という以前の問題ではない。

前後のstatusやtoken検証にはそれぞれ意味がある。7往復を一律に削除するのでなく、まず各APIの時間を測り、Worker内部で同じ検証を直列に繰り返している部分を整理する。

### 3. 公開guardの重複は具体的に存在する

`src/publication-episode-runner.ts:98-103`のguardは次を呼ぶ。

1. `requireShowExecution`
2. `requireOwnedPublication`
3. `effects.checkDeliveryGate`
4. `requireShowExecution`

しかし、2も`requireOwnedOperation`を呼び、3の実体（`src/lifecycle-worker-effects.ts:33-38`）も`requireShowExecution → delivery gate → requireShowExecution`を呼ぶ。

通常のM6 Showでreservationがある場合、静的にたどると次のGETが必要になる。

| 呼び出し | R2 GET数 |
| --- | ---: |
| `requireShowExecution` | 3（Show control・reservation・凍結control request） |
| `requireOwnedPublication`（公開結果へ進む前のEpisode） | 5（上記3・凍結publication request・Episode lifecycle） |
| effectsのguard | 8（Show execution確認3×2・service admission確認2） |
| runnerのguard合計 | **19** |

ここにcached entrypointのruntime RPCも加わる。公開後の再試行などではさらにprogress読み取りが増える。これはソースから数えた通常経路の呼び出し数で、実機traceの計測値ではない。

runnerは音源保存・revision/current metadata/feed書き込み・purge・visibilityの境界でguardを繰り返し、progress/status保存側も別途owner確認を行う。この積み重ねは、ファイルが小さくても時間がかかる構造を説明できる。ただし1回のR2 I/O所要時間が不明なので、85秒の何割に相当するかは未確定。

### 4. GUID検証とfeed生成が別々に全Episodeを読む

- `src/publication-episode-runner.ts:20-50`の`uniqueGuid`は全current metadataを逐次GETする。
- `src/lifecycle-feed.ts:93-`は一覧を取得し、Episodeごとのlifecycleと配信対象metadataを逐次GETする。
- 1件公開するたびに行うため、N件移行時の累積読み取りはおおむねO(N²)。36件でも同じcurrent metadataを繰り返し読む。

今回の時間は件数に対して単調増加していない。これだけが主因とはいえないが、増える件数に対する負担はコードで確認できる。

GUID検証は非公開Episodeのcurrent metadataも対象にしている。feedに載るactive Episodeだけの一覧へ置き換えると重複検証を弱めるため、単純な関数統合はしない。

### 5. 当初の証跡ではQueue・cache・ネットワークの内訳は未確定

`src/m6-routes.ts:151-175`は1messageずつconsumerを実行する。`src/lifecycle-cache.ts:126-135`はtag purgeとprefix purgeを順にawaitする。これらにも時間がかかる可能性はあるが、開始時刻や区間時間がなく寄与は分からない。

現行は1message batchなので「batchを貯める30秒待ちが原因」とは断定しない。[Queuesのbatch設定](https://developers.cloudflare.com/queues/configuration/batching-retries/)は確認したが、設定値と当時の配送所要時間は別である。retryの有無、R2同一キー書き込みの制限、Worker配置、DNSも今回の確定原因ではない。

履歴telemetry APIは403で調査が止まっている。追加権限やWorkers Paidを解決の前提にしない。

## 追加計測による優先順位の確定（2026-10-12）

[Issue #10の単一job計測](https://github.com/simosako/castloop-v2/issues/10#issuecomment-6119196173)と、branch `test-evidence/rss-local-timing-20261012` の固定commit `c1ba87c7521e706cbc4243f1eb86e73900fdcaaa`を確認した。証跡は `design/acceptance/rss-import/20261012-local-timing/evidence/` の `result.md`、`detailed-breakdown.json`。通常位置の計測source（`src/local-timing.ts`、`src/worker.ts`、runnerへの計測追加）も確認した。

公開済み36件のShowで同一metadataを1件再公開した測定であり、初回音源公開や120秒超過の再現試験ではない。このsampleでは以下が測定された。

| 対象 | 計測結果 |
| --- | ---: |
| consumer全体（service invocation解放まで） | 96.727秒 / R2操作484回 |
| runner guard | 26.949秒 / 8回 / R2操作152回 |
| feed入力読取・音源HEAD | 20.616秒 |
| progress/status保存と確認 | 16.831秒 |
| GUID重複検査 | 7.566秒 |
| Queue message timestamp→consumer開始 | 約0.940秒 / attempts=1 / retryなし |
| cache invalidate RPC単独 | 0.173秒 |
| staging finish | 14.270秒 / R2操作139回 |

consumerのGETは419回、平均約187ms。Show control 80回（14.500秒）、凍結request 79回（14.095秒）、Show予約77回（13.563秒）を読み直している。不変の後二者だけで約27.7秒。これらのrecord別集計はguard/progress等の区間集計と重なるため、時間を足し合わせない。

**このsampleでは、多数の直列R2往復が主要因と確認できた。** Queue配送やpurge設定を先に変更する根拠はない。管理WorkerのGET平均約90msに対しconsumerは約187msだったが、配置・距離・負荷の原因は未確定。まずアプリ側の重複操作を減らす。履歴telemetryの403解決や追加の広範な計測を改修開始の前提にしない。

単一jobの追加計測時に整理した改修対象は次のとおり。第2改修の方法は下記P3で見直した。

1. **公開consumerの共通所有権検証**: 凍結request・予約のinvocation内再利用、runner/effects/writerの重複確認整理。全件走査より先に着手する。
2. **GUID/feedの全件読み取り**: 合計約28.2秒の区間を対象にする。並列化を先行する案から、対象削減を優先する案へ変更した。
3. **staging finish**: 139操作の重複確認を整理する。1と同じ不変記録・可変所有権の分離方針を使うが、stagingのverificationに合わせ、別の変更・比較単位とする。

最初の変更で97秒を何秒へ短縮できるかはまだ保証しない。request・予約の約27.7秒は削減候補の規模を示すもので、全部削除できる時間でも、guard整理とは別に加算できる短縮量でもない。

計測branchは診断専用で、性能改善は含まない。そのままmerge/deployしない。認証付き応答headerに全traceを載せる方式や詳細traceのR2保存、全キーを集めるProxyを正式版へそのまま持ち込まず、必要な区間・固定名・件数に絞ったログとtest fixtureの操作数比較を採用する。今後の並列読み取りでは、共有の「現在の親span」だけで同時実行を追跡すると親子関係が混ざり得るため、計測結果の重複除外にも注意する。

## 改善の順序

### P1. 小さな区間計測と、CLI待機の実用性改善

追加計測で原因の優先順位は付いたため、以下は性能改修の前後比較に必要な範囲で行う。新たな大規模計測の完了待ちにはしない。

- CLIはstagingの管理API・PUT・readback、公開状態照会の回数/合計時間、job待機時間を短い構造化ログで記録する。
- Workerはcommit保存、consumer開始、検証、音源保存、feed入力/出力、purge、terminal status保存、Show owner解放、service invocation解放を区別して時間を記録する。job IDと固定phase名・時間・件数のみを使い、タイトル、本文、URL query、管理鍵、execution token、任意例外を出さない。
- 既存のR2 test fixtureでGET/HEAD/PUT/LIST数を数える。計測のために新しいDB、永続journal phase、汎用trace基盤は作らない。
- 計測中はRSSの公開待機上限を一時的に300秒へ延長する。正式版の既定値としては確定しない。単一の経過時間上限で管理し、時計は単調増加するものを使い、読み取り要求も残り時間と既存の要求上限で制限する。
- この変更は**既知jobの読み取り待ちだけ**。変更POST/PUTのtimeout、再送条件、owner解放条件には適用しない。期限切れはwaiting cursorを維持し、job ID・確認済みstate/ownership・続行コマンドを示す。正常pendingと公開失敗を区別する。

時間記録機能は今回の試験だけでなく、今後の性能調査にも使える形で残す。300秒は計測を進めるための一時的な上限であり、Cloudflareが300秒以内に完了する保証ではない。延長は性能改善の成果には数えない。性能改善後に公開完了・所有権解放・CLI確認までの実測とばらつきを報告し、管理者が正式版の既定値を判断する。

### P2. 重複確認を同じ責務の層へまとめる（優先する性能改修）

最初の性能改修は公開consumerを対象とする。`src/lifecycle-control.ts`の`requireOwnedOperation` / `requireShowExecution`を起点に、`publication-admission.ts`、runner/effects、`lifecycle-job-store.ts`の同じ検証の繰り返しを整理する。全Lifecycle操作への一括置換はしない。

最初に、初期検証で取得した凍結control request・そのhash・完成済みreservationを、同じservice/Show/job/generation/executionに束縛した小さな検証済みcontextとして渡す。不変である根拠は、requestの`freezeRequest`がR2 bindingの作成限定PUTと既存hash照合を使い、完成後の予約identityを通常操作・削除でも保持する契約にある。R2 REST PUT一般が不変という意味ではない。再利用を導入する箇所では、その記録を変更する正式経路がないことも確認する。

contextは同じinvocationだけで使い、次のQueue配送や別の管理HTTP要求では再取得する。違うjob/generation/reservationには使えない。現在のShow controlは各安全境界で読み直し、凍結requestのhashと対象、ownerのkind/action/generation、execution token、reservation identityが一致することを確認する。可変controlをjob開始時の値だけで判断する方式にはしない。

この分離を土台に、runner/effectsの同じ境界でのowner確認を重複させない。contextを巨大な汎用状態機械や無条件のR2 read cacheにはしない。

- 公開runner/effectsそれぞれが同じowner・runtimeを完全検証し直す構造をやめ、1つの境界の確認責務を明確にする。
- 同一invocation内で検証した凍結request・reservation等は、同じowner/generationに結び付けて再利用できるか検討する。無条件のglobal cacheやinvocationをまたぐcacheにはしない。
- 可変のShow/Episode/service control、execution/verification token、base revisionは必要な境界で再取得する。長いaudio I/O、purge、状態遷移の後の再確認は残す。
- progress/status writerの凍結identity検証と現在owner確認を分け、上位と下位で同じ凍結ファイルを読み直す部分を減らす。durable terminal記録とCASは維持する。
- API往復の削減はサーバー側に同じ条件を移せることが証明できた箇所だけ。CLI journalが表す未知要求の境界をまとめたり、変更コマンドを自動retryしたりしない。

「確認を1回にする」はjob開始時の1回だけにする意味ではない。**各安全境界で、1つの責務を1つの層が確認する**という意味である。共通の通常公開も改善し、RSSだけ安全条件を飛ばす分岐は作らない。

### P3. 全件の再取得ではなく、変更対象を検証する（承認・実装済み）

第1改修後もfeed入力21.400秒＋GUID検査7.617秒が残る。最大4件の並列読み取りでは待ち時間は重なるが、200件になったときの読み取り件数や、逐次importの累積O(N²)のR2往復は減らない。並列化だけを先行する案は推奨から外す。

#### 必要な処理と過剰な再確認

- **GUID**: 新規EpisodeではShow内の重複検査が必要。既存Episodeの更新は、既に`sameEpisodeIdentity`で元GUID・permalink属性・公開日時の変更を拒否している。初回公開で一意性を確認済みのEpisodeなら、更新のたびに他の全metadataを読む必要はない。元revisionとcurrentの整合確認は残す。
- **音源**: 新音源と変更対象が再利用する音源の検証は必要。一方、通常更新で無関係な全Episodeの音源をHEADするのは、変更対象の検証ではなく全体の整合性確認になっている。正常な公開で検証済みのimmutable音源を、同じShowの排他制御と削除操作への接続を根拠に再利用できるようにする。
- **RSS**: 全Episodeを載せるため全件分の情報は必要だが、毎回その情報を個別objectから取得する必要はない。R2往復を減らすことと、RSSの項目数を減らすことは別で、件数の切り捨てや古いEpisodeの非表示はしない。

#### 推奨: Showごとに1つのEpisodeカタログ

private R2バケットに、公開済みEpisodeのcurrent revision情報とfeed掲載状態をまとめた1つのobjectを置く。現行の`EpisodeRevision`とRSS rendererを再利用し、新しいDB・Queue・GUID専用index・XML差分編集器は作らない。保存keyとschemaは下記の実装状況に記載する。

通常のEpisode公開は次の順序にする。

1. 現在のShow ownerとカタログの更新世代を確認し、カタログを取得する。
2. 変更するEpisodeのmetadata、元revision、lifecycle、音源を検証する。
3. 初回公開ならカタログ内でGUID重複を確認する。更新なら元GUIDとの一致を確認する。公開停止中のEpisodeもGUID照合に含める。
4. カタログの対象1件だけを追加・更新し、配信対象の項目から既存rendererでRSS全体を生成する。
5. owner/token確認とETag条件付き保存によりcurrent metadata・カタログ・feedを反映する。既存のpurge確認、世代更新、完了記録、所有権解放を維持する。

通常更新では、他のEpisodeのmetadata/lifecycle GETと音源HEADをなくす。カタログを読む量とXML生成量はO(N)のままだが、Episode情報を集めるためのR2要求数は件数に比例しなくなる。200件でも「200個のmetadataをGET」ではなく「200件分を含むカタログをGET」とする。GUID検証・feed生成・世代更新の境界ではカタログを再取得し、対象・owner・status等の固定的な操作も残る。

#### 成立条件と変更範囲

- カタログはTTL cacheではなく、正式操作が更新する公開情報の派生snapshotとする。個別metadata/revisionとlifecycle controlは引き続き保持し、管理操作の許可判定をカタログだけで行わない。
- `feed_generation`、`last_feed_job_id`、カタログを反映したjobのidentityを照合する。現在の所有権は都度確認し、別jobが残した未完了カタログを公開済みとして使わない。
- R2の複数objectの保存は1つのトランザクションではない。途中失敗・保存応答喪失では、既存job/progressとカタログのjob identityから同じ変更へ冪等に収束できることが必須。世代不一致を無視した使用や、未知要求の再送・owner強制解除はしない。
- Episodeの公開停止ではfeedから外すが、GUID照合用の情報は保持する。復元では元snapshotを再掲載する。削除では対象entryの本文・GUID等をカタログから除き、Show削除ではカタログ自体をpayloadとして削除する。永続保持する運用記録へ本文を移さない。
- Episode公開だけの局所cacheにはしない。Show公開、公開停止/復元/削除、独自ドメイン切替のfeed経路も接続または明示的に失効させる。Show設定とcanonical URLは生成時の設定を使い、古いURLを固定しない。
- 新規Showは空のカタログから始める。既存M6 Showは、所有権・既存操作の終了が確認できる初回構築時に一度だけ全件を読む。既存のカタログが壊れている場合や別jobの部分更新がある場合は、欠落扱いで自動再構築せず停止する。旧形式serviceの変換は追加しない。
- 件数・object byte・renderingの上限は維持する。200件のfixtureで要求数とメモリ/サイズ制限を確認し、Workers FreeでのCPU時間も実機で確認する。R2往復の削減だけで全処理をO(1)と呼ばない。

既存更新時のGUID再走査だけを省く変更では通常feed入力の全件GETが残るため、カタログの世代・削除・再試行への接続と合わせて実装した。

#### 比較した代替案

| 案 | 制限・採否 |
| --- | --- |
| 最大4件の並列読み取り | 往復数はO(N)のまま。初回構築等の補助には使えるが、通常更新の主対策にしない |
| 同じinvocation内のmetadata共有 | 二重GETは減るが、全件のlifecycle GET・音源HEADは残る。根本対策にはならない |
| 既存feed.xmlの対象itemだけ置換 | R2読取を減らせるが、非公開EpisodeのGUIDを照合できず、別の索引とXML解析/差分編集が必要。既存の構造化metadataとrendererを使う方が責務をまとめやすい |
| GUID専用indexだけ追加 | 新規GUID検査は改善するが、feed生成の全件取得が残る。カタログと別の更新対象を増やさない |
| 最新一定件数だけRSSへ掲載 | 過去Episodeの配信仕様が変わるため、性能対策として採用しない |

### P3b. staging finishの重複確認を整理

第3改修は`src/staging-verification.ts`と`src/staging-upload.ts`を対象にする。finishの同一HTTP invocation内で検証済みの凍結upload manifest/request/予約を再利用し、`requireStageVerification`からの重複再読取を減らす。前のHTTP要求の確認結果やCLI receiptだけを根拠に現在ownerを省略しない。verification token、client settlement、progress/statusのCAS、payload ETag/version/size、完成記録を検証してから所有権を解放する順序は維持する。CLI全量readbackとhashは今回の負担の主因ではなく、削除対象にしない。

### P4. 小規模実機比較と標準buildでの受け入れ

- 最初の改修は、今回と同じ36件Showのmetadata-only 1件更新で比較する。consumer操作数、凍結request/予約のGET数、guard/progress/statusの時間、公開応答からpublished/released確認までを比較する。その後に音源付き公開でも安全条件と待機を確認する。実機更新は管理者の承認範囲で行う。
- CLIとWorkerのcommitを記録し、同じ待機上限でphase時間・R2操作数・全時間を比較する。改修単位ごとに比較し、3つの改修をまとめてから初めて測る進め方にはしない。
- P1で分かった主因がQueue待ちやpurgeなら、該当区間に限定して調べる。推測でCloudflare設定を変更しない。権限変更等が必要な場合だけ管理者へ確認する。
- 性能改善後の実測をもとに正式版の既定待機上限を管理者へ提案する。計測用300秒をそのまま正式な既定値として扱わない。
- 無改変の標準buildでRSS公開を完了できることを確認する。完了済みimportの再実行だけでは公開待機の改善を検証できないため、承認された未完了の試験対象または新規Showを使う。
- GUID・日時・非公開Episodeの重複GUID拒否、feed・media一致、published/released後だけ次へ進むこと、完了後の再実行で重複公開しないことを確認する。
- 既存のowner変更・token不一致・未終了IO・purge失敗・応答喪失テストを再利用する。追加テストは待機期限と改修した確認境界に限定する。
- `bun test`、`npm run check`、Linux単一バイナリbuildを通す。300 MB再試験や新しい全故障マトリクスは追加しない。

性能の合格は「timeoutしなくなった」だけではない。変更した正常経路の重複R2操作数が減り、同条件の実機phase時間が改善することを確認する。削減量と時間を報告し、改善が見られなければ別の大規模基盤を追加せず計測結果に戻る。現時点で秒数の達成保証は置かない。

## 今回変更しないもの

逐次公開、原子的なShow admission、owner/generation/token検証、CLI全量readbackとSHA-256照合、R2 checksum付きimmutable音源保存、purge成功後の完了、未知mutationの再送拒否、記録保持方針は維持する。Workerで音源を全量hashする方式に戻さない。履歴telemetryの権限調査や汎用リカバリーの完成をM7の前提にしない。

## 第1改修の実装状況

- `src/worker-timing.ts`からWorkers Logsへ開始/終了時刻・所要時間・固定phase・job ID・結果を出力する。Episodeの各区間、管理API action、consumer全体、service invocation解放を記録する。共有の親spanを使わず、並列/入れ子の測定も独立した開始・終了時刻を持つ。CPU測定や区間時間の単純加算には使わない。
- R2への診断書き込み・詳細trace header・任意例外の記録は追加しない。ログ出力に失敗しても本来の操作結果や例外を置き換えない。
- `createShowExecutionEnv`はEpisode consumer invocation専用の検証済みcontextを作り、runnerと正式Worker effectsに同じcontextを渡す。privateなSymbolで保持し、不変request/hash・予約identity・bucket・executionに束縛する。現在のShow controlは毎回GETし、owner/対象/action/generation/token/予約identityを再照合する。別bucket、別job、別execution、別invocationへの再利用は拒否する。
- runner guard先頭の完全な`requireShowExecution`再読取を、直後の`requireOwnedPublication`が返したcontrolのexecution token確認へ統合した。gate後、長いI/O後、各CAS直前の確認は維持する。
- Show公開・他のLifecycle操作・stagingの検証経路は不変記録再利用の対象にしない。公開後のterminal status、purge確認、所有権解放条件も維持する。
- 計測用のRSS待機は暫定300秒/300回にし、経過時間判定は単調時計を使う。個別HTTP要求のtimeoutや未知変更の再送条件は変えない。正式版の既定値は未決定。

予約identityを持つ同じmetadata-only test fixtureで、不変記録再利用なし/ありを比較した（guard先頭の重複整理は両方に適用）。GET数は**269→141**、凍結control requestは**70→5**、予約は**69→2**。再利用ありの比較は正式consumerを通すため、commit markerの検証分も含む。これはローカルmockの操作数であり、36件Showで実測した484操作や97秒との直接比較ではない。

自動テストでは初回/metadata-only/audio-only公開、purge失敗後の再開、未終了audio PUT、応答喪失の既存回帰に加え、contextのscope不一致・可変owner変更・凍結記録欠落/不正・未完成予約・ログの秘密非出力と結果保持を確認する。第1改修の実機比較は下記の追試で完了した。全件読取とstaging finishを同時に変更して効果を混ぜない。

実装時の検証: `bun test`は971 pass / 0 fail（110 files）、`npm run check`とLinux単一CLI buildは成功。開発環境でビルドしたCLIのSHA-256は`8be772e994d679b036452f4685caa8853e0e4e0138844ad2399632245127c2c1`。別環境でビルドした追試CLIのhashとは区別する。

## 4781fad追試の確認と次の改修

[Issue #10追記](https://github.com/simosako/castloop-v2/issues/10#issuecomment-6120145336)、branch `test-evidence/rss-performance-4781fad-20261012` の固定commit `7cc3fb5b772f92d33de094b552275738d7c9a1a1`を確認した。参照した証跡は `design/acceptance/rss-import/20261012-performance-4781fad/evidence/rss-performance-4781fad-remeasure1/` の `result.md`、`performance-comparison.json`、`worker-logs.jsonl`。

CLI・Workerとも無改変の`4781fad`。同じ36件Show、同じEpisodeの同一metadata-only公開で、音源upload/copyはない。

| 区間 | 改修前 | 4781fad | 評価 |
| --- | ---: | ---: | --- |
| consumer（測定境界を一致） | 96.179秒 | 73.978秒 | 約23%短縮 |
| guard 8回 | 26.949秒 | 12.543秒 | 約53%短縮 |
| progress/status保存・確認 | 16.831秒 | 12.025秒 | 約29%短縮 |
| GUID検査 | 7.566秒 | 7.617秒 | 未改修、ほぼ不変 |
| feed入力・音源HEAD | 20.616秒 | 21.400秒 | 未改修、ほぼ不変 |
| metadata staging全体 | 31.649秒 | 33.444秒 | 未改修、短縮なし |
| 公開受付CLI戻り→published/released確認 | 96.785秒 | 75.635秒 | 約22%短縮 |

旧consumerの96.727秒には今回のphaseに含まれないroute/readiness前処理0.548秒があるため、同じ境界の96.179秒と比較する。各version1標本であり恒常的な改善率の保証ではないが、変更した区間の短縮と、変更していない区間の時間が残る結果は改修方針と整合する。公開内容、GUID・音源参照、元取り込み記録の不変、published/releasedとservice invocation解放も確認されている。

### 推奨順序

1. **GUID/feedの読み取り対象を減らす。** 両区間は約29.0秒でconsumerの約39%を占める。GUID不変の既存更新と、新規GUIDの追加を区別する。通常更新では、検証済みEpisode情報をまとめたカタログと変更対象だけを読み、他の全metadata/lifecycle/音源を再取得しない。必要な更新・削除・冪等性への接続はP3に記載した。承認されたこの方針で、前の「まず4並列だけ」を置き換えた。
2. **staging finishの不変記録再読取を整理する。** 新ログでも14.295秒が残る。`requireStageUpload`が読む凍結manifest/control request/完成済み予約を、同じfinish HTTP要求内で再利用できるかを検証する。現在のShow/Episode状態、verification token、client settlement、commit有無、progress/statusとpayload identityの確認は残す。公開consumerのexecution用contextをそのまま流用せず、stagingのverification所有権に合わせる。begin/settle/finishを1つのAPIへまとめる変更は不要。
3. **その結果で十分かを判断する。** 残るguard/statusの追加整理は、その後も大きな負担が残る場合だけ行う。新しいDB、別Queue、汎用cache基盤や全操作を扱う状態機械は作らない。

全件がactiveなShowの既存1件更新について、主要な読取はGUID metadata GETがN回、feedのlifecycle GETがN回、metadata GETがN−1回、audio HEADがN回で、**4N−1回**。36件で143回、200件で799回になり、LISTとowner等の確認は別途加わる。コードからの算出であり、4781fad追試の実機操作数ではない。既存更新のGUID走査だけを省いても3N−1回が残るので、feed入力の集め方も変える必要がある。

追加テストはカタログの初回構築・通常差分更新、非公開EpisodeのGUID競合、世代/ETag/owner不一致の拒否、部分保存の再試行、削除時のpayload除去に絞る。既存の公開・Lifecycle・ドメイン切替回帰を再利用し、新しい全故障マトリクスは作らない。36件と200件のfixtureで未変更EpisodeのGET/HEADが増えないことを確認する。同じmetadata-only 1jobでGUID/feed phaseとconsumer全体を比較した後、音源付き公開の待機も確認する。

初回構築等で並列読み取りを使う場合も少数に制限する。Cloudflareの[同時接続上限](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)は応答header待ち最大6件でR2 bindingも対象。開始済みI/Oは失敗時もすべてawaitし、不要な本文はcancelする。

### 今回は優先しないもの

- Queue配送は1回、attempts=1、consumer例外なし。purgeは1.077秒で、大きな遅延要因ではない。Queue・cache・Cloudflare設定は変更しない。
- CLI照会39回の合計37.611秒はconsumerと並行している。consumer時間へ加算せず、poll頻度変更を今回の速度改善の主対象にしない。
- `publication_status_changed`は計測helperで1回起き、読み取り再照会で完了した。正式RSS待機には既に対象を限定した再照会があるため、汎用retryや検証省略を追加しない。
- 暫定300秒の正式既定値化は未決定。今回もmetadata-onlyであり、元の音源付き逐次移行での120秒超過が解消したとは判定しない。

この追試レビュー後、管理者の承認に基づいて第2・第3改修を実装した。Cloudflareへのdeploy、証跡branchのmergeは行っていない。

## 第2・第3改修の実装状況

- `src/episode-catalog.ts`でカタログの初回構築、世代/identity検証、ETag条件付き差分保存を実装した。保存先はprivate R2の`public/podcasts/<showId>/episode-catalog.json`。公開Workerの許可pathではなく、既存のShow削除scope内のpayloadとして扱うため、削除scope番号や進捗schemaは変更しない。
- Show controlに任意の`episode_catalog_initialized: true`を追加し、未構築と構築後の欠落を区別する。構築済みカタログの欠落・破損・不正世代では自動再構築しない。初回保存後に応答を失った場合は、残るカタログを同じ所有権で検証して初期化記録を完了する。旧controlは読めるが、このfieldを知らないWorkerへのdowngradeは非対応。
- 通常のEpisode公開はカタログからGUIDとfeed入力を取得する。変更対象の元revision/current/lifecycle・音源は従来どおり検証し、未変更Episodeのmetadata/lifecycle GET・音源HEADとLISTを行わない。既存更新はカタログの対象snapshotとimmutable baseの一致も確認する。
- `advanceLifecycleFeedGeneration`でカタログを先に保存し、その後Showの世代を進める。先行保存の応答喪失では、現在のjob/request/tokenに一致するpending世代だけを同じ操作で再利用する。他job・不正世代は拒否する。
- Show公開・子の停止/復元/削除も同じ更新関数を通る。停止中のShowに対する子の停止/削除はfeedを変更せず、カタログを更新して世代を進める。Show削除はカタログも物理削除する。独自ドメイン切替は検証済みカタログを読み、現在のcanonical URLでRSSを生成する。未構築Showの互換経路では既存の全件読取を使う。
- `createStageVerificationEnv`でfinish invocation内の凍結request/予約/upload manifestを再利用する。Show control、Episode lifecycle、commit有無、verification token、settlement/progress/status、payload identityは各境界で再確認する。異常終了の処理は元のenvで完全検証する。APIの統合・変更要求の自動再送・CLI readback省略は行わない。
- カタログの36件/200件fixtureで、通常更新のGET/HEAD数が同じであることと、未変更Episodeを読まないことを確認した。カタログPUT応答喪失、別世代/job/hash、破損、非公開GUID競合、非配信path、削除対象分類も検証した。
- staging finishのmetadata fixtureでは、凍結upload manifestのGETは2回、凍結control requestは3回以内。scope確立後に5回の検証をしても不変記録のGETは増えず、Show controlとEpisode lifecycleはそれぞれ5回読み直す。実機139操作/14.295秒との直接比較ではない。

再測定手順は[`docs/rss_migration.md`](../docs/rss_migration.md#workerの時間ログと性能比較)。既存Showは最初のjobで初回構築し、次のjobを通常更新として比較する。カタログサイズ・RSS生成量はO(N)のままであり、Workers Freeでの実測と正式待機上限の判断は残る。

実装時の検証: `bun test`は977 pass / 0 fail（111 files）、`npm run check`とLinux単一CLI buildは成功。Cloudflareでの所要時間は未測定。

## 最初のEpisodeが300秒待機する事象の並行調査（2026-10-12）

### 確認範囲と結論

管理者から、別環境の性能試験で最初のEpisodeが300秒以内に公開完了にならないと報告された。調査対象は`056f6a6`（`a8c7e54`とIssue #11修正`5954e44`を含む）。この事象のjob ID・停止時status・Worker Logs・固定証跡は、調査時点のIssue #10/#11にはまだ掲載されていない。以下はソースとローカルmockの結果であり、実機の原因確定ではない。

- Issue #11修正はCLIの互換Worker更新とjournalに限定される。`src/`の公開consumer、音源保存、カタログ処理は`a8c7e54`から無変更。更新が正常完了したかは別途、試験対象CLI/Workerのcommit・versionとserviceの稼働状態で確認する。
- CLIの300秒は、公開受付receiptを保存した後の`waitForJob`の待機予算。ローカルdownload、staging、音源upload/readback、公開受付の時間は含まない。各管理HTTP要求の120秒とも別で、実行中の照会を300秒のdeadlineで中断する実装ではない。
- これまでの73.978秒という実測は、36件Showのmetadata-only更新。初回音源コピーを測っていないため、今回の音源付き公開と直接比較できない。
- **pendingというCLIメッセージだけでは、長時間のconsumer実行と、失敗・再試行後の停止を区別できない。** 原因が不明なままtimeout延長やowner解放を行わない。

### ソースとmockで確認した経路

初回音源は`persistAudio`でstagingからimmutable公開キーへストリームコピーする。Worker内の全量buffer化・アプリ側SHA-256計算はなく、R2 PUTへchecksumを渡す。この区間のGET/PUT完了待ちには独自の時間上限を設けていない。

カタログは新規Show公開時の`advanceLifecycleFeedGeneration`で初期化する。正常な新規Showなら、最初のEpisodeで既存36件を読み直す処理はない。旧Showの未構築カタログを最初に作る場合は全件読取があるが、初回構築と通常公開を分けて測る。

既存fixtureと正式consumer/effectsにR2操作カウンターを挟んだローカル診断を実施した。gateのruntime RPC/R2、service invocationの取得・解放、CLI照会はmock集計に含まない。音源は6 bytesのfixtureで、実ファイルの転送性能は測っていない。

| 新しいEpisodeの公開条件 | GET | HEAD | PUT | LIST | 結果 |
| --- | ---: | ---: | ---: | ---: | --- |
| カタログ構築済み、既存Episodeなし | 144 | 12 | 17 | 0 | published/released |
| カタログ構築済み、既存36件 | 144 | 12 | 17 | 0 | published/released |
| カタログ構築済み、既存200件 | 144 | 12 | 17 | 0 | published/released |
| カタログ未構築、既存36件 | 219 | 48 | 19 | 2 | published/released |

構築済みの場合でもShow control GETは80回、publication manifest GETは13回残る。ただしこの回数は実機300秒の説明ではなく、追加最適化は今回の停止箇所を特定してから判断する。正常なfixtureでは無限再試行・カタログ全件読取の反復は再現しなかった。

音源PUTのPromiseだけを保留したmockでは、読み取り照会は`processing / phase=feed / held / execution_active=true`となり、PUTを完了させた同じconsumerはpublished/releasedに到達した。一方、構築済みカタログの欠落、音源PUT例外をそれぞれ3回のconsumer呼出で再現すると、以下の状態が残った。

| 模擬故障 | status | progress.phase | ownership | execution_active |
| --- | --- | --- | --- | --- |
| 構築済みカタログの欠落 | retrying | validating | held | false |
| 音源PUT例外 | retrying | feed | held | false |

runnerの例外処理はretryingを保存し、呼出がsettleした後にexecution tokenを返す。Queueの再試行が尽きても、DLQ処理は`dlq.json`を保存するだけでstatusをfailedへ変えない。CLIはpublished/released、failed、superseded以外では待機を続ける。このため、処理が実行され続けていなくても300秒のpending停止になり得る。模擬故障が実機で起きたと断定するものではない。

### 別環境の証跡で照合する順序

1. **対象を固定する。** CLI/Workerのcommit・Worker version、service/Show/Episode/job ID、公開受付完了・CLI停止の時刻、stderr全文を記録する。「最初」が新規Showの最初のEpisodeか、既存Showの改修後最初のjobかも区別する。
2. **同じjobを読み取り照会する。** `castloop operation-status publication JOB_UUID`と`castloop service-status`でstatus.state/phase、progress.phase、ownership、execution_active、service invocationの有無を確認する。`execution_active`とinvocationの残存は記録上の所有権であり、実際にconsumerが生きている証明ではない。照会競合はそのまま記録し、秘密鍵・tokenは共有しない。
3. **そのjobのQueue invocationを照合する。** attempts、platform outcome、exceptions、CPU/wall time、`publication_delivery`、`worker_timing`の各phaseを取得する。CPU/memory制限等の強制終了では、catch/finallyやtoken解放が完了しない可能性がある。
4. **phaseを見て調査先を絞る。** validatingならstaging証跡・GUID/カタログ、feedなら音源コピー→feed入力→history/current/feed保存→カタログ/世代保存、purgeならcache purge、finishedならterminal statusとowner解放を確認する。`progress.phase=feed`だけで音源コピー停止とは断定しない。
5. **再試行停止と照会遅延を区別する。** retryingでattemptsが増えた場合は同じ失敗phaseとDLQ markerの有無を確認する。サーバー側published/releasedがCLI停止より前なら、consumerではなく照会応答・競合回数・照会時間を調べる。service invocation解放は別に確認する。

現行`measureWorkerPhase`は終了時にログを出すため、未完了のphaseの開始ログはない。またカタログ/世代保存には独立した時間ログがない。この2点は観測の不足であり、既存ログで区間を絞れなければ、固定phaseの開始checkpointとカタログ/世代保存の計測だけを追加する。ログがないことだけで処理未開始とは判断しない。

[Queuesのwall time上限](https://developers.cloudflare.com/queues/platform/limits/#wall-time-limits-by-invocation-type)は15分であり、CLIの300秒と同じではない。CPU時間とI/O待機も区別する。接続上限は応答header待ち最大6件であり、staging音源の本文streamを保持しただけで接続枠が詰まると断定できない。

調査時の既存関連テストは21 pass / 0 fail（4 files）。診断helper/結果は`/tmp/opencode/m7-first-publication-diagnostic.ts`と`/tmp/opencode/m7-first-publication-diagnostic.json`に保存した。製品source、Cloudflare設定・配備、timeout、記録・ownerには変更を加えていない。修正対象は実機証跡との照合後に決める。
