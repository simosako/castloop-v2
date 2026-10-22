# レビュー実機確認のログ欠測・canceled Alarm調査

2026-10-22。[先行実機確認](code_review_fixes_live_verification_20261022.md)で残した観測上の問題を、管理者の指示により調査した。対象は隔離サービス`rv22-8988de53`の既存証跡と対象Workerだけ。公開・Resume・Pause・配備・Alarmの再実行はしていない。

## 結論

| 対象 | 判明したこと | 確度・残る制約 |
| --- | --- | --- |
| 音源404のpath欠落による停止 | Cloudflareの保存ログでは音源UUIDが`REDACTED.mp3`。sanitizerの許可pathに一致せず、試験runnerの完全一致条件から外れる | **照合方式の不適合を特定**。同一probeの保存ログ・tail・ローカル要求ledgerを照合し、syntheticなオフライン再生でも再現。元のraw tail frame自体は保存されていない |
| 初回音源404・最終管理409のtail欠測 | 同じprobeを持つ元のHTTP invocationを保存ログで回収。409は同じtraceの`sqlite_operation_http`も存在 | **tail採取範囲の欠測**であり、HTTP未実行やアプリの未応答ではない。tail配送／採取から抜けた内部原因は未確定 |
| `canceled` Alarm 1件 | 同じDO・Worker version・ミリ秒まで同じ予定時刻の先行Alarmが成功し、その291ms後に別traceでcanceled。先行Alarmの公開jobも成功 | **成功後の重複配送が実行前に取り消された可能性が高い**。実行中jobの中断を示す証拠ではない。platform内部の取消理由自体は記録されていない |
| `sqlite_service_control`診断event未回収 | 元の外側HTTP・制御DOの409は保存されているが、対応custom logは再検索でも0件。配備sourceに診断処理があり、同じ経路はローカルで409＋eventを出す | **未解決**。アプリでのemit／runtimeの帰属／収集・保存のどこで失われたかを断定できない |

したがって「公開失敗の疑いがあるAlarm」からは切り分けが進んだが、**観測試験の全面合格へは変更しない**。既知11 jobの機能成功と、ログ採取の完全性は別の判定である。

## 調査方法と保全

- 元のSHA-256 manifestにある**220ファイルすべて**のサイズ・hash一致を確認した。停止結果・stderr・通知outbox・原本・journalは上書きしていない。
- 保存済みログ7ファイルをevent IDで重複排除し、**10,371 records**を照合した。invocation・custom log・spanは異なるrecord種別として扱い、record数を要求数に読み替えていない。
- 追加のCloudflareアクセスは、対象Workerのsettings/content/deploymentsのGETと、元の02:10:13〜02:10:16 UTCだけに絞った`dry: true`の一時ログquery。新たなWorker HTTP要求も送っていない。
- content取得の前後とも、元のversion `2902b44c-f5e0-41f2-9061-8a1c05f1df85`の単一100%配備を確認した。
- 追加証跡はgit-ignoredな`.local-test-data/results/20261022/rv22-8988de53/log-investigation-20261022/`。raw保存ログ、probe/job/DO/trace ID、認証情報はGit/PRへ転載しない。

## 1. path欠落はログ配送欠測と別問題

続行時のShow非公開化では、Feed・cover・audioの404を**3件ともtailで受信**していた。audioだけ安全化後の`path`がなく、probe UUID・GET・404・Worker version・正常outcomeは残っていた。

同じprobeの保存invocationでは、pathは`/podcasts/show-a/episodes/second/REDACTED.mp3`だった。一方、`scripts/test-support/sqlite-observability.ts:84–85`が許可する音源pathは、末尾がUUIDの形式だけである。取得済みの要求ledgerの本来のpathと、`REDACTED.mp3`へ置き換えたsynthetic frameを既存sanitizerに通すと、前者は保持、後者は`undefined`になった。

private runnerの`review-live-continue-20261022.ts:64–68`は、予定404の隔離に`row.path === expectedPath`を要求していた。この条件を満たさない404が通常guardへ入り、意図どおり保守的に停止した。**公開機能の不具合ではなく、nativeの秘匿化を織り込めていない試験側の相関条件**である。

sanitizerが任意pathを保存しない方針は維持する。改善する場合は、一意probe・要求ledger・version・method/status・時間帯・ログ/例外の健全性を束縛し、秘匿化を明示的に扱う。任意4xxを無視したり、失敗したguardをリセットしたりしない。

## 2. 初回404と管理409は保存ログで回収

以下は後日の再送結果ではなく、**元の要求の同一probe**を持つ保存invocationである。

| 元の要求 | 保存invocationの時刻（UTC） | tailとの照合 |
| --- | --- | --- |
| Episode非公開化後の音源GET 404 | 01:56:46.300 | 元のtailに対応probeなし。保存outcomeはok、pathの音源UUIDは秘匿化済み |
| 最終Pause後の不正管理query GET 409 | 02:06:45.840 | 元のtailに対応probeなし。同じ保存traceに`sqlite_operation_http / operation_unverified`あり |

後者の前に実行したPause後の7経路503は**7/7件ともtailと保存ログで一致**した。409待機中にもhealthのtailは届いている。そのため、ソケット全体が切断していたという説明では足りない。

元のcollectorではschema拒否・保存callback失敗・truncationを検知していない。ただし、受信したframe数と保存行数の一致は「全要求のframeが配送された」証明ではない。`worker-tail.ts`の`complete`も、接続・parse・保存の故障を検知しなかったという範囲に限る。

