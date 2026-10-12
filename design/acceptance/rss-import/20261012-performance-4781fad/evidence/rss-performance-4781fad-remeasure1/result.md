# 4781fad 性能再測定1 — 完了・公開consumerの短縮を確認

## 結論

前回と同じ36件のShow、同じEpisodeの同一metadata-only公開を1job測定し、CLIの `published / released` 観測、service invocation解放、consumer終了ログ取得、公開内容/元入力の不変確認まで完了した。

**今回の1標本では公開consumerが96.179秒→73.978秒（22.201秒、23.08%短縮）。** guard合計は26.949秒→12.543秒（53.46%短縮）、progress/status保存と検証は16.831秒→12.025秒（28.55%短縮）。不変request・予約の再利用とguard整理を行った区間で短縮が観測され、今回の改善方針と整合する。

未改修のGUID検査・feed入力読取・staging finishはほぼ同程度のままで、次の改善対象として残る。各version1標本であり、CPU profile/実機R2 GET数の比較/全音源付き移行/標準120秒待機の受け入れを完了したとは扱わない。

## 実行識別と手順

- source/CLI/Worker commit: `4781fadbbd8a7b5dd1d4957024b165d774e7e2c1`（製品source無改変）。
- CLI: `bin/castloop-linux-x64-4781fad`。
- SHA-256: `10caeff112769710cc8315548fe671ac592e69060db84d92219ae613cc8c25ce`。
- Worker version: `6d3d011d-e720-42b6-80b0-41f2830128ff`。初回の正式更新済みWorkerを維持し、不要な再build/deployは実施せず、開始/終了時の同一versionを確認。
- 初回build検証は `../rss-performance-4781fad/`：型検査/build成功、971 pass / 0 fail / 110 files。今回変更したのは計測helperのみ、6つのローカルunit test成功。
- workspace: `workspaces/rss-20261012-run1`、service `rsstest-1012-r1`、Show `otftalk-rss`（36件）。
- Episode: `ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915`。
- 今回job: `9a8c5969-f676-4a04-8b87-e6948628bf97`。
- 初回job `ad3884c2-8aac-4486-b7d1-eaeb32212cd2` は開始前にCLIでpublished/released確認済み。初回記録は保持し、同じcommit要求の再送ではなく、許可された同一metadataの新規正常更新を1回実施。
- 比較baseline: `../rss-local-timing-20261012/`、a19efb4、job `5798a64d-7e25-420e-907d-411d931cdee6`。

## 主な比較

| 区間 | a19efb4 | 4781fad再測定 | 変化 |
| --- | ---: | ---: | ---: |
| consumer（同じservice acquire開始→release終了境界） | 96.179秒 | 73.978秒 | **23.08%短縮** |
| guard合計（双方8回） | 26.949秒 | 12.543秒 | **53.46%短縮** |
| progress/status保存・検証合計 | 16.831秒 | 12.025秒 | **28.55%短縮** |
| staging証跡検証 | 3.911秒 | 3.049秒 | 22.04%短縮 |
| GUID検査 | 7.566秒 | 7.617秒 | 0.051秒増 |
| feed入力・音源HEAD | 20.616秒 | 21.400秒 | 0.784秒増 |
| purge（その内部の安全確認込み） | 2.070秒 | 1.077秒 | 47.97%短縮 |
| Show owner解放 | 1.910秒 | 1.785秒 | 6.54%短縮 |
| service invocation解放 | 0.870秒 | 0.730秒 | 16.09%短縮 |
| metadata staging CLI全体 | 31.649秒 | 33.444秒 | 1.796秒増 |
| 公開受付CLI全体 | 10.805秒 | 10.440秒 | 0.365秒短縮 |
| 公開受付CLI戻り→published/released観測 | 96.785秒 | 75.635秒 | **21.85%短縮** |
| staging開始→published/released観測（全体） | 139.239秒 | 119.520秒 | **14.16%短縮** |

前回のroot全体96.727秒にはroute/setup/readiness前処理0.548秒が含まれる。今回の正式 `publication.consumer` はその前処理を含まないため、前回traceのservice acquire開始からrelease終了までを取り直した96.179秒で比較した。consumer全体とその内部phaseは重なるため、この表を単純加算しない。CLIの照会時間もconsumerと並行するため加算しない。

