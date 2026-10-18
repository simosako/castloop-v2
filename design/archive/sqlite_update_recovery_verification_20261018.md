# Issue #11: SQLite更新のGET故障注入・実機検証

2026-10-18 JST。管理者が、提示した最小限の実機確認を新しいCloudflareサービスで実施することを明示承認した。
PR [#37](https://github.com/simosako/castloop-v2/pull/37)の修正commit `40368740de0f4b8b4ca2e5f9bdb0c253dbbde113`を無改変で検証した。
mainのmerge commitは`f0831b76e2165e04297e6d608edf9904d6f60abf`。対象の製品code差分はない。

## 対象と承認境界

- 新規SQLite service: `i11-d79c5c96`。
- Worker: `castloop-i11-d79c5c96-666dda97`。private R2 bucket: `castloop-i11-d79c5c96`。
- 新規DO namespace: `0466db75cdd64947842a2853e60f3ec9`。初期化と2回の更新で同一namespaceを確認した。
- fresh init、同じ組み込みcodeの互換更新2回、送信前のGET失敗注入と明示検証続行だけを実施した。
- 既存の保持サービス`sq16r-6ec01dc6`には要求を送っていない。resume、Show/Episode登録・公開、domain/DNS、削除、権限・課金・CPU設定変更は行っていない。
- 新規環境とローカル原本を保持する。今回の承認は後続の公開・更新・cleanupの許可ではない。

## 試験方法と証拠

新規導入はbuild済みLinux単体CLIの正式`init --publication-protocol sqlite-sequential-v1`で1回だけ実行した。
そのinit journalのsource hashを、同じBun build条件で固定したWorker sourceと照合した。
元の組み込みsource SHA-256は`a254eb022c517ecdb4b34132542c893e94f3f7bba92df6874e85026295ae7286`。

故障注入は製品sourceを改変せず、正式`runSqliteCommand`に渡す試験用transportで行った。
Cloudflare設定・R2・DO・Alarm・cache/purgeは実環境を使用し、選択したGETだけを**送信前に**失敗させた。
未知のPUT/activationを実環境へ意図的に残す試験ではない。
変更要求は対象WorkerのPUTと、同じoperationのupdate-prepare/update-activateだけに制限し、要求前phase・source hash・namespace・各要求1回をguardした。
最終状態は単体CLIの正式`service-status`と、別processのREST/runtime読み取りで再確認した。
故障注入付きの単体CLI entrypoint全体の実証と、正式command runnerの実証は区別する。

非公開証跡は`.local-test-data/results/20261018/i11-d79c5c96/`。
計51ファイルをhash manifestへ記録した。manifest SHA-256は`9b5c270b4103e177eca0a58bc3f71ed2b975ceb981058edb8c118527d08d7c03`。
raw設定・鍵・元journal・operation ID・要求記録はgit-ignored領域に保持し、本書へコピーしない。
試験launcherのimport相対pathと型検査設定の修正はlive変更前に行い、製品sourceの不具合とは数えない。

## 結果

時刻はUTC（JSTは+9時間）。

| 確認 | 観測・結果 |
| --- | --- |
| 新規導入 | 単体CLI exit 0。ready/paused/drained、固定source一致 |
| 1回目PUT後のdeployments GET失敗 | 23:07:52.737、`deploy_acknowledged`と成功応答ETagをGET送信前に保存済み |
| 同じ更新のsettings GET失敗 | 23:07:53.385、再配備せず`deployed`と固定version/deployment receiptを保存済み |
| 停止中のreadiness | 両checkpointでpublication_ready=false、paused/drained。activation未要求 |
| 最初の検証続行 | REST照合は成功して`verified`。DOが旧versionを返すため120回の有限GET待機で23:09:56に停止。成功には数えず原結果を保持 |
| 追加のGET-only照合 | 23:11:09.590に記録済み新versionと正確なprepared要求を確認。配備再送なし |
| 1回目の初回activation | 明示verifyで23:11:12.798に1回だけ送信。その後native probe/setup完了、ready/paused/drained |
| 同じ組み込みcodeの2回目更新 | 新operationで準備・PUTを各1回実行。こちらもnative旧versionの有限待機で一度停止し、GET-onlyで新versionを確認した後、明示verifyで初回activationだけを実施 |
| 2回目の新version一致・activation | 23:13:38.205に一致、23:13:40.957にactivation 1回。23:13:45.619に検証完了 |
| 最終の独立した読取確認 | 単体CLI exit 0、publication_ready=true、paused、drained=true、active=null、queued=0、runtime update completed、setup ready。REST/DO version一致、元namespace一致 |

2回の更新について、要求記録の変更要求はそれぞれ次の3件だけだった。

| 更新 | update-prepare POST | Worker script PUT | update-activate POST |
| --- | ---: | ---: | ---: |
| GET故障注入を挟む1回目 | 1 | 1 | 1 |
| 同じ組み込みcodeの2回目 | 1 | 1 | 1 |

初期導入時のresource作成・配備・setupは別であり、この更新要求数には含めない。
停止・明示続行を挟んでも、最初の成功応答ETagと固定receiptは完了時まで不変だった。

### 実APIのETag区別

同じ元sourceから、製品が更新operation固有のコメントを付けた2つのscriptについて、実PUT応答とversion GETのETagが一致することを既存inspectionで確認した。

- 1回目: `b4b880631ac10abc276c07324864dc639f7f3e066449dab40938f6b8d8ea0c5b`
- 2回目: `a1fa57fc2beaa12b866a082aa12006f6b9f27c91a63d4155327d237bc1f54b52`

実APIでも異なるETagを得た。ETagがCLIのSHA-256と同じalgorithmであるとは仮定せず、opaqueな応答値の完全一致として扱った。

## 判定と残る制限

**承認された機能確認は通過した。** 配備後のGET故障注入から、未知要求の再送なしで明示検証を続行し、native readinessまで完了できた。
関連ローカル3ファイルも再実行して55 pass / 0 fail。private runnerの型検査も成功した。

- native rolloutの待機上限に1回目・2回目とも到達したことは隠さない。元processは再起動せず、`verified`・未activationと現在の正確なprepared要求を確認して別の明示続行を行った。
- [Cloudflareのknown issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)はWorker/DO更新のeventual consistencyを説明しているが、今回の反映時刻全体・遅延原因の確定ではない。
- 公開コンテンツ投入は0件。CPU/tail/Alarmイベントの完全収録、性能、全Free適合、300MB公開、恒久的なIssue #13解消は測定していない。
- 元のQueue/R2障害のGET timeout原因を確定した試験ではない。証拠不足の旧upload-only journal、未知PUT・要求済みactivationの再送、blockedの強制解放は引き続き対象外。
- この証拠は、#11を「確認済み更新を安全に続行できること」の修正としてcloseする根拠になる。旧journalの救済や全timeout根絶をclose条件に含めるなら、その条件までは満たしていない。Issueのclose・release・追加配備は本試験では行っていない。
