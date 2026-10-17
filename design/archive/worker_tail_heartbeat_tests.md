# Worker tail heartbeat試験の時間依存性（Issue #29）

## 対象と結論

[Issue #29](https://github.com/simosako/castloop-v2/issues/29)は、Bun 1.4.2のCIで
`scripts/test-support/worker-tail.test.ts`のnative ping/pong試験が一度
`tail_pong_timeout`になり、同一commitの再実行では成功した問題。
schema version 1の公開処理そのものではない。採取helperはSQLite用の
`startSqliteTrialTail`からも使用される。

旧試験はheartbeatを10ms間隔で動かし、50msの固定sleep後にhealthだけを確認していた。
収集器はping送信後の次のtickまでに一致するpongを処理できなければ失敗するため、
この設定はnative socketの配送・event loop処理にも10msの上限を課していた。
さらに、試験自体はping送信やpong受信の件数を確認していなかった。

送信直後のevent loop停止により、localhostの正常なserverでも同じ失敗を再現できた。
ただし、**元のCI失敗時の停止・配送順序を特定したものではない**。
CIにはping/pongの時刻がなく、Bunの不具合やPR #27の管理者キー照合変更との因果関係は確定していない。

## 2026-10-17のローカル調査

変更前のcommitは`862c8ddf845914b32057d3b55d9b55614c33e38a`。
Linux x64、Bun `1.4.2 (744846f84)`で、CIと同じ
`pingIntervalMs: 10`、`registryIntervalMs: 20`、接続後50ms待機を使用した。
Cloudflareへは接続していない。

| 条件 | 回数 | `tail_pong_timeout` |
| --- | ---: | ---: |
| 通常のlocalhost疎通 | 200 | 0 |
| 接続後8msのtimerで25ms同期停止（最初のpingより前） | 200 | 0 |
| 各ping送信直後に25ms同期停止 | 200 | 200 |

停止条件はsocket adapterの`ping`内で、native `socket.ping(data)`の直後に
次の処理を追加したもの。frameの破棄やserverの停止は行っていない。

```ts
const until = performance.now() + 25;
while (performance.now() < until) {}
```

3番目の条件の最初の観測（接続開始からの単調時計、ms）：

| イベント | 時刻 |
| --- | ---: |
| ping送信 | 31.45 |
| 同期停止終了 | 56.59 |
| `tail_pong_timeout`記録 | 58.52 |
| native pong受信 | 58.86 |

pongを処理できる前に期限判定が走る順序を確認した。
通常条件や送信前停止で成功しても、送信後の遅延に対する10ms制約は検証できない。
変更前の単独suiteは13 pass、全suiteは1267 pass / 0 fail（139 files）だった。
元のCIの1261 pass / 1 failとはcheckoutが異なり、この成功を原因確定やCI解消の証明とはしない。

## 修正した試験の責務

### 収集器のstate machine

Bunの仮想timerで既存の`startWorkerTail`を実行し、実時間のsleepを使わず次を確認する。

- 最初の10ms前はpingなし。10msごとのtickでpingを送る。
- 一致する同期pong、および次のtick直前に届く非同期pongで継続できる。
- 無関係なpongや通常のinvocation frameは未応答pingを満たさない。
- 応答なしなら次のtickで`tail_pong_timeout`。遅いpongでもfailureは回復せず、
  `complete: false`と次の操作の拒否を維持する。稼働中mutationの停止やsocketの自動closeはしない。
- 明示stopは未応答pingがあってもtimerを解除する。既に記録した欠測はstopでも消えない。

仮想timerは各試験後に必ず解除する。これは収集器の期限判定の試験であり、native配送の速度測定ではない。

### Native Bunのcontrol frame疎通

仮想timerや収集器の10ms期限から独立させ、実際の`Bun.serve`とnative `WebSocket`を接続する。
各pingについてserverのping受信とclientの一致するpong受信を確認し、3往復を必須にする。
固定sleepや、単にhealthが失敗していないことを成功条件にはしない。
遅延なし／送信直後25ms同期停止の両方を試験する。

接続・各pong待機には実timerの2秒watchdogを設け、未受信なら失敗する。
このwatchdogは疎通試験の停止上限であり、収集器のpong期限を延長するものではない。
期限切れの診断には固定イベント名と経過msだけを含め、URL・frame本文・例外本文は保存しない。
開始や受信に失敗した場合もsocketとserverを`finally`で終了する。

`worker-tail.ts`の実装・既定10秒間隔・期限切れのsticky failure・安全条件は変更しない。
Native疎通試験の成功は、collector全体の実時間性能、Cloudflareの配送完全性、
DOログの欠測解消を意味しない。必要なprobe/jobのcoverage照合は引き続き別に行う。

## Issueのクローズ判断

元のCI失敗時にはping/pongの時刻・処理順序が記録されておらず、
今回の遅延再現と同一原因だったかを、残る証跡からこれ以上判別することはできない。
この点の追加追及はいったん終了し、期限判定とnative疎通を分離した試験修正をmainへ取り込んだうえで、
Issue #29をいったんクローズする方針とした。

これは元のCI失敗の根本原因が確定したという判断ではない。
収集器の欠測検知は緩和せず、再発した場合は新しい診断・実行条件を基に改めて調査する。

## 検証コマンド

```sh
bun test scripts/test-support/worker-tail.test.ts
bun test scripts/test-support/worker-tail.test.ts --rerun-each=100
bun test
npm run check
```

修正後の単独suiteは16 pass、100回反復は1600 pass / 0 fail。
全suiteは1270 pass / 0 fail（139 files）、`npm run check`と`git diff --check`も成功した。
このローカル調査では元のGitHub Actionsの再実行やライブ環境の操作は実施していない。
