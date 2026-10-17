# 通常規模36件の連続公開・性能測定

2026-10-15。管理者から、本番サイズ想定の36エピソード公開と性能測定を指示された。
結果を見て次の改善を判断する。新しい製品最適化はこの試験に混ぜない。

## 実施計画

- 最新実装 `db87bb4`、文書込みHEAD `e8e6f1e` のLinuxバイナリを凍結する。
  既に配備したWorker `3d7d8433-3c4b-44a8-8276-e85e5f0a1e42` を使用し、再配備しない。
- 対象は隔離サービス `i13-bc656f35` の `otftalk-normal` のみ。
  他の保持環境、権限、課金、CPU設定、資源構成は変更しない。
- 公開済み36件を各1回、正式CLIの `update-episode` → 明示的な `publish-episode` で逐次再公開する。
  元のローカルmetadataを使い、既存の不変音源を再利用する。新規MP3 PUTは0 bytes。
  **0→36件の新規取り込み、MP3アップロード性能、件数増加に対するスケーリングの試験ではない。**
- 開始時に36件のcurrent revision、local TOML hash、GUID/公開日時/音源identity、runtime/Queue設定を保存する。
  不明なjournal/lock/ownerやruntime不一致があれば、新規mutation前に停止する。
- tmuxの独立process groupで実行する。CLI終了・公開結果・所有IOのsettlementを待ち、1件ごとにcheckpointを保存する。
  観測tailは6件単位で接続し直し、次の操作前に有効期間とhealthを確認する。
- 各件の署名済みR2結果を確認し、current revisionの更新、音源URL/length/SHA/durationとGUID/日時の維持、
  Showの現在ownerなし、service invocation registryの安定した空snapshotを照合する。
  snapshotをglobal Queue backlogなしや旧IO回復権限の根拠にしない。

## 測定・停止条件

- Cloudflare live tailのinvocation全体 `cpuTime` / `wallTime` を保存する。
  Queueのstage-start / upload-complete / publishは正確なrequest ID、job IDと照合する。
  アプリ内phase timerやCLI wallとCPU時間を混同しない。
- CLIのstaging所要時間、publish要求からpublishedまで、1件の総所要時間、全体時間を分けて記録する。
- 公開後にfeedの36件維持を確認する。feed GETは非秘密の `X-Castloop-Probe` でroot eventと照合する。
  最後にfeed反復GET、代表音源のHEAD/Rangeを確認する。内部cache-owner CPUも別invocationとして報告する。
- socket healthと要求単位のCPU収録率は別に集計する。欠落を0ms扱いせず、成功mutationを計測のため再実行しない。
- Queue結果がunknown/failed/blocked、CLI異常終了、残留owner/token、tail異常、主要Queue CPU未収録では、
  所有中のCLI/IOが終わった後で後続mutationを停止する。公開status待機は既存の最大300回・5分を維持する。
- 未知要求の再送、HTTP fallback、token強制返却、環境削除はしない。

証跡・元metadata・音源・鍵・journal・rawログは `.local-test-data/` に保存し、Git/GitHubには追加しない。
Issue #13の恒久解消や全HTTPのFree適合を事前に宣言しない。

## 実行結果：29件完了、30件目の事前照合で停止

- 証跡：`.local-test-data/results/20261015/normal36-6c4e56fb/`（Git管理外）。
- tmux起動09:27 UTC、10:55 UTCにCLI exit 1を確認して安全停止した。
  36件のうち29件がpublishedまで完了。残り7件は公開していない。
- 30件目の `update-episode` は9.124秒で `Private R2 management record was not verified` と終了した。
  OpenCodeによる強制終了ではなく、CLIがR2 REST応答を検証できなかった経路である。
  当時のHTTP status/ETag等を記録していないため、API一時障害・制限等の原因は確定できない。
- 停止対象のlocal draftは以前の公開済みjobのままfrozen、lockなし。
  現在revisionも同じ旧jobだった。ソース上の事前target照合から新規stagingへ進む前の停止と整合する。
  自動再送や強制解除は行っていない。
- 成功29件の主要Queue commandは87/87件のCPUを照合できた。全34 feed GETも要求とCPUを照合した。
  tailのhealthは正常終了、収録されたWorker例外・異常outcome・truncation・管理HTTPは0。
- 各公開でGUID/公開日時、不変音源のURL/length/duration/SHAと旧revisionの維持、feed 36件を確認した。
  MP3追加PUTは0 bytes。最終反復feed GET 30件と代表音源HEAD/Rangeは停止により未実施。

### 暫定性能

Cloudflare tailのinvocation全体CPU、単位ms。QueueとHTTPは別invocationであり合算しない。

| 対象 | n | CPU中央値 | p95 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| Queue stage-start | 29 | 66 | 115 | 122 |
| Queue upload-complete | 29 | 114 | 164 | 164 |
| Queue publish | 29 | 214 | 310 | 325 |
| 公開後のroot feed GET | 29 | 4 | 5 | 6 |
| 内部/cache-owner HTTP | 30 | 2 | 5 | 6 |

開始前のroot feed GET 5件は中央値4ms、最大7ms。
1件のCLI staging→publishedは中央値170.759秒、最大186.142秒。
staging中央値87.596秒、publish要求開始→published確認は83.632秒だった。
CPUと待機を含むwallは別物で、公開の総時間が短縮したとは主張しない。

14:24 UTCのread-only再確認では同じWorker/open、service invocation 0、両Showの現在ownerなしだった。
停止対象のtarget照合もこの時点では成功した。これを当時のAPI失敗理由やglobal backlogなしの証明にはしない。
tmuxは終了し、再開していない。

**Issue #13のWorker freezeは完了29件では観測しなかったが、36件試験は未完了。**
次はR2読取失敗のHTTP status等を秘密情報なしで記録できるようにして原因を区別し、
未知送信の再実行と混同しない形で未開始の残り7件を試験することを検討する。
この結果のみで全HTTPの10ms達成やIssue #13の恒久解消は宣言しない。
