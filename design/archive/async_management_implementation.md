# Queue/R2管理経路: 案Cの実装契約

> v0.5.x以前のQueue方式の履歴。v0.6.0以降はこの実装を削除している。現行は[SQLite設計](initial_design.md)。既存環境や記録の変更許可ではない。

2026-10-15。管理者が[構成比較の案C](async_management_architecture_options.md)の実装とテストを承認。
`feat/publication-queue-submit`の開発コードであり、v0.4.0公開版ではない。
実装依頼時にはCloudflare配備・upload・実機測定は行わなかった。
後続の別承認による隔離環境への配備と測定は[案C実機結果](async_management_measurement_20261015.md)参照。

## 対象と経路

正式CLIの`update-show`・`update-episode`・`update-episode-audio`、
`publish-show`・`publish-episode`と、これらを使うRSS逐次公開を変更した。

```text
CLI: private R2のconfig/readiness/control/revisionを整合照合するread-only snapshot
  → local入力・manifest・未公開draft job IDを維持
  → stage-startの署名済み要求/ID/hash/Queue IDをjournalへ保存してからQueue REST POST
Queue: current runtime/window、atomic service/Show admission、own command execution
  → beginを確定 → 署名済みR2 grant → own IO終了後にown tokens返却
CLI: exact grantを確認 → 全PUT/全量readbackをawait → no-more-PUT宣言
  → upload-completeを凍結してQueueへPOST → compact R2結果を待つ
Queue: grant/owner/settlementを照合 → own verification → 既存検証 → staged/aborted

管理者の明示的publish
CLI: publication requestを凍結してQueueへPOST → publication-queued応答
Queue: atomic claim+own execution → marker → 詳細検証/公開/purge/完了
CLI: operation-status/job-statusで署名済みcompact R2結果を確認
```

このcontent経路ではcastloopの管理HTTPを呼ばない。Cloudflare RESTへのHTTPS通信は残る。
Show登録、service status/pause/resume、standalone target-show/target-episode、一覧、lifecycle、deploy/domainは従来経路。
standalone target inspectionをHTTPに残し、旧M6 Workerのpause/drain確認・互換更新を新CLIで行えるようにした。
旧HTTP API・段階Aのjob/statusも削除しないが、新しいcontent操作の自動fallbackには使わない。

## 限定protocolと認証

- `queue-management-v1`、family `management`、3つのstrict commandだけを追加。汎用operation engineは作らない。
- 要求はservice、request ID、Worker version、config SHA-256、`last_resumed_pause_id`、凍結manifestへ束縛。
  stage completeはstart request ID・exact upload manifest・全readback receipts・settlement・outcomeも含む。
- intent/resultで異なるdomainを使うHMAC-SHA256。consumer/CLIともWeb Crypto verifyを使う。
  アプリ上限16,384 bytes。metadata本文・MP3・タイトル・email・API token・管理鍵はmessage/保持recordに入れない。
- Queue name/IDとconsumerのexact Worker、batch/concurrency 1、max retries 2、DLQを既存REST照合で確認する。
  不明な資源の採用、権限追加、別Queue/DB/Worker作成はしない。

## Runtime readinessと非同期admission

正式setup Queue round-trip receiptが`management_protocol: "queue-management-v1"`を記録し、
同じruntime verificationの`runtime_readiness`にも保持する。古い証拠へ自動追加しない。
CLIはprivate R2 snapshotで同じconfig・対応readiness・明示的resumeを確認してから新content要求を送る。
これはactive runtime RPC確認ではなく、consumerが実行前にcurrent Worker/cache owner gateを再検証する。

新commandはopen状態で、exact window/versionを照合するservice CAS admissionを取得する。
pause前にこのtokenを取得済みの実行はdrain対象。新規Show admissionは既存runnerのCASを使い、
Show/Episodeのgeneration/lifecycle・既存owner・新Episodeのorphan/registration検証も省略しない。
Show admissionとpublication executionは新規公開時に同じCASで取得する。

Queue成功はowner確保ではない。queued後に競合で拒否される場合がある。
新しいgeneration/windowへの自動補正はしない。未admitted要求がpause/resumeや更新をまたいだ場合は拒否する。
service token出入りのgenerationはwindowとして使わない。registry/ownerが空でもQueue backlog不存在とは判定しない。
互換更新は従来pause/drain/current readinessのまま行い、古い要求を新versionで開始しない。

既にexact Show ownerを取得済みのcomplete/publication再配送は、同じwindowでpaused drainできる。
残留executionは別invocationが取得・解除できない。経過時間・HEAD不在・DLQを解放根拠にしない。

## Upload所有権と保存先

Show ownerにstage専用`command_execution_id`を追加。新grantでは初回Show CASに同時保存し、
既存ownerに接続する場合もexact frozen requestとidle tokenを照合してCAS取得する。
grant/progress IOとsettlement/verification IOを保護し、HTTP staging runnerも他のcommand executionがある間は拒否する。
verification専用tokenをPUT終了前に取得して流用する方式にはしない。
admission取得後の読取等がcatchされた場合も、開始済みIOをawaitした同じinvocationが、
exact ID/generation/jobの自分のtokenだけ返す。外部実行のtokenや応答不明のclient PUTを解放する経路ではない。

