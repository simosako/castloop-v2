# fresh-r2: 初回Show公開停止の調査

## 結論

待機上限300秒だけが問題なのではない。このShowのcommitと一致するDLQ markerがあり、Show実行トークンとサービスinvocationが残っている。コード上、実行トークンがある状態では同じjobの次のconsumerも明示retryも拒否される。CLIはacknowledged jobを照会し続けるため、`processing / held` のまま待機上限に達する。

**最初のconsumerが止まった直接原因は未確定。** Dashboard再exportの追加照合で、初回Queue invocationは約35秒で `canceled`、同じjobの再試行2・3は実行トークン残留による例外と確認できた（末尾の追加記録参照）。初回がなぜ取り消されたかはまだ解析していない。保存されたR2状態と模擬試験は後処理／トークン返却が完了しなかった状態を説明するが、R2通信障害やCloudflare runtime問題を確定原因と扱わない。

`a8c7e54` のカタログ構築が原因だとも断定できない。公開先への最初のShow metadata書き込みより前で止まっており、カタログ作成・feed generation更新の段階には到達していない。36件のEpisode公開、約1.5GBのMP3 upload、性能比較jobもまだ始まっていない。

## 対象と保全

- commit: `a8c7e54e8c326ef238a2fcd9d672a27b002bec66`（製品source無改変）
- Worker: `castloop-rssperf-1012-r2-0f9dbe46`
- Worker version: `0f833389-f021-435c-bdf0-59205115e759`
- hostname: `castloop-rss-perf-r2.otftalk.com`
- service: `rssperf-1012-r2`
- Show: `otftalk-rss`
- job: `69a619df-9115-42e8-87db-e98947635863`
- workspace: `workspaces/rss-performance-20261012-r2`
- import cursor: step 4 / phase `waiting`、元116入力を保持。
- 今回は読み取り照会と完全ローカル模擬試験のみ。publish再送、retry/requeue、Worker更新、owner強制解除、journal変更、Queue pull/ack、旧環境変更、API権限・ログ設定・OS DNS変更は実施していない。
- `processing` と残留invocation数だけから、今もWorkerが生存しているとは判断しない。逆に、DLQ記録だけを根拠に強制解除もしない。

## Dashboardログ取得前の実機照会（当時の確認範囲）

1. `publish-rss-import` は最初のShow公開を受付後、355秒弱でexit 1。CLIの正式RSS待機上限は300秒。Episode公開前に停止した。
2. 11:43:14 UTCのR2/CLI snapshot:
   - job status: `processing / validating`、ownership `held`
   - progress: `feed`、updated_at `2026-10-12T11:34:57Z`、purge未確認
   - Show: `draft`、feed generation 0、owner `processing`、execution_idあり
   - service: `open`、残留invocation 1
   - 公開先Show metadata、cover、feed、episode catalogはR2 REST GETで404
3. `system/jobs/<job>/dlq.json` が存在し、内容が当該 `staging/shows/otftalk-rss/<job>/commit.json` と完全一致。失敗用キューへの到達が確認できた。Queue本体をpull/ackしていない。
4. GraphQL Analyticsは既存tokenでHTTP 200:
   - 成功644 requests、例外2 requests、clientDisconnected 1 request（取得した188集計行）。
   - `scriptThrewException`: request timestamp `11:35:20Z`, `11:35:24Z`
   - `clientDisconnected`: request timestamp `11:34:29Z`
   - 追加照会で、3行とも同じ対象version、colo `SEA`、usage model `standard`。
   - これらの集計dimensionsにはjob IDとinvocation kindがない。例外2件を当該consumerの再試行と確定的に結び付けられない。`datetime` はrequest timestampであり、例外発生／終了時刻として扱わない。
   - 取得範囲に `exceededResources` / `internalError` はない。CPU時間超過を示す証拠はないが、実機のR2呼出回数や失敗本文は取得できていない。
5. Workers Logsの履歴照会は、公式の `POST /workers/observability/telemetry/query`、`dry: true`、対象Worker＋UTC 11:34〜11:36で1回だけ実施し、HTTP 403 / code 10000。設定／権限の変更や再試行はしていない。
   - このAPI拒否は**調査用履歴ログが取得できないこと**を意味し、公開処理がAPI token不足で失敗した証拠ではない。Worker consumerのR2アクセスはbindingで行われる。
   - 初回Show公開時にlive tailは接続していなかった。既存計画のtailは、36件公開後の性能比較jobのためのものだった。後からlive tailを接続しても過去の例外は取得できないため、無目的な長時間待機は行っていない。

