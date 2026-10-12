# 単一公開ジョブの精密計測（local-only、2026-10-12）

## 結論

この1件ではQueueの長い滞留やキャッシュ無効化ではなく、Worker内の大量のR2往復が時間の主因だった。公開consumerは96.727秒、R2 binding操作は484回。GETだけで419回あり、そのawait計測区間の合計は78.467秒。同じShow control・凍結request・Show reservationを繰り返し読む構造が大きい。

今回の公開待機は約96.8秒で終了し、120秒超過自体は再現していない。以前の標準120秒CLIの停止とは区別する。音源を伴わない更新だけでこの所要時間であり、初回公開の追加処理やI/O変動に対する余裕が小さいことは確認できた。

## 条件と保持

- base commit a19efb4。別detached worktreeにCLI/Worker計測コードを追加。source/binaryのcommit/pushなし。
- CLI/Workerに安全確認の省略・並列化・retry変更・強制解除なし。TypeScript check/build成功、967 pass / 0 fail、109 test files。
- rsstest-1012-r1 / otftalk-rss、公開済み36件がある状態。同一メタデータを1件だけupdate-episode→publish-episode（MP3引数なし）で再公開。
- 新revisionと管理generationは追加。旧revision・音源は削除/上書きしていない。新しい音源コピーや音源URL変更なし。
- 変更前後のFeedはbyte同一。current metadataはrevision_id/updated_atを除いて同一。元import completed cursor・全入力・ローカルTOMLのhash不変。
- 計測後は正式pause/drain→deploy/verified→resumeで無計測a19efb4 Workerへ復帰。最終service open / invocations=[]、Show未完了なし、domain configuration/connections一致、local_operations=[]。
- private R2の`system/diagnostics/local-timing/20261012-one-job/`に保存した診断JSONは保持。本文や認証情報は計測ログへ入れず、時刻・操作名・object key・配送ID等を記録。

## 全体の時間軸

| 区間 | 時間 |
| --- | ---: |
| CLI update-episode（metadata staging） | 31.649秒 |
| CLI publish-episode（受付/commitまで、完了待機なし） | 10.805秒 |
| Queue message timestamp→consumer開始 | 約0.940秒 |
| commit marker PUT応答→consumer開始 | 約0.770秒 |
| consumer開始→終了（service invocation解放まで） | 96.727秒 |
| publish-episode応答後→CLI published/released確認 | 約96.785秒 |
| finished progress保存後→service invocation解放 | 6.005秒 |

Queueは1配送、attempts=1、retryなし。管理APIのcommit処理末尾とQueue処理は少し重なるため、全区間を無条件に合算しない。Worker間/PCとの時刻差を用いる区間はclock skewを含み得る近似値。

最後の6.005秒はpublished status書込み3.225秒、Show owner解放1.910秒、service invocation解放0.870秒。finished progressは完了照会の成功条件そのものではない。CLIのpublished/released確認はShow所有権解放を見ており、service invocation返却より先に観測されることもある。

## Consumer内訳（重複加算を除いた処理区間）

| 処理区間 | 時間 |
| --- | ---: |
| runnerのguard 8回（152 R2操作） | 26.949秒 |
| RSS再生成用の全Episode入力読取・音源HEAD検査 | 20.616秒 |
| progress/status保存とその所有権確認 | 16.831秒 |
| その他の検証・履歴/current metadata/feed出力等 | 9.904秒 |
| GUID重複検査 | 7.566秒 |
| Queue準備・consumer前後の処理 | 6.970秒 |
| staging証跡の検証 | 3.911秒 |
| purge（前後のguard込み） | 2.070秒 |
| Show ownerの最終解放 | 1.910秒 |
| 音源persist | 今回は対象外（metadata-onlyで即return） |
| **合計** | **96.727秒** |

cache.invalidate RPC単独は0.173秒（purge 2.070秒の内数）。キャッシュ無効化だけで数十秒かかった状況ではない。

GUID検査は既存metadataを逐次読む。RSS用入力読取では各Episodeのlifecycle/current metadataに加え、各音源の存在・サイズHEAD確認も逐次行う。RSS XML文字列のrenderだけが20秒かかったという意味ではない。

## R2操作（consumerのみ。CLI管理API・pollの操作を含めない）

| 操作 | 回数 | 平均await計測時間 | 合計await計測時間 |
| --- | ---: | ---: | ---: |
| GET | 419 | 187.272ms | 78.467秒 |
| HEAD | 45 | 170.044ms | 7.652秒 |
| PUT | 17 | 583.118ms | 9.913秒 |
| LIST | 3 | 230.667ms | 0.692秒 |

本文text/json/arrayBufferの呼出は上記484操作とは別集計。Promise.allで重なる操作時間をunionで集計すると、R2 await/本文読取の計測区間は96.554秒（consumer計測時間の約99.8%）。純粋なCloudflareストレージ内部の処理時間やCPU占有率と解釈しない。

