# Dashboard export解析: 必要時間帯が含まれていない

## 結果

`logs-2026-10-12T12_06_15.809Z.json` は正常に解析できた。ただし **初回失敗の原因を確定するログは含まれていない**。

- 原本: 4,890,461 bytes、2,000 records。
- SHA-256: `c0eba5ea1b3144d2ba59c55ad44edf518f5836e607ee54679966fdc3b6952a44`
- 全件が対象Worker `castloop-rssperf-1012-r2-0f9dbe46` の記録。
- 収録範囲: **2026-10-12 11:37:12.785〜12:05:25.480 UTC**。
- 日本時間: **20:37:12.785〜21:05:25.480**。
- 必要範囲: **11:34〜11:36 UTC / 20:34〜20:36 JST**。該当record 0。
- Queue event 0、error levelまたは非ok終了のinvocation record 0。
- cf-worker-event 228、span 1,702、cf-worker 70。
- 対象jobの構造化ログ70件はすべて `worker_timing / publication.status / success`。
- `publication.consumer` と `publication_delivery` は0件。

`publication.status` のsuccessは **状態照会が成功したこと**を意味し、公開jobがpublishedになったことやconsumerが成功したことではない。既存のprocessing/held/DLQ判断を変更する材料ではない。

2,000件ちょうどで新しい時間帯だけが残っているため、exportの件数上限で古い失敗記録が含まれなかった可能性がある。ただしファイルだけからexport上限の仕様は確定できない。

## 次に必要なexport

同じWorkerで時間範囲を **2026-10-12 11:34:00〜11:36:00 UTC**（Dashboardが日本時間なら **20:34:00〜20:36:00**）へ絞る。

大量のspanがログを押し出さないよう、必要なら **typeがspanのレコードを除外**し、invocation log・console log・例外を残してexportする。Queue invocationとその関連ログがあれば、最初の失敗のoutcome／例外と、後続2回の実行がexecution busyだったかを照合できる。

今回の解析はローカルのみ、原本hash不変、remote照会／再送／deploy／解除／権限変更なし。元exportには非公開アカウント／リクエスト情報が含まれる可能性があるため、未加工のままGitHubへpushしない。原本を複製せず、安全な集計と対象jobのallowlistログのみをここへ保存した。
