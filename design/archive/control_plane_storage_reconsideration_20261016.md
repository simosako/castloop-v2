# 制御状態の保存先と公開方式の再設計

2026-10-16。管理者から、重複確認の整理に限定せず、R2をロック・進捗DBとして使う前提を再検討するよう指示された。
**比較・設計提案であり、採用決定、製品実装、配備、資源・権限・課金変更、既存状態の移行は行っていない。**
既存のR2制御方式と案Cは、別途変更が承認されるまでは現行仕様である。

**後続の検討による方針修正**: 管理者との検討で、確認済み一意upload→DO SQLiteの逐次キュー→Alarm実行を基本形とした。
実装は[SQLite逐次公開の実装計画](../sqlite_sequential_publication_implementation_plan.md)に従う。
以下のDO＋Queues/outboxと全面的な公開先ポインター方式は比較履歴であり、最新の実装要件ではない。

## 結論

1. **制御状態をR2からトランザクション対応の保存先へ移す方向を推奨する。** 現状の追加サービス数は少ないが、アプリ内でDB相当の整合性管理を実装する費用が大きくなった。
2. 第一候補は **サービスごとのSQLite-backed Durable Object（以下DO）＋既存Queues＋private R2**。DO自身にSQLiteがあるため、D1を同時には導入しない。
3. **D1＋Queues＋R2も有力な代案**。SQLの運用・外部照会を優先する場合はこちらが適する。FIFOを必要としない設計はどちらでも可能。
4. 保存先の置換だけでは不十分。R2へ不変な公開候補を作り、**DO内の公開先ポインターをトランザクションで切り替える**方式を組み合わせる。遅延した旧処理が固定キーのfeed等を上書きする経路をなくす。
5. 狙うのはCPUだけでなく、管理処理のネットワーク往復・総wall時間・障害回復コードの削減。10ms適合や所要秒数は、設計だけで達成済みとしない。

## 1. なぜ今、選び直すのか

### 当初の選択は「非FIFOだからR2しか使えない」ではなかった

[初回レビュー](initial_design_review_01.md)のD-05には、ShowごとのDO、全体1並列のQueue、R2の条件付き更新の比較がある。
D-12ではMVPのjob statusをR2へ置き、必要になったらD1等を検討するとした。
[第2回レビュー](initial_design_review_02.md)では、追加DBを避け、同じShowの未完了操作を一つに制限する方式を採った。

非FIFOが要求するのは、配送順と公開順を切り離すこと。**その状態をR2へ置くことではない。**
仮にFIFOのQueueがあっても、CLIによる並行受付、処理途中の停止、重複、R2と状態記録の非原子性は残る。

### 実測により、MVP時の費用判断が変わった

[36件試験](normal36_publication_measurement_20261015.md)の完了29件は、既存36-Episode Showのmetadata-only再公開で、新規MP3 PUTは0 bytes。

| 区間 | invocation wall中央値 | invocation CPU中央値 |
| --- | ---: | ---: |
| stage-start | 23.209秒 | 66ms |
| upload-complete | 42.468秒 | 114ms |
| publish | 67.884秒 | 214ms |
| CLI staging開始→published確認 | 170.759秒 | 全体CPUは別集計していない |

待機が大きく、Queueを待つ時間だけでなくconsumer内部のwallも長い。
ただし全R2往復の実測分解は未完了で、配置・個別I/O・Queue配送それぞれの寄与率までは確定していない。
30件目のCLI読取失敗のHTTP statusも当時未記録であり、この設計問題をその直接原因と断定しない。

現在の責務分割には、次の重複がある。

- CLIの`ManagementTargetInspection.inspect`は、active Episodeの通常経路で16回のprivate R2 GETを行い、複数objectの再読取でsnapshotを照合する。
- update前・publish前の2回の照合と、3つのcommandのruntime/Queue照合を合わせると、通常経路には結果poll前だけで少なくとも50回のREST GETがある。これはソース上の経路の集計で、全実行のリクエスト実測値ではない。
- runnerのguard、effectsのguard、delivery gateが、それぞれowner/runtimeを確認する。
- progress保存でもowner確認→旧progress読取→owner再確認→単一object CASを行い、status保存は別経路で同様の検査を行う。