## 停止位置と状態が残る仕組み

`src/publication-show-runner.ts`:

- 104行: `recordProgress("feed")` が保存済み。
- 次の105行: `overwrite(showKey, source)`。内部ではowner照合・配信gate・HEAD・条件付きPUT・再照合を行う（41〜68行）。
- 公開先metadataがないので、少なくともこの最初の出力は保存されていない。guard／HEAD／PUTのどれが止まったかは未確定。
- カタログ／feed generation更新は108行、3つの公開先出力書き込みの後であり、現在の耐久保存点より後。
- 通常のcatchは136〜145行でR2を再読しstatus `retrying`を保存する。この読み書き自体が失敗／中断すると、その保存も完了しない。

`src/publication-consumer.ts`:

- 48行: 残留execution_idがあれば `LifecycleExecutionBusy` をthrow。
- 55〜57行: catchから `releaseSettledExecution` を実行するが、これもR2アクセスを必要とする。
- 17〜28行: 明示requeueも同じexecution tokenが残れば拒否する。

`src/service-admission.ts`:

- 101〜108行: service invocationはfinallyで返却する。この返却にもR2 GET/CAS PUTが必要。

従って、失敗処理／返却処理まで完了できない中断が起きると、Show execution_idとservice invocationが残り、後続実行は安全のため進めない。経過時間だけで解除しない既存方針であり、今回も解除していない。

## ローカル模擬試験

`diagnostics/rss-fresh-r2-show-offline.ts` は各commitの既存fixtureと正式Queue routeを呼ぶ。`fetch`を禁止し、ネットワーク呼出0、実環境への変更0。2commit×3case、計6caseすべてassertion成功。

| case | 結果 |
| --- | --- |
| 正常 | 初回Show公開がpublished/finished、ownerなし、service invocation 0 |
| feed進捗保存直後の単発R2失敗 | retrying/feed、executionなし、invocation 0。同じjobの次のconsumerが成功 |
| feed保存後にR2が継続失敗（catch/finallyも失敗） | **processing/validating＋progress feed＋draft＋executionあり＋invocation 1＋公開先なし**。今回の実機状態を再現。R2復帰後も次のconsumerはexecution busyで拒否。DLQ処理はmarkerを保存するがowner/job状態を解除しない |

継続失敗の注入は**状態残留の仕組みを再現するための仮定**であり、実機でR2が継続失敗したと証明するものではない。

| source | 正常な空Show公開のR2呼出 | feed進捗保存までのR2呼出 | cache runtime / purge |
| --- | ---: | ---: | ---: |
| 4781fad | 316（GET288 / HEAD9 / PUT17 / list2） | 112 | 9 / 1 |
| a8c7e54 | 338（GET305 / HEAD9 / PUT20 / list4） | 113 | 9 / 1 |

実機停止点までの差は、カタログ不在確認GET 1回。カタログ構築による追加の書き込み等は停止点より後。模擬呼出数・mock成功は実機の時間／runtime制限内での成功を保証しない。アカウント設定の変更や無料／有料プランの切り替えはしていない。

`publication-show-runner.ts`, `publication-consumer.ts`, `lifecycle-consumer.ts`, `service-admission.ts`, `m6-routes.ts`, `lifecycle-worker-effects.ts` は4781fad→a8c7e54のdiffなし。状態残留の仕組みは前commitにも存在し、今回だけで性能改善による新規回帰とは断定できない。

## 調査helperの集計補正（製品変更なし）

- 最初のGraphQL helperは正常statusを `ok` と想定してしまい、`success`をnon_ok_rowsに含めた。原応答／旧summaryを保持し、追加通信なしで `graphql-corrected-summary.json` に正しい集計を保存。製品／実機操作には影響しない。
- 追加timing helperの初回summaryには `wallTime` の単位をmillisecondsと書いたが、取得したschemaは単位を明示していない。元summaryを保持し、後続の最終検査結果でこの単位記載を撤回する。raw値は保存し、秒／ミリ秒へ変換して性能比較に使わない。`cpuTimeUs` はschemaにmicrosecondsの記載あり。

## 当初の追加ログ依頼（Dashboard再exportで取得済み）

