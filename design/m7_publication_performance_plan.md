# M7 RSS逐次公開の所要時間分析・改善計画

2026-10-12。時間ログと公開consumerの不変記録再利用を実装した。全件読取・staging finishの改善は未実装。Cloudflareの設定変更や追加の実機操作は行っていない。

管理者確認: 今後も区間時間を測定できる記録機能の追加と、計測のための待機上限300秒への一時延長は承認済み。正式版の既定待機上限は未決定で、性能改善後の実測を見て判断する。

## 結論

標準CLIの120秒待機では、正常に完了する公開jobを確認しきれず停止した。300秒版で全36件が公開できたことは機能の確認になるが、標準CLIの受け入れ完了でも性能改善でもない。

コードと追加実測で確認した主要な改善対象は、**層をまたいだ安全確認の重複による直列R2 I/O**と、**各公開で繰り返すEpisode一覧の読み取り**。最初の性能改修は公開consumerの所有権検証、とくに凍結request・Show予約の再読取削減とguardの重複整理に絞る。RSS専用の公開エンジンや一括公開APIは作らない。

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

## コードから分かったこと

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

改修順は次のとおり。

1. **公開consumerの共通所有権検証**: 凍結request・予約のinvocation内再利用、runner/effects/writerの重複確認整理。全件走査より先に着手する。
2. **GUID/feedの全件読み取り**: 合計約28.2秒の区間を対象に、少数並列と同一metadata再利用を行う。
3. **staging finish**: 139操作の重複確認を整理する。1の共通部品を再利用するが、別の変更・比較単位とする。

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

### P3. Episode一覧読み取りを必要な範囲だけ改善

追加計測で20.616秒＋7.566秒の負担が確認されたため、P2の比較後の第2改修とする。

- 同じ公開invocationで取得するcurrent metadataを、GUID検証とfeed入力に再利用する。GUID検証に必要な非公開Episodeとfeedに必要なactive Episodeを区別する。
- 独立した読み取りには小さい固定数（例:4）の並列上限を設け、全件`Promise.all`や公開jobの並列化はしない。
- Show ownerの前後照合、ETag/サイズ照合、metadata byte/object上限、GUID重複拒否は維持する。読み取り途中の変更はfail closed。
- 新しいGUID index、D1、別Queue、一括feed確定モードは追加しない。

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

自動テストでは初回/metadata-only/audio-only公開、purge失敗後の再開、未終了audio PUT、応答喪失の既存回帰に加え、contextのscope不一致・可変owner変更・凍結記録欠落/不正・未完成予約・ログの秘密非出力と結果保持を確認する。次は承認された試験環境で、この第1改修の時間を測る。全件読取とstaging finishを同時に変更して効果を混ぜない。

検証: `bun test`は971 pass / 0 fail（110 files）、`npm run check`とLinux単一CLI buildは成功。ビルドしたCLIのSHA-256は`8be772e994d679b036452f4685caa8853e0e4e0138844ad2399632245127c2c1`。実機所要時間の改善はまだ未検証。