これは安全条件がすべて無駄という意味ではない。**複数recordを一度に確定できない保存先の制約を、階層ごとの再検査で補っている**ことが問題である。
DBを追加しない判断が、総実装量と運用負担の削減にはつながらなくなっている。

## 2. 選択肢の比較

| 案 | 強み | 残る負担・弱み | 評価 |
| --- | --- | --- | --- |
| R2継続・guard整理 | 変更範囲が小さく、現行資源を維持 | 複数objectの原子的更新がなく、所有・進捗・公開状態の照合と往復が残る | 短期修正としては有効。今回の第一候補にはしない |
| D1＋Queues＋R2 | service/Show/job/currentをSQL transactionへまとめられる。外部API、SQL照会、export等の運用機能がある | Worker↔D1の往復。Queue/R2との分散transactionはなく、outboxと公開先切替は必要。HTTP側に業務ロジックを戻すと10ms問題が残る | **有力な第二候補** |
| SQLite DO＋Queues＋R2 | 状態と判断コードを同じ場所へ集約。短いtransactionで受付・重複排除・世代更新を確定できる。重い仕事はQueueへ分離 | DO固有の配備・schema管理・照会APIが必要。request/duration枠、単一DOの集中、公開読取の配置遅延に注意 | **第一候補** |
| SQLite DO＋Alarms＋R2、Queues廃止 | job受付と起動予約をDO storage側へまとめられ、Queue配送待ちをなくせる | 長いR2処理でDOがactiveになりdurationを消費。再試行・隔離・観測を自分で整える。alarmもat-least-onceで外部副作用の冪等性は必要 | 小規模では合理的。既存Queueを捨てる必然性はまだない |
| Workflows＋DB/DO＋R2 | step単位の待機・再試行・再開をサービスへ任せられる | Show競合と公開先の整合性は別途必要。Freeのstep CPU制約、step枠、完了状態の短い保持がある。追加ledgerが必要 | 今回のFree前提では第一候補にしない |
| Queuesだけで管理 | 構成は少ない | 配送サービスはShow admissionやcurrent revisionのDBではない。重複・順不同・保持切れに対応できない | 不採用 |

DOを推す主因は「ロックAPIがあるから」ではなく、**小さい一貫した制御状態と、その遷移を判断するコードを一か所へ寄せられること**。
D1でも同じtransaction設計は可能で、D1の方が一般的なDB運用は容易である。
一般SQL照会・アカウント横断の集計を主要要件とするなら、順位を逆にする余地がある。

KVはeventually consistentであり、今回の受付・削除直後の公開可否の正には選ばない。

### D1案はどこまで同じ問題を解消できるか

D1でも、Showの受付、job作成、outboxを一回の`batch()` transactionへまとめ、current revisionとfeed世代を原子的に切り替えられる。
条件付き`UPDATE`、unique制約、正確なjob/世代照合を使えば、R2 lockファイルは不要になる。
ただし、条件付き更新が0行だっただけではSQLエラーにならないため、後続のjob作成等も同じ条件で抑止するなど、受付失敗で部分更新を残さないSQL設計が必要である。

主な違いは、D1では業務判断コードがWorker側、DBがネットワーク先にある点。
一つのSQL/batchへ整理できれば十分速い可能性があり、「D1も遅い」と決めつける根拠はない。
DOはその判断コードもSQLiteの隣へ置ける一方、外部からの照会・export・schema運用をより多く自分で用意する必要がある。
DOの配信RPC遅延や運用実装量が不利なら、D1案へ切り替える。
**両方を導入し、DO lockとD1 jobの整合性をさらに管理する構成は初期案にしない。**

## 3. 推奨構成の責務