直接原因を確定するにはCloudflare DashboardのWorkers Logsで、次を確認する。

- Worker `castloop-rssperf-1012-r2-0f9dbe46`
- `2026-10-12 11:34〜11:36 UTC`（日本時間20:34〜20:36）
- Queue invocation、job `69a619df-9115-42e8-87db-e98947635863` の `publication_delivery` / `publication.consumer` と、最初の失敗の例外・終了outcome
- 再試行の例外がexecution busyか、最初の終了がどのI/O／runtime問題か

共有する場合はtoken・認証header・アカウントID・私有metadata等を除去する。Dashboard確認ができない場合は、別途承認のうえでlive tailを初回Show公開前から接続した別の隔離環境で再現試験する。今回のownerを手作業で消して再送する方法は採らない。

調査記録・模擬コードはローカル保存のみ。GitHub push／Issue作成は今回の依頼では実施していない。

## 主なエビデンス

- `snapshot-summary.json`: 最初のR2/CLI snapshot
- `dlq-summary.json`: 当該commitのDLQ marker一致
- `graphql-corrected-summary.json`: 正常／例外を補正した集計
- `graphql-schema-summary.json`: 利用可能dimensionsとfield説明
- `graphql-timing-summary.json`: 対象version/colo/CPU/raw wallTime（wallTime単位注記は撤回）
- `historical-logs-query.json`, `historical-logs-summary.json`: 履歴照会条件と403
- `offline-a8c7e54/summary.json`, `offline-4781fad/summary.json`: 6case、呼出数、状態
- `offline-*/{none,one-read-failure,persistent-io-failure}-calls.json`: 完全mockのR2呼出列
- `final-validation.json`, `final-r2-snapshot/`: 調査完了時の保全／耐久状態の再確認

`*-private.*` とサービス／Show controlには非公開情報や実行tokenが含まれる。未加工のままGitHubに保存しない。

## 追加: ユーザー取得のDashboard export解析

`logs-2026-10-12T12_06_15.809Z.json` をローカル解析（原本hash不変）。全2,000件は対象Workerだが、収録timestamp範囲はUTC **11:37:12.785〜12:05:25.480**（JST **20:37〜21:05**）で、必要なUTC **11:34〜11:36** のrecordは0件。Queue event、`publication.consumer`、`publication_delivery`、error level／非ok終了のinvocation記録はいずれも0件。

対象jobの構造化ログ70件はすべて `publication.status / success` で、公開状態の照会成功を表すだけ。公開処理自体の成功を意味しない。1,702件がspanであり、2,000件のexport上限で古いログが欠落した可能性があるが、ファイルだけからその仕様は確定できない。

したがって初回停止の直接原因は引き続き未確定。同じWorkerのUTC11:34〜11:36（JST20:34〜20:36）へ時間を絞り、必要ならspanを除外して再exportを依頼する。remote操作／再送／状態解除／GitHub共有なし。

追加記録: [dashboard-log-review/result.md](dashboard-log-review/result.md)、`dashboard-log-review/summary.json`、`dashboard-log-review/target-job-status-events.json`（allowlist70件）。

## 追加: 時間を絞った再exportに対象jobの失敗記録あり

`logs-2026-10-12T12_14_27.128Z.json` は1,757件、UTC11:34:00.095〜11:35:59.181で必要な時間帯を含む。各publication_deliveryとQueue invocation／例外を同じrequestIdで照合し、対象jobの3attemptを確認できた。

- 初回: UTC11:35:03.794に **canceled**、Queue invocation wall 34,982ms / CPU 146ms。consumer終了／service invocation返却の独自timingログなし。
- 再試行2・3: どちらも **Another invocation still owns this lifecycle execution** という例外。トークン残留による再試行拒否を実機ログで確認。両retryにはservice invocation返却成功ログあり。
- DLQ Queue invocationはUTC11:35:34.769にok終了。record単独にjob IDはなく、以前の当該commit一致R2 markerという別証拠と整合。

**初回canceledの理由そのものは、必要ログ有無の確認では未確定。** 同じexport内のspanを追加解析できる。原本hash不変、ローカル照合／allowlist保存のみでremote操作なし。

記録: [dashboard-targeted-review/result.md](dashboard-targeted-review/result.md)、`dashboard-targeted-review/summary.json`、`dashboard-targeted-review/target-job-queue-events.json`。
