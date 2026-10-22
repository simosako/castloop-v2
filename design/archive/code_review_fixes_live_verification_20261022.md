# レビュー修正の小規模実機確認（2026-10-22）

## 結果

**機能確認は成功したが、観測の受け入れは未完了。** 新規隔離環境の2 Show・3 Episodeで、公開・metadata/cover更新・非公開化・保存済みsnapshot復元の**11 jobすべてが`succeeded`**となった。最終の独立したGET監査でも、凍結した11要求それぞれのrequest/job/hashと成功結果を照合した。

両Showとサービスは**ready / paused / drained、active=null / queued=0**で保持した。Feed・cover・音源の7経路は503／`no-store`となり、資源・原本・journal・私有証跡は削除していない。

一方、tail欠測、安全化後path欠落による保守的停止、管理エラーeventの一部未回収があった。保存ログではtail未捕捉の`canceled` Alarmも1件見つかった。これらを後の成功で解消済みとせず、全invocation正常・欠測なし・未知IOのsettlement完了とは主張しない。製品コードの追加修正・再配備はしていない。

同日の[追加調査](review_observation_investigation_20261022.md)で、path照合とCloudflareのUUID秘匿化の不適合を特定した。tail欠測の元の404/409は保存ログで回収し、canceledは同じDO・予定時刻の成功Alarmの291ms後で、成功後の重複配送取り消しが有力となった。`sqlite_service_control`診断欠落とtail配送原因は未確定。以下は初回報告時点の判断を保持する。

## 承認と対象

管理者は、新規隔離環境の作成・配備・2 Showと短尺音源の公開・更新・非公開化・復元・配信・観測・最終Pauseを承認した。資源削除、既存環境の変更、DNS・権限・課金・CPU上限変更、未知結果の再送は含まない。

| 項目 | 対象 |
| --- | --- |
| サービス | `rv22-8988de53` |
| Worker | `castloop-rv22-8988de53-465c75c2` |
| private R2 bucket | `castloop-rv22-8988de53` |
| DO namespace | `7748108bfabc453dbe1f3c1044b590dd` |
| Worker version | `2902b44c-f5e0-41f2-9061-8a1c05f1df85` |
| 試験artifact | `521dbb9dfbceffbc4aa78bc086a9b65620e5ddd8`の修正一式 |
| Linux単体CLI SHA-256 | `562294217a2092e13073531847521010a8fb5cd4aaee822cfb9f89967ac1b999` |
| 実行開始 | 2026-10-22 01:55:08.636 UTC |
| 最終の独立した読取監査 | 2026-10-22 02:14:09.425 UTC |

10秒の合成toneと新規生成JPEGを使い、既存の個人音源は再公開しなかった。CLIは既存`dist/`とは別の一時directoryへbuildし、試験専用のprivate directoryへ固定した。実行中はbinaryと製品・試験ソース163ファイルのhashを照合した。tmuxと既存supervisorで実行を独立させ、正常・異常の通知acknowledgementも保存した。

## 機能確認

| 対応 | 実機で確認した内容 |
| --- | --- |
| 初期化 | 正式単体CLIからfresh init。native SQL/Alarm/R2/cache probe後のready/paused/drained、サービス設定・Worker version・REST receipt一致 |
| R1・公開/lifecycle正常経路 | Show初回2件、Episode初回3件、Episode metadata更新1件、Show metadata＋cover更新1件、Episode/Showの非公開化・復元各1件。計11件の成功を凍結要求からGET再照合 |
| 配信・保持 | Feed件数、JPEG/MP3の原本SHA-256、音源HEAD/Range/304、Feed 304。metadata-onlyで音源URL保持、stageのみでは公開内容不変。非公開化はFeed/cover/音源404、復元後は保存Feed/cover/audioのhash・音源identityを維持 |
| R2 | 編集後Show/Episode titleを各256文字にしたローカルRSS fixtureを正式CLIで拒否。Show予約は前後ともmissing、公開journalは作られなかった。remote IO 0件の厳密なtransport証明はローカル回帰であり、この実機試験だけの主張ではない |
| R6・R9 | 両Show open→片方paused→両方pausedで、集約healthと一覧を確認。`list-shows.state=null`、テキストに架空open/pausedなし。AのPause後もBのFeedは200。性能改善・最大4件並列の証明ではない |
| R8 | 正式CLIのmetadata/画像/MP3 upload、receiptと全量readbackを含む正常経路が成功。native切断・不明PUTの故障注入はしない |
| 最終Pause | 新しい明示Pause UUIDで2 Showを停止。両Show/サービスのready/paused/drained、未完了operation一覧0件。公開7経路503／no-store |

正式CLIは計61回実行し、RSS titleの予定拒否2件だけexit=1、残る59件はexit=0だった。これに加えて、HTTP probe・health/inspection・REST・保存ログの読取照合を行った。資源一覧は、試験前からのWorker名・bucket名・namespace ID集合を維持し、新規サービスの各1資源だけが増えた。既存資源の全object内容を再監査したという意味ではない。