```text
CLI ──小さな管理要求──> 薄いHTTP gateway ──> ServiceCoordinator DO / SQLite
 │                                                │
 └──素材のPUT・検証──> private R2                    ├──受付・現在状態・結果
                                                  └──durable outbox
                                                         │
                                                       Queues
                                                         │
                                                  publication executor
                                                    │           │
                                             不変候補をR2へ   DOへ確定要求

公開GET/HEAD ──> HTTP gateway ──> DOで小さい配信判定
                    └──許可された不変keyをWorkers Caching/R2から配信
```

| 役割 | 保存・実行するもの | 行わないこと |
| --- | --- | --- |
| CLI | ローカルTOML、素材解析、凍結要求・journal、R2への直接uploadと検証 | R2の多数の制御objectからserver状態の整合snapshotを組み立てない |
| HTTP gateway | 許可route/method、入力上限、DOへの転送、response整形 | TOML検証、公開runner、R2 lock/status管理、feed生成をしない |
| DO / SQLite | 登録、service状態、Show/Episode lifecycle、draft/job、世代、実行attempt、公開先、outbox、結果 | MP3を保存・中継しない。長いR2コピーやpurgeをtransaction内で待たない |
| Queue executor | 素材検証、必要な音源保存、feed/metadata生成、purge、DOへの結果報告 | currentやロックのR2 objectを独自に更新しない。公開順を配送順で決めない |
| R2 | 素材、不変音源、revision、世代別feed/cover、必要なexport | ロック・進捗・現在の公開先のauthoritative DBにしない |

### 最初は「1サービスにつき1 DO」

全サービスを1 DOにまとめるのでも、Episodeごとに作るのでもない。
service pauseとShow admissionを同じtransactionで扱えるため、現在の小規模・単一管理者用途ではサービス単位を推奨する。
ShowごとにDOを分けると、service側DOとShow側DOの間でpause/admissionを調停する別protocolが必要になる。
最初から二段の分散排他を作らない。

一つのDOでも、外部I/Oを待つ間に別要求が処理される。**DOにしただけで、非同期関数全体が直列になるわけではない。**
受付と確定を短いSQLite transactionにし、その外側でexecutorがI/Oをする。
公開配信・status照会を長いジョブの後ろで待たせない。
`blockConcurrencyWhile`で公開全体を囲む案は採らない。30秒timeoutによるresetもあり、長いR2 I/Oを囲むと悪化する。

### 状態は一つの正本にする

初期schemaの責務は、`service`、`shows`、`episodes`、`drafts`、`jobs`、`attempts`、`outbox`、公開用indexに分ける。
テーブル数を現行R2ファイル数へ合わせる必要はない。

- Show予約と登録完了は一つのtransactionへまとめる。永久identityと削除済みIDの再利用禁止は維持する。
- `jobs`にrequest identity/hash、phase、確定結果、allowlist診断を持ち、別のstatus/progress object同士の照合をなくす。
- Showのactive job、job状態、必要なservice集計を同じtransactionで更新する。単一Show一件の制約はDBで強制する。
- 現在revisionとShowのfeed世代を同じtransactionで進める。
- 全revisionの音源参照も管理し、配信時は対象Episodeに属する承認済みrevision/keyだけを許す。古い音源URLを維持することと、任意のR2 keyを配信できることを混同しない。
- feed生成用indexが必要なら、公開コンテンツのprojectionとして扱う。本文・emailをoperational job履歴へコピーしない。deleteではcontent projectionも削除し、小さい必要記録だけを残す。
- R2の旧status等を同時に正本として更新しない。必要なR2 exportは診断・backup用で、受付や成功判定には使わない。

## 4. アップロードと公開の流れ

### stagingは短い制御呼出、公開だけが非同期の長い仕事

1. CLIはDOの`beginDraft`相当へ、対象、期待base/世代、payload種別・hashを送る。
   DOがservice/Showの現在状態を一度のtransactionで照合し、draft identityとupload先を返す。