clientのupload待ちをQueue invocation内で待ち続けない。grant書込み等のown IOがsettleした後に、
自分の短いcommand/service tokenだけ返し、Show upload ownerはcompleteまで残す。
completeは自分のcommand execution下でsettlementを書き、既存verification runnerのtoken取得・完了をawaitする。
正常完了では検証済みreceiptとowner解放を従来のatomic recordに保存する。

payloadのkey layoutは変更しない。Show/Episodeの既存draft prefixと1つの未公開draft job IDを維持し、
upload operation/request IDは別にする。metadata/audioの別updateも維持する。
同じIDの再配送は同じgrant/resultへ収束し、別IDの要求で既存operationを置き換えない。
CLIはone-caller target/upload journalとone-time PUTを維持し、過去grantを読んでもPUTを再開しない。

MP3解析・全量readback hashはCLI。Workerが300 MBを全量bufferする変更はない。
REST PUTのCAS仮定はなく、[未検証のU1](m6_upload_recovery_options.md)も解決済みとはしない。
upload完了はstagedで止める。実際のpublication `commit.json`はconsumer自身のowned executionでbinding CAS保存する。
既存R2 marker notificationは重複配送として維持する。

## 結果record、journal、待機

- `system/management-requests/<requestId>/intent.json`: binding create-onlyの署名済み要求。
- 同prefixの`result.json`: 署名済みの`pending → granted/staged/aborted/published/failed/rejected/blocked`。
  request ID・body hash・service/actionに束縛し、terminal状態を戻さない。
- `system/jobs/<operationId>/management-<action>.json`: exact request ID/hashのcreate-only対応表。
  operation IDを別requestへ採用し直さない。
- 小さい拒否/搬送recordはadmission前にも保存するが、payload/progress/marker IOはservice/Show token下で実行する。
  残す診断は固定allowlistのみ。content・secret・例外本文は保持しない。自動expirationは追加しない。
- 新publication journalは`prepared → async_submit_requested → async_queued`。
  claim/marker receiptを捏造しない。`publication-queued`はPOST成功の確認だけ。
- staging journalは既存phaseを維持し、start/completeの凍結body・queued確認・署名済みgrant/terminal結果を追加。
  `claimed`は実際のgrant取得後、`finished`は実際のstaged/aborted結果確認後だけ。
- POST喪失・403・未検証応答ではattempted phaseを保持し、自動再送しない。
  読取でremote成功を確認しても未知local phaseを自動昇格しない。
- `operation-status`/`job-status`の新job応答は`server_status.result: "management-status"`、
  `server_status.response`がnullなら未確認、`response.state: "published"`ならそのoperationの公開完了。
  旧jobは従来のstatus/ownership形式で読める。
- resultはoperationの完了証拠であり、全service tokenの空・現在の公開状態・次のadmission・recovery権限ではない。
  次の操作はconsumerのcurrent gate/CAS、deploy/drain等は従来のcurrent ownership検査を使う。
- upload待機は最大300回・5分、backoff、個々のR2 GETは30秒timeout。
  RSS公開も最大300回・5分の新規照会上限を維持する。期限で切るのはCLI待機だけ。
- publicationの確定的な公開前検証失敗は`failed/validation_failed`、Show ownerとfrozen draftを保持し、重複で公開しない。
  staging検証の例外は既存のsettled/retrying保全と有限Queue retryを使う。
  DLQでは署名済み`blocked/retries_exhausted`を保存するがowner/tokenを返さない。
- 新async要求の明示的retry/releaseは未提供。旧`retry-job`へfallbackしない。
  unknown要求の万能復旧・取消・local journal再編集は今回の範囲外。

## 確認

ローカルの実際のCLI関数・Cloudflare REST transport・正式Queue entrypointを接続したfixtureで確認。
公開処理の検証/immutable media/history/purge/完了は既存runnerを通す。

- 小容量Show、初回Episode、metadata-only/audio-only更新。
- 36 EpisodeのShow更新、GUID/公開日時/未変更音源とrevision履歴を保持、追加MP3書込みなし。
- 新content操作の管理HTTP 0（mock transportはcastloop HTTP呼出しを拒否）。登録/lifecycle等のHTTPは別scope。
- MAC/結果改変、runtime/window変更、競合、paused drain、token generationとwindowの区別。
- native/intent重複、同operationの別要求、保留grant IO、残留stage/publication tokenとDLQ非解放。
- 公開前validation failedの非公開、terminal結果書込み喪失のread-only照合、同grantの記録復旧。
- CLIのstart/complete/publish POST応答喪失と非再送、旧readiness拒否、期限後の非polling、RSS cursorの非再mutation。

`bun test`: **1,115成功・0失敗**（123 files）、`npm run check`、Linux単独バイナリbuild/help確認が成功。
これは実装時のローカル確認であり、実機300 MBの再受入れではない。
後続の実機測定は1,116テスト成功後の`e60a114`で、小容量から36件へ進み7公開が成功した。
管理HTTPは観測0、公開feedは最大11ms、総wallは増えた。詳細/限界は上記の測定文書参照。
公開版/package versionは0.4.0のまま。Issue #13の恒久解消・全HTTPのFree適合は主張しない。