R3/R7の大量履歴・単一ローカル照会、R5の文書コマンド、R10のActions固定は、それぞれローカル回帰・型チェック・先行GitHub CIの結果と区別する。この実機試験に伴う再実行でも`bun test` **571 pass / 0 fail**、型・未使用宣言checkは成功した。

## 観測上の中断と続行の境界

初回は8つの公開/lifecycle jobがすべて`succeeded`となった後、Episode非公開化に対する音源404のtail frameを15秒以内に取得できず停止した。HTTPそのものは404だった。native healthをGETで照合し、両Showのready/drained、active=null、queued=0、REST/native version一致を確認した。別の読取専用tailでは同じ非公開音源の404を2回とも捕捉したが、**最初の欠測原因は未確定**とする。

同じartifactで、未開始のEpisode復元とShow非公開化を実施した。これらも`succeeded`となったが、予定した音源404 frameの安全化後`path`が欠落し、厳格な正常系guardが停止した。Feed/coverの404 frameは取得できた。これは公開処理のblockedや未知書込ではなく、負の試験の観測照合に対する保守的停止だった。

両方の停止記録・通知を保持し、成功へ書き換えなかった。ローカル要求ledgerの一意probe UUID、対象worker version、method/status、エラー・未認識ログなしという条件で、予定した負の読取だけであることを照合した。任意4xxの無視や製品guardの変更はしていない。既知の完了状態と未完了操作の不存在を読み直し、未開始の操作だけへ進んだ。元の公開要求の再送・再配備・blocked解放・履歴削除は行っていない。

最後の段階では未開始のShow復元と最終Pauseを完了した後、管理GETの予定409に対応するerror eventをtailで回収できず再び停止した。この時点で正常系guardはhealthy、reconciliation待ち0であり、後続mutationは残っていなかった。その後は**GETと一時的な保存ログqueryだけ**で監査し、追加の公開・Resume・Pauseを行わなかった。

### R4の確認できた範囲

- 管理APIへの不正query/対象指定に対するHTTP 409と、Pause後のHTTP 503を実際に取得した。
- 保存されたnativeの`sqlite_operation_http / operation_unverified`を取得し、そのallowlisted eventを既存sanitizer/classifierへ入力すると`failed`となり、guardが変更操作を拒否することを確認した。**保存eventからのadapter検査であり、欠測したraw tail frameを回収・復元できたという意味ではない。**
- `sqlite_service_control`についてはHTTP 409を取得したが、対応eventを今回のtail・保存ログ照会では確認できなかった。emitされなかったのか、収集・保存・検索側の欠測かは未確定。ローカル回帰の成功をnative event捕捉へ読み替えない。

### 保存ログのcanceled Alarm

対象Workerだけの保存ログを照会したところ、**2026-10-22 01:55:58.563 UTCの`SqlitePublicationService / alarm / outcome=canceled`が1件**あった。実時間tailでは捕捉していない。今回の保存recordには正確なjobへの帰属を確定する情報を揃えられておらず、無害な重複Alarmやjob中断のいずれとも断定しない。

発見後は公開・再開・再配備をせず、保存済みの11要求をGETして全件の厳密な成功identity/hash、両Showのready/paused/drained、未完了operationなしを再確認した。これにより既知11 jobの完了は確認できるが、canceledの原因や全過去IOのsettlementの証明にはならない。自動再送・強制解放はしていない。

## 検証の限界

- これは小規模なnative正常系・負の読取の確認であり、全invocationを欠測なく取得できた試験ではない。最初のtail欠測は、後のcapture成功で解消済みにはしない。
- R1の容量境界ストレス、R3の大量履歴、R8のnative切断・未知PUT、R9の最大4件並列・速度改善、Alarm再配送・blocked故障注入、cache hit/miss・全拠点purge、300MB経路・将来のFree適合は対象外。U1も未検証のまま。
- 実機で変更したのは新規隔離サービスのみ。保持サービスや旧試験環境へ配備・公開・再開せず、資源削除・権限/課金/CPU設定変更は行っていない。

一次証拠はgit-ignoredな`.local-test-data/results/20261022/rv22-8988de53/`へ保持する。管理鍵・TOML本文・journal・未公開job ID・tail接続URL・任意ログ原文をGit/PRへ掲載しない。

`run-result.json`、`continuation-result.json`、`finish-result.json`は各観測停止のまま保全し、別の`final-audit-result.json`へ「機能確認成功・観測不完全」を記録した。最後に220ファイルのSHA-256 manifestを保存した（workspace/import内の鍵・journalはmanifest集計から除外し、そのまま別途保持）。この記録は追加の環境変更・再開・削除の許可ではない。