2. CLIがR2へ素材をPUTし、既存の全量読戻し等の検証を行う。MP3をHTTP gatewayやDOへ通さない。
3. CLIが同じ要求に対する`finishUpload`相当を送る。必要なobject照合後、DOがdraftをreadyにする。**ここでは公開しない。**
4. 明示的な`publish-*`で、DOが期待base・世代・ready draftを照合し、凍結job、Show受付、outboxを原子的に記録する。
   `accepted`は耐久受付であって公開完了ではない。
5. Queue executorがjobを処理し、不変な公開候補を作る。DOが最後に公開先を切り替え、purge確認後に完了する。
6. CLIは同じjobのDO statusを小さい応答でpollする。多数のR2ファイルを読み直さない。

これにより、現行のstart/complete/publishを**毎回Queue経由で往復し、それぞれR2結果を待つ3段構成**を見直せる。
stagingの内容検証が長い場合だけ非同期に分離し、すべての操作を一律Queue jobにしない。
HTTPが再び入口になるが、業務ロジックはDO invocation側に置く。外側HTTPの10msは別途測定する。
これは現在の案Cへ暗黙のHTTP fallbackを足す変更ではなく、承認が必要な新protocolである。

upload先はdraft/attemptで分離する。一つの未公開draft IDは維持し、実行attempt IDを別に扱う。
DOがpathを返すこと自体は、R2への認証や書込権限の代替ではない。既存の管理者API token方式を維持する。
応答不明のPUTを再送したり、HEAD不在だけで次へ進んだりする許可にはしない。
管理要求の認証、bounded parse、service/action/request/hashの束縛は残す。Queueへ送れる権限だけで公開を許さず、executorもDOの受付済みjobと正確に照合する。
API token・管理秘密鍵・本文をQueueやoperational記録へコピーしない。

## 5. transactionの境界と外部副作用

### 受付とQueue送信の隙間をoutboxで埋める

DB transactionと`Queue.send()`は一つの分散transactionにはならない。
「jobだけできて送信されない」「送信できたが応答を失う」を扱う。

- job・Show受付・送信待ちoutboxを同じ保存transactionで作る。起動予約もDO storage側で耐久化する。
- 短いalarmがoutboxをQueueへ送る。送信待ちの原本はQueueの24時間保持より長くDBへ残す。
- 同じoutbox IDを再送しても、同じjobへ収束させる。送信成功を公開成功としない。
- alarmはat-least-onceで、失敗時の標準retryも有限。retry枯渇・Free枠超過時はpendingを保持し、status/監視から見えるようにする。永続動作を無条件には保証しない。
- CLIの未知POST自動再送とは区別する。初期案ではCLIは同じrequest IDの照合を行い、自動再送しない。server内部の再配送は、既に耐久受付された正確なjobだけに限定する。

SQLとalarm予約の原子性・起動直前の停止は、DO runtimeでの小さい試作で確認する。`waitUntil`だけを耐久起動の代用品にしない。

### 公開は「ファイル上書き」ではなく「公開先の確定」へ

```text
DB: queued → preparing(attempt A)
R2: attempt A専用の不変な音源・metadata・feed・coverを準備して検証
DB transaction: exact attempt/base/世代を照合し、current/feed/visibilityを切替
DB: visible_pending_purge
executor: 対象cacheをpurge
DB transaction: 同じ公開先とattemptを照合し、published・受付解放を同時確定
```

重要なのは、**R2の固定feed/cover/currentキーを旧executorが上書きしないこと**。
公開URLはそのままにし、WorkerがDBの公開先を内部の世代別R2 keyへ写像する。
metadata-only更新では既存音源を引き続き参照し、不要な音源コピーをしない。
feed候補は検証したShowのbase/feed世代から生成し、その世代も最終transactionで照合する。先に生成した古いfeedを、新しい状態へ無条件に採用しない。

これは現行の固定R2 cover key上書き・feed配置の方針変更を含む。公開URL維持だけで「互換更新」とは呼ばず、明示的な承認と配信回帰が必要。