## Worker Logsの詳細

正式Workers LogsをTail APIでライブ取得し、174 invocationのallowlist証跡を保存。認証header/任意例外本文/素材/URLは保存せず、Workerログ設定・権限も変更しない。今回はconsumer終了ログ取得後に今回のtail sessionだけ閉じた（DELETE HTTP200）。

- 対象consumerログは1 invocation、outcome=ok、exception_count=0。内部公開phaseはすべてsuccess。
- `publication_delivery` は1件、attempts=1。取得した範囲では配送再試行なし。
- message timestamp 07:45:47.081Z → deliveryログ/consumer開始07:45:48.541Z、約1.460秒。新deliveryログはroute/readiness後なので、前回root開始までの940msと純粋なQueue転送時間として直接比較しない。
- consumer 07:45:48.541Z → 07:47:02.519Z、73.978秒。
- CLIは07:47:03.466Zにpublished/releasedを観測（consumer終了から約0.947秒）。これは跨る時計による近似値。
- guard 8回、平均1.568秒、最小1.472秒、最大1.722秒。前回平均3.369秒。
- progress finished保存完了→service解放まで4.906秒（前回6.005秒）。finishedだけで次の公開へ進まない条件は維持。
- history/current metadata/feed PUTの正式phaseはそれぞれ0.556秒、0.603秒、0.622秒。これらはPUTだけの区間であり、周囲のguard/CAS準備等を含む旧集計へ直接対応させない。
- metadata-onlyのためaudio phaseは0ms（既存音源再利用のearly return）。実音源コピーが0msという意味ではない。

CLI状態照会は39回、1 command平均0.964秒、計37.611秒と間の1秒sleep。36回目（index35）で `publication_status_changed` を1回確認し、厳密なreason判定後に読み取りだけ再照会して完了した。対応する管理phaseのoutcome=error 1件は既知の照会競合として別扱いで、consumerの失敗/再送ではない。変更POST/PUTは再送していない。

## 残る時間

- feed入力21.400秒とGUID検査7.617秒は合計約29秒の互いに別の区間で、全Episode読取は今回未改修。
- staging finishは正式ログ14.295秒。前回の管理fetch全体14.270秒とは前処理境界が少し異なるが、短縮は見られない。metadata staging全体も約33秒のまま。
- 不変記録再利用の実機GET数は今回は未計測。開発docsのmock GET 269→141を、前回実機484操作や今回実機操作数へ置き換えない。
- 改修したguard/progress/status区間は明確に短くなった一方、ネットワーク/配置/負荷が同一だった保証はない。性能の恒常性や改善率の統計的確定には追加標本が必要だが、このタスクでは許可された追加1jobだけを測定し、さらなる公開は実施しない。

## 最終状態・制限

- published/releasedをCLIで検証、service open/drained、全Show未完了なし、独自domain設定/connection整合・未完了local domain operationなし。
- Feed byte一致、metadataはrevision_id/updated_at以外一致、元入力/completed cursor/全ローカルTOML/設定hash一致。新revision/control generationは正常な更新として保持。
- DNSは1.1.1.1明示とcurl --resolveを利用しTLS検証有効。OS/routerのDNS設定は変更しない。
- 改善済み4781fad Workerを保持。旧環境/旧ホスト/音源/初回停止記録/診断用R2記録は削除していない。
- Workerの時計はI/Oで進むため、時間はwall/I/O checkpointでありCPU profileや純R2サーバー時間ではない。
- 暫定300秒待機の延長は性能改善に数えない。今回の公開待機は75.635秒で120秒未満だったが、前回同条件も120秒未満であり、元の音源付き移行で発生した120秒超過を再現/解消確認した試験ではない。
- 完成済みimportの再実行や全36件再公開、音源upload/copy、本番release受け入れは今回実施しない。
- GitHub commit/push/Issue追記は本タスクでは行っていない。私有backup/metadata/Feed/management応答を無検査で公開しない。

主な証跡: `performance-comparison.json`（全phase比較/概要）、`measurement-validation.json`（全体時間/version同一確認）、`worker-logs.jsonl`（ログ原本allowlist）、`preservation.json`、`previous-job-confirmed.json`、`completion.json`、`measured-poll-035.retry.json`、`tail-closed.json`、`harness-source/`。