公式文書はreal-time logsの高負荷samplingによるdropを説明するが、今回sampling警告は記録されていない。配送遅延・有効化反映・sampling等のどれが原因かを確定する内部情報はなく、**15秒以内に届く保証も確認できない**。アプリ側WebSocket終了までのflush遅延は、今回の通常GET/Alarmを直接説明しない。tailを閉じれば未配送ログが回収できるという意味でもない。

## 3. canceled Alarmの詳細な相関

当初の報告ではinvocation recordだけを見て帰属を保留した。今回は**保存spanも照合**し、両Alarmが同じDO・version・予定時刻を持つことを確認した。

| 内容 | UTC |
| --- | --- |
| 両Alarmのscheduled time | **01:55:56.552** |
| 先行Alarm span開始 | 01:55:56.564 |
| 同じtraceの公開started、Show A内sequence 3 | 01:55:56.574 |
| 同じjobの公開succeeded | 01:55:58.269 |
| 先行Alarm span終了・outcome=ok | 01:55:58.272 |
| 別traceのAlarm、outcome=canceled | **01:55:58.563** |

canceledのtraceに保存されているspanはAlarm root 1件のみで、SQL/R2等のchild spanや公開started/failed/blockedログはない。これは**保存範囲の観測**であり、child spanなしだけでIO未実行を証明するものではない。

公開されているCloudflare workerdの実装では、SQLiteの保存Alarm時刻と届いたscheduled timeが一致しない場合、JS handlerを呼ばず`CancelAlarmHandler`を返す経路がある。呼出元はこれを`retry=false / outcome=CANCELED`に変換する。成功したAlarmは保存Alarmの削除へ進む。この実装と、同一予定時刻の成功直後・child spanなしの追加配送という証拠はよく一致する。

**最も整合的なのは、成功済みAlarmの古い配送をruntimeが実行前に取り消したという説明**である。`canceled`を一律にクライアント切断や公開中断と解釈するのは適切でない。ただし、公開workerdと実機runtimeのbuild同一性や内部の取消分岐までは取得しておらず、platformの確定原因とはしない。元のcanceled記録は残し、未知IOの再送・blocked解除・全過去IOのsettlement判定には使わない。

## 4. service_controlの診断欠落は未解決

02:10台の負の読取では、同一probeの外側HTTPと制御DOの**両方に409 / outcome=ok**が保存されていた。しかし`sqlite_service_control`のcustom logは、元の検索にも約3時間半後の狭い再検索にもない。追加queryは53 recordsでpage上限2,000未満、`sqlite_operation_http`は1件、`sqlite_service_control`は0件だった。

確認時の設定はlogs/tracesともenabled・persist・head sampling rate **1**、invocation logsも有効。配備sourceには`sqlite_service_control / service_request_unverified`の診断処理が残っている。ローカルSQLite fixtureで同じ不正registration GETを実行すると、409とこのeventを取得できた。

従って、**診断コード未配備・明示的sampling・単なる検索直後の反映待ち**を積極的に支持する証拠はない。ただし設定の現在値は当時の内部収集状態を保証しない。raw native frameやruntime内部のemit記録がなく、console呼出・invocation帰属・収集・保存・queryのどの段階で失われたかは未確定である。ローカル成功をnativeログ捕捉へ読み替えない。

## 推奨対応

1. **まず試験の相関と完了判定を改善する。** redacted audioを安全に区別し、要求ledgerと保存ログの独立照合を使う。tail接続正常だけではcompleteとせず、回収不能項目を欠測として残す。管理errorの対応付けもevent名だけでなくprobe/trace/versionで検証する。
2. **Alarmの相関情報を失わない。** 試験用の安全化記録にscheduled timeとDO/traceの非公開識別子を保持すれば、今回のような重複候補を区別しやすい。製品の再送規則や永続SQLite形式は変更しない。
3. `service_control`欠落が重要な受け入れ条件なら、次の**別途承認された最小読取試験**で、RESTの応答identity・安全化したtail・保存ログを同時照合する。必要な計装変更と配備は別作業であり、今回行っていない。Paid化・権限拡張・全公開試験のやり直しを先に行う理由はない。

今回の関連ローカル回帰は**56 pass / 0 fail**。sanitizer再生とcontrol handler照合、調査scriptの型・未使用宣言checkも成功した。これらはローカル確認であり、新しい実機公開試験ではない。機能成功11件、最終Pause、元の観測停止・measurement分類は変更していない。

## 参照

- [Cloudflare real-time logsの制約](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/#limits)
- [Workers Logsのsampling・invocation/custom logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [DO Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)
- workerdの参照commit `4a6e8b83038ce0d42f2077c0cd0874212456729c`（調査対象日時以前の公開source。配備runtimeと同一buildとの主張ではない）:
  - [SQLiteのarmAlarmHandler](https://github.com/cloudflare/workerd/blob/4a6e8b83038ce0d42f2077c0cd0874212456729c/src/workerd/io/actor-sqlite.c%2B%2B#L1005-L1107)
  - [JS handlerを呼ばないCANCELED分岐](https://github.com/cloudflare/workerd/blob/4a6e8b83038ce0d42f2077c0cd0874212456729c/src/workerd/api/global-scope.c%2B%2B#L679-L847)
- [先行のtail欠測調査](sqlite_tail_missing_logs_investigation_20261017.md)。別環境の過去結果であり、今回の原因や操作許可の代用にはしない。