DO reset、Queue timeout、RPC切断でも、外部R2 PUTが完了しない保証は得られない。
そこで、旧attemptが遅れて書けるのはそのattempt専用の未参照ファイルだけに限定する。
旧attemptはDBの最終照合でcurrentへ昇格できず、公開状態を巻き戻せない。
**単にDBのleaseを期限切れにする方式とは異なる。**

attemptを置き換えて安全に再実行できる範囲は、不変・隔離された候補作成に限る。実装でその条件を証明するまではunknownをブロックする。
共有キーへの上書き、payload削除、配備は同じ扱いにしない。現在残っているR2 owner/tokenの強制解放にも適用しない。

### 何を減らし、何を残すのか

- `beginAttempt`、`activate`、`complete`等の**意味のある状態遷移**で現在状態をtransaction検査する。
- 素材schema/hash・実在性・immutable revisionの検証は残す。immutableな候補作成の各helperでR2 ownerを何度も読む設計にはしない。
- UIの細かい表示phaseは原則ログへ。再開判断に必要なcheckpointだけをDBへ保存する。
- `visible_pending_purge`を省略せず、purge失敗では受付を保持し、次の実行はpurgeから続ける。音源の重複保存をしない。
- service runtime/version/config/明示resume windowはDOで一貫して照合する。DOがあることだけで配備済みruntimeの検証を不要にしない。

## 6. 順序・停止・再配送の扱い

| ケース | 新設計での扱い |
| --- | --- |
| 同じrequest ID・同じbody | 同じ耐久結果を返す。新jobにしない |
| 同じrequest ID・違うbody | 拒否 |
| 同じShowの競合公開 | transactionで片方だけ受付。もう片方はconflict。時刻やQueue順で補正しない |
| 遅れて来た古い公開要求 | expected base/世代/runtime windowが不一致なら拒否 |
| 実行中の同じQueue messageの重複 | 同じjob/attemptを照合。並行してcurrentを書けない。再配送やackの扱いはoutbox/jobと合わせて定義する |
| DB受付直後に応答喪失 | 凍結request IDで照合。新jobへの置換・CLIの盲目的再送をしない |
| R2候補作成後に停止 | currentは旧版のまま。検証済み候補の利用または隔離された再attemptを限定的に設計する |
| current切替後・purge前に停止 | pending-purgeを保持。同じ公開先へのpurgeを再開する |
| service pauseと新規公開が競合 | 同じDO transactionで順序を確定。pause後の新規受付を拒否 |
| pause前に受付済みのjob | 正確な旧受付を識別してdrain可能にする。pausedだからすべての古い要求を許すのではない |
| DO/Queue/DBのFree枠超過 | 新規操作を止め、記録は保持。成功・ロック解放を推定しない |

必要なのは全体FIFOではなく、**同一Showの受付と公開確定の一貫した順序**。
将来一つのShowへ複数jobを先行受付するなら、DBでsequenceを採番して次に処理可能なjobを選ぶ設計になるが、初期案には追加しない。
既存Queueのbatch/concurrency/retry設定を変更する必然性もなく、初期試作は維持する。

### 非公開化・削除は後付けにしない

非公開化/削除開始はDBでvisibilityを先に閉じ、feed世代とcache処理を追跡する。
削除済みidentityを残し、旧attempt・遅延messageが再公開できないことを同じ状態機械で保証する。

配信を止めることと、payloadを物理削除し終えることは別。
旧PUTがまだ完了し得る間に物理削除完了とはしない。削除完了にはupload/executorのsettlementと対象の照合が必要で、U1はDO導入で解決しない。
既に開始した音源転送を即時撤回できるとも約束しない。配信判定の確定前後で、どの新規要求を遮断するかを定義して試験する。

## 7. 公開配信の正をどこで読むか

管理DBだけをDOへ移し、配信判定はR2 projectionのまま、という案もある。
ただしDOの最新状態とR2 projectionの不一致、旧writerによる遅延更新、再同期の責務が残り、二重の正本に近づく。

