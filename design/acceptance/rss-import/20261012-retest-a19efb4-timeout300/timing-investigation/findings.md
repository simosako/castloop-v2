# RSS公開所要時間調査（暫定、履歴traceの認証で停止）

## 実測

保持した私有journalのcreated_at/mtimeと、読み取り取得したR2 progress.updated_atを照合。今回公開した6〜18件目の13 jobを対象とする。

| 区間 | 平均 | 範囲 |
| --- | ---: | ---: |
| Episode metadata staging開始記録→finished journal | 29.3秒 | 28.2〜30.1秒 |
| audio staging開始記録→finished journal | 33.5秒 | 31.6〜34.8秒 |
| publication request作成→サーバーfinished progress | 94.5秒 | 82〜121秒 |
| commit応答保存→サーバーfinished progress | 85.4秒 | 72.6〜112.6秒 |

公開要求作成間隔は156〜188秒。6〜18件目の逐次処理に約36分。timestampは秒単位、mtimeはローカルjournalの最終保存であり、細かいPOST/PUT/GET単位の純所要時間ではない。サーバーfinished progressは所有権release・CLI確認完了の時刻ではない。

- metadataは1,797〜3,223 bytes（平均2,447 bytes）しかないが約29秒かかる。
- audioは32.1〜49.4 MB（平均39.7 MB）で約33.5秒。サイズだけでは長時間の説明にならない。これを純アップロード帯域とは解釈しない。
- 現時点の読み取り単発計測: service-status 0.280秒、target-show 0.750秒、operation-status 0.781秒。R2 progress REST読み取り0.4〜0.6秒程度。過去の負荷時速度は保証しない。
- 18件目: publication作成02:38:55Z、commit応答保存02:39:03.393Z、サーバーfinished progress02:40:56Z、CLIタイムアウト02:41:04頃。進捗finishedの後もstatus保存/owner解放/service invocation解放が続く。release時刻/最終poll応答は保存記録だけでは不明。

## 実装上確認した要因

1. 全Episodeを1件ずつ処理し、publishedかつreleasedまで次へ進まない仕様。上記時間が件数分累積する。安全性のための逐次仕様を勝手に変更していない。
2. metadata/audioはそれぞれ独立したstaging operation。claim→status→begin→REST PUT→全量GET/hash確認→status→settle→status→finishと複数の往復がある（packages/cli/src/staging-operation.ts:49-117、staging-rest.ts:83-97）。単純なMP3一回送信ではない。
3. Worker公開はowner/runtime/gateを多数回確認する。publication-episode-runner.tsのguardはrequireShowExecutionとrequireOwnedPublication等を呼び、effectsのguardもowner/gateを確認し、delivery gateはruntime admissionを前後で照合する（src/lifecycle-worker-effects.ts:33-43、src/lifecycle-delivery-gate.ts:21-43）。安全確認の直列I/O積み上げはボトルネック候補。
4. 各公開時、GUID重複検証で既存metadataを逐次読み取り、feed再生成でも各Episode lifecycle/metadataを逐次読み取る（publication-episode-runner.ts:20-50、lifecycle-feed.ts:118以降）。全件移行では読み取り数が累積し、おおむね二次的に増える構造。ただし実測は単調増加ではなく、これだけを根本原因と断定しない。
5. CLI公開待機は120回/120秒、1秒sleep。Queue配送待ち、公開処理、releaseと状態確認がこの予算内に収まる必要がある（rss-import-publication.ts:144-163）。今回サーバーは最終的に完了したがCLIは上限に達した。待機上限の緩和だけでは性能改善にならない。

## 未確定の内訳と調査阻害

- Queue配送開始時刻・滞留時間、Worker wall/CPU時間、R2単位時間、cache purge時間、retry/競合頻度は現状のjournalでは分離できない。Queueやcacheを原因と断定しない。DNS原因の根拠もない。
- Worker設定の読み取りでobservability/logs/traces enabled、sampling=1を確認。
- 履歴telemetryをdry=trueの一時クエリで読み取ろうとしたがHTTP403/code10000 Authentication error。再試行・権限変更・設定変更なし。
- API個別リファレンスはWorkers Observability Writeを記載するが、これはlegacy表記。2026-09-15更新のWorkers権限ガイドではObservability Edit/Telemetry EditをWorkers product scopeのEditorに置き換え、AdminはFull manage。対象accountの全Workersを含むWorkers Adminがtokenにあれば、新たなlegacy権限追加を必須とする根拠はない。前回の「追加が必要」という案内を訂正。403だけでは権限不足/トークン種別/スコープ/API側互換性等の詳細は確定できない。
- 参照: https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
- 最新権限ガイド: https://developers.cloudflare.com/workers/authorization/workers/ 。次はlegacy権限を追加する前に、実際にCLI/調査が使用するtokenと管理画面で編集したtokenの一致、Workers Adminの対象account/Workers scope、当該telemetry APIの新role/account-token対応を切り分ける。必要ならCloudflare Dashboardから対象Workerの2026-10-12 02:04〜02:42 UTC（11:04〜11:42 JST）のQueue invocationとstaging/publication POSTのtraceを取得する。認証情報をチャットに貼らない。

## 安全性・証跡

公開再実行/Cloudflare変更/記録削除/強制解除/旧ホスト変更なし。調査時の照会のみ実施。history API拒否後は追加リモート操作を停止。

timeline.json、timing-summary.json、readonly-command-timings.json、13 progress TOML、Worker設定私有JSON、telemetry拒否JSONを同ディレクトリに保存。設定/trace原本には秘密の可能性があるためそのままGit公開しない。