### 同じrecordのGET再読取

| record | GET回数 | 合計await計測時間 |
| --- | ---: | ---: |
| Show control | 80 | 14.500秒 |
| 凍結したjob request.toml | 79 | 14.095秒 |
| Show reservation | 77 | 13.563秒 |
| service admission | 23 | 4.492秒 |

最初の3種類だけで236 GET / 42.158秒。これは上記処理区間表と別の切り口であり、guard等の時間にさらに足さない。

`requireShowExecution`→`requireOwnedOperation`がShow control/reservation/requestを読み、`requireOwnedPublication`等も同じ確認を使う。progress/statusを書くだけでも所有権確認が複数回ある。この合成で大量の逐次I/Oが生じる。

参照: `src/lifecycle-control.ts:148-163,193-199`、`src/show-reservation-record.ts:14-18`、`src/lifecycle-job-store.ts:52-100`、`src/publication-episode-runner.ts`、`src/lifecycle-feed.ts:118-157`。

## Metadata stagingの内訳

CLI HTTP往復は10回、そのうち管理Workerは8回で合計297 R2操作。

| 区間（CLIからの往復） | 時間 |
| --- | ---: |
| target照会 | 1.487秒 |
| claim | 4.772秒 |
| begin | 2.682秒 |
| REST metadata PUT | 1.015秒 |
| REST metadata GET | 0.805秒 |
| status 3回 | 2.712秒 |
| settle | 3.422秒 |
| finish | 14.302秒 |
| HTTP計測区間外のCLI処理等 | 0.451秒 |

metadata GET後の本文hash確認はCLI計測で約0.313ms。finish管理処理だけで139 R2操作 / Worker内14.270秒。この小さなmetadataのstagingが約30秒かかる理由も、転送容量ではなく状態管理・検証のI/O累積として説明できる。

管理Workerのstaging中GET平均は89.768ms、Queue consumerのGET平均は187.272ms。経路/実行環境に差があることは測れたが、実行拠点・R2配置・距離・負荷のどれが理由かは未確定。

公開中のstatus照会は48回。HTTP平均965ms、照会Worker内平均872ms。照会と1秒sleepが繰り返されるため、確認間隔は概ね2秒。この照会時間はconsumerと並行するので96.727秒に加算しない。

## 測定の限界と改善検討の優先順

1. 同一の不変request/reservation等の再読取を減らせるか、安全条件を明示して検討する。現在owner/generationの確認を単に省略する変更は行っていない。
2. GUID検査/RSS全件読取の直列構造を検討する。全件移行で件数に応じて読み取りが累積する。ただし一貫性/上限/所有権の設計が必要。
3. staging finishの139操作など、control/progress/status処理の確認の重複を検討する。
4. Queue consumerと管理WorkerのR2レイテンシ差を次に調べる場合は、実行拠点等を別途計測する。今回のQueue待ち0.94秒だけを根拠に過去全jobのQueue待ちまで断定しない。

- WorkerのDate.now/performance.nowはI/Oで進む時計。wall/I/O区間の計測であり、CPU時間や同期render時間の精密profileではない。0msをCPU使用ゼロと解釈しない。計測値にはI/O完了時のclock更新による帰属の限界がある。
- metadata-onlyの1sample。新音源のアップロード/readback/immutable copyは今回測っていない。通常buildの120秒timeoutを再現する負荷試験や改善版との比較実験でもない。
- 一時的なWorker計測コードの導入・復帰に正式更新journalを追加したが、recordの巻き戻しはしていない。
- 最初の計測helperの引数誤りは54msでCLIに拒否され、remote操作前に停止。失敗記録を保持し、ユーザーの続行承認後にShow-directoryのCLI仕様へ修正して実施。

## エビデンス

- `timing-analysis.json`：全体/各HTTP/各Worker span/R2 method/categoryの分析。
- `detailed-breakdown.json`：重複しない処理区間・同じrecordのGET回数・staging内訳。
- `queue-*.json`：Queue invocationの時刻/個別R2操作/親子span（setup probeと計測公開の2件）。
- `measured-*.timing.jsonl`：CLIの個別HTTP/Worker計測header/本文hash時間。
- `preservation.json`、`final-state.json`：内容保持と標準Worker復帰の確認。
- `build-identity.json`、`local-only-source/`：ローカル計測binary識別とsource snapshot。GitHubへpushしない。
- `before/after-*-private.*`、`private-workspace-backup/`：原本。素材/メール/秘密の可能性があり、そのまま公開しない。
- `test-plan-rss-local-timing.md`、`diagnostics/rss-local-timing*.py`、`test-20261012.log`。

今回の記録はローカルのみ。GitHub branch/Issue追記は実施していない。