初期候補は、**公開要求ごとに一度、DOから小さい配信判定と不変key/generationを取得する**方式とする。
service、Show、必要なEpisodeの状態を同じ読取で扱い、全文TOMLを返さない。配信判定をTTL cacheしない。
内部asset cacheはgeneration/keyで分離し、gatewayを通らずにR2や内部entrypointへ到達させない。
許可path、GET/HEAD/Range/条件付き要求、外向け再検証必須、purge-before-completionは維持する。

代償は、公開のcache HITでもDO RPCが増えること。
DOの配置までの往復遅延、request枠、集中障害を測定する必要がある。
**管理公開が速くなっても、世界各地のfeed/audio配信が遅くなるなら無条件に採用しない。**
この場合はD1 primaryを用いた一回の判定も比較対象にする。
D1 replicaを使うなら、bookmarkによるread-your-writesだけでは未知の他要求による最新の非公開化を保証できない。公開可否を無制約のreplica読取にしない。

## 8. Free枠の確認

2026-10-16参照の公式文書に基づく。アカウントの実効設定・残量を確認したという意味ではない。

| 項目 | Workers Freeでの主な枠 |
| --- | --- |
| D1 | 読取500万行/日、書込10万行/日、合計5GB。最大10 DB、1 DBは500MB |
| SQLite DO storage | 読取500万行/日、書込10万行/日、合計5GB。新規FreeではSQLite backendを使う |
| DO compute | 10万requests/日、13,000 GB-s/日。RPC・alarmも消費する |
| DO CPU | DO専用limits文書ではinvocation既定30秒。外側HTTPの10msとは別に測定する |
| Queues | 10,000 operations/日。小さいmessageの通常配送はwrite/read/deleteの3 operations。Free保持は24時間 |
| Workflows | limits文書ではFreeのstep CPUは10ms、3,000 steps/日、完了状態保持3日 |

- これらはサービス単独の専用枠ではなく、アカウント内の他の利用を含めて考える。Workers HTTP、R2、purge等の枠も別途ある。
- DOはCPUだけでなく、外部I/O待機を含むactive wall時間に対してdurationを消費する。MP3処理をDOで長時間待たせず、Queue executorへ置く理由の一つ。
- SQLの行数はAPI呼出数と同じではない。全件scanとindex更新も測り、必要なindexを絞る。
- Free枠超過時に自動課金・自動upgradeしない。公式文書上、D1/DOは該当操作が失敗する。公開判定の失敗はfail closedになり、配信可用性への影響も評価する。
- DOのstorage上限は、同じ公式limitsページ内で一般表とFree向けFAQの表現に差がある。1 Objectの実効上限は採用前に再確認する。制御recordだけを置く今回の案は、その大容量限界への依存を避ける。
- Workflowsには有用な再開機構があるが、外部副作用とstep記録の間の停止では冪等性が必要。exactly-onceの外部書込やR2とのtransactionが自動で得られるとは扱わない。

## 9. 現行コードからの進め方

### 小さい試作で選定し、旧設計にDB wrapperを足すだけにしない

1. この提案の責務・状態遷移・固定R2キー変更・HTTP入口をレビューし、方式を選ぶ。
2. 採用承認後、**別開発branchで新規隔離サービス向けの一経路**を作る。既存Showのmetadata-only公開を対象に、DO transaction、outbox、Queue executor、不変feed、配信判定、statusを通す。
3. 重複・並行受付・遅延した旧attempt・各確定境界の停止・purge失敗を試す。phase helper単体でなく、runtimeで永続性と外部I/O境界を確認する。
4. 小容量→36件Showでwall/CPU/操作数/配信遅延を比較し、採否を再評価する。実Cloudflare資源の作成・配備・測定は別途承認を受ける。
5. 採用後、Show公開・音源更新・6 lifecycle操作・pause/deploy/domain・初期化まで同じ正本へ統合する。製品化する前に機能・保持規約の回帰を通す。

既存runnerに、R2と同じ関数を全部持つDO adapterだけを差し込む案は避ける。
現在の多段guard・status/progress分離・receipt照合をそのままRPCにすると、往復と責務重複が残るためである。
metadata validation、RSS生成、MP3検証、immutable media処理、cache配信部品は再利用し、**制御のcompositionを作り直す**。

### 移行は性能試作から分離する

- R2 controlからDOへの移行はデータ形式変更であり、現行の互換Worker更新として実行しない。
- 当初は新規隔離環境のみ。既存環境のownerやunknown journalを変換・解除して試作へ持ち込まない。
- 正式移行が必要になったら、保守停止、旧CLI/consumer/PUTの終了確認、inventory、DBへの一度限りの取込、公開先照合、cache処理、新runtime readiness、明示resumeを別計画にする。
- R2とDOへ新規操作を同時に受け付けるdual-write期間は作らない。旧protocolの再配送を新規操作へ昇格させない。
- Bun単一バイナリとCloudflare REST APIによる管理を維持する。DO class/namespace/schemaの配備・照会、必要なtoken権限確認をCLIへ設計する。Wranglerや別DB credentialを利用者に必須化しない。
- DB backup/restoreだけでR2 payloadやpurge状態も巻き戻るわけではない。export・復元・削除済みidentity保護も正式運用設計に含める。

### 測定で判断する項目

- metadata-only公開のCLI総wall、受付→開始、実行、purge、完了観測を分離する。暫定の設計目標は36件Showで総wall p95 30秒未満とし、170.759秒中央値の現状からの改善を比較する。目標であって予測値ではない。
- CLIからの制御要求数、DO RPC数、R2 HEAD/GET/PUT数、SQL rows read/written、Queue operations、DO active durationを記録する。
- 外側管理/公開HTTP、DO、Queue、内部cache-ownerを別invocationとして測る。HTTP CPUはp95だけでなく最大・10ms超過件数・収録欠落も報告する。
- 公開GET/HEAD/Range/304、cold/warm cache、複数地点でのclient wallを現行と比較する。配信判定の追加往復を隠さない。
- 元のGUID/日時/音源URL/履歴、不変性、公開可否、purge失敗時の未完了保持、未知I/Oの保全を確認する。
- Issue #13のfreeze未観測と、性能改善、全HTTPのFree適合を別々に判定する。有限試験だけで恒久解消は宣言しない。

## 10. 根拠と参照

ソース上の確認対象:

- `packages/cli/src/management-target-inspection.ts`: 複数objectの読取と再照合。
- `packages/cli/src/management-queue-client.ts`: commandごとのruntime/Queue照合とR2結果poll。
- `src/management-queue-consumer.ts`: stage/publishの受付・実行・gate・結果保存。
- `src/lifecycle-control.ts`、`src/lifecycle-job-store.ts`: owner/execution照合、progress/status個別CAS。
- `src/lifecycle-worker-effects.ts`、`src/lifecycle-delivery-gate.ts`: 重なった実行・runtime検査。
- `src/lifecycle-gateway.ts`、`src/public-delivery-state.ts`: 現在の配信判定とcache呼出。

公式文書（2026-10-16参照）:

- [保存先の選択・DO内SQLiteとD1の比較](https://developers.cloudflare.com/workers/platform/storage-options/)
- [DO料金・Free枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [DO制限](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [DO SQLite transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [DO concurrencyとstate](https://developers.cloudflare.com/durable-objects/api/state/)
- [DO Alarmsのat-least-once・有限retry](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [D1料金](https://developers.cloudflare.com/d1/platform/pricing/)、[制限](https://developers.cloudflare.com/d1/platform/limits/)、[batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 read replication / Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Queues配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)、[料金](https://developers.cloudflare.com/queues/platform/pricing/)、[制限](https://developers.cloudflare.com/queues/platform/limits/)
- [Workflows料金](https://developers.cloudflare.com/workflows/reference/pricing/)、[制限](https://developers.cloudflare.com/workflows/reference/limits/)、[副作用と冪等性](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
