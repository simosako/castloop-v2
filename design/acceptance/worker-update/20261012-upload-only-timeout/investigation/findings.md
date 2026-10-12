# a8c7e54 Worker更新停止の調査結果

## 結論

**Cloudflare GETの30秒timeoutでversion upload後の更新処理が止まり、upload receiptだけを持つ状態を標準CLIが再開できないため、serviceがupdatingのまま残っている。** 計測helperの状態照会retry漏れとは別で、今回は正式CLIのdeploy経路で性能測定開始前に起きた。a8c7e54のカタログ/性能改修に原因があるとは確認されていない。更新関連4ファイルは4781fadから無変更。

今回の調査はGETとローカル解析/模擬試験だけ。activation POST、再upload、runtime completion、resume、journal編集/復元、owner解除は実施していない。

## 1. 停止箇所とタイムアウトの種類

正式CLIの流れ（`packages/cli/src/cloudflare-api.ts`）:

1. 旧Workerの設定・deployment・version履歴を検証する。
2. Versions APIへPOSTする（179行）。
3. version ID/number/script ETagをupload receiptとしてjournalに保存する（184行）。
4. uploadされたimmutable versionを検証する（185行）。
5. settings等を再照合する（186行 → `prepareCompatibleM6WorkerUpload` の145/149行）。
6. 合格後、同じacknowledged versionのactivationをDeployments APIへPOSTする（196行）。deployment receiptを保存する（202行）。
7. runtimeを検証・完了しpausedへ戻す。その後に別の明示resume。

今回の保持journalは `deploy_requested` / **upload receiptあり、deployment receipt・targetなし**。stderrが`Cloudflare GET .../settings ... timed out`であることと実装順序から、**upload後、activation前の設定再照合で止まった経路**と判断する。APIの生HTTP traceやPOST監査ログを取得しているわけではない。

- upload受付済みversion: `846ac0df-94dc-4c26-af27-7d189c7f159b`。
- update operation: `3ad4f8af-7552-40a2-9525-8bf434a6146e`。
- Cloudflare GETの要求上限は **30秒**（`cloudflare-api.ts:53-64,77-80`）。
- deployコマンド全体の81.348秒は、失敗前の複数の処理も含む。全時間が失敗GETの待機時間ではない。
- RSS公開待機の暫定300秒、管理API側の120秒とは別のtimeout。RSS待機延長だけではこの問題を直せない。

## 2. 読み取り確認の結果と限界

調査の最初の2GETは成功した。

- settings GET: HTTP200、約**0.420秒**。元の凍結metadata意図とhash一致。
- deployments GET: HTTP200、約**1.093秒**。稼働deploymentは更新前と同じ `d3526d87-c1d1-41fd-8efa-5419810fe5bb`。
- 稼働versionは旧4781fad `6d3d011d-e720-42b6-80b0-41f2830128ff` に**100%**。アップロード済み新versionはこのsnapshotでは稼働していない。

続くversions一覧GETも **30.002秒でtimeout**となったので、追加live照会を停止した。最新2versionの順序・連番とuploaded versionの現在のETag、前後snapshotの安定性はこの調査では最後までlive照合できていない。GET時点の旧deploymentだけを根拠に未知のactivationの有無を一般的に証明できるわけでもない。

停止直後の保存済みservice-statusは `state=updating / invocations=[]`。今回の調査でserviceを変更していない。設定取得が今は成功したことは、初回timeoutの根本原因の証明ではない。Cloudflare側の遅延、通信経路、クライアント実行条件等は未分離で、403や権限不足が観測されたものではない。DNS/ルーター変更、権限・Observability・Queue/cache設定変更はなし。

## 3. 標準CLIで復帰できない理由

- `deploy` / `update-service` はpaused/drainedのみを受け付ける（`m6-commands.ts:119-120`）。現serviceはupdating。
- `runM6Update` はprepared以外で再実行を拒否する（`m6-service-update.ts:100-103`）。
- `update-service-verify` は **upload receiptとdeployment receiptが両方ある** deploy_requestedだけを再検証できる（同136-145行）。今回は片方しかない。
- `update-service-reconcile` はcompletion_requestedとacknowledged targetが必要（同126-132行）。今回はcompletionに到達していない。
- service-resumeでupdatingを飛ばす、journalをpreparedへ書き戻す、新operationでdeployする、といった復帰経路ではない。これらは未実施。
- 既存設計 `design/m6_compatible_updates.md:30-36,46` は、receipt不足/未知要求の自動復帰を提供しないことを明記している。

## 4. ローカル模擬試験

製品sourceを変更せず、この環境の `diagnostics/rss-a8c7e54-update-recovery.test.ts` でfetchを完全mockに置換した。実Cloudflareへの要求は**0件**、fixtureは `[REDACTED_FIXTURE_PATH] の専用ディレクトリだけ。実workspaceのjournal byte不変を検証した。

| 模擬停止 | mockで発行した書込 | 保持journal | 標準再開 |
| --- | --- | --- | --- |
| upload成功後のsettings GET timeout | version POSTのみ | deploy_requested / upload receiptのみ | deploy再送・verifyとも拒否 |
| activation POSTの応答不明 | version POSTとactivation POST | deploy_requested / upload receiptのみ | deploy再送・verifyとも拒否 |

**この2つが同じdurable状態になることが重要。upload receiptだけを見てactivationを自動再送すると、応答不明のPOSTも再送する危険がある。** 今回のstderr/処理順序はGET停止を示すが、一般的なupload-only復帰を無条件に許す修正にはできない。

- 最終模擬試験: **2 pass / 0 fail、22 expects**。
- 既存製品更新journal試験: **3 pass / 0 fail、65 expects**。
- 模擬fixtureの初期2実行は、私が作成したfixtureのruntime readiness欠落とWorker origin不一致により目的箇所到達前に失敗。実Cloudflareへの要求はなく、fixtureだけを補正。失敗stderrと最終成功を別ファイルで保持している。製品不具合の結果には数えない。

## 5. 推奨する次の対応（未実施・管理者判断待ち）

1. **性能課題とは切り分け、更新中断の復帰課題として開発側へ報告する。** 原因は30秒GET timeoutと、その中断位置を安全に再開できない更新protocolの組み合わせ。
2. 改修候補は、upload受付・activation要求開始・activation受付をdurableに区別し、未開始と証明できるactivationだけを既存のupload receiptから明示続行すること。凍結要求、server owner、旧deployment、settings、最新2version/連番、script ETag、対象version、CAS等を再検証し、version再uploadはしない。activation要求が不明なら自動再送は引き続き拒否する。安全なGET限定retryも将来の中断削減候補だが、今回の既存journalの復帰をそれだけで実現するわけではない。
3. **今回の旧形式journalをどう扱うかも、明示的に設計・検証する必要がある。** futureのphase追加だけでは現在のupload-only journalを自動的に安全な未開始状態へ昇格できない。現状は最新version履歴のlive照合も未完了なので、手動activateや記録の書き換えによるその場しのぎは推奨しない。
4. 当面は既存環境と記録を保持。別環境を作って性能試験だけ進める案もあるが、資源作成・再移行・比較条件変更を伴う別判断であり、この調査では行わない。

## エビデンス

- `partial-findings.json`、`read-timings.json`、`failure.json`。
- settings/deploymentsの`*-private.json`原本（秘密を含み得るためそのまま公開しない）。
- `offline-post-upload-settings-get.json`、`offline-activation-post-response-unknown.json`。
- `offline-recovery-tests*.stderr`、親ディレクトリの `update-recovery-unit-tests.stderr`。
- `update-engine-source-diff.stdout`（4更新関連fileは4781fad→a8c7e54で差分なし）。
- 親ディレクトリの停止証跡・workspace私有backup・root活動log。

GitHub push、Issue作成/追記、製品コード変更、復帰操作、性能公開job実行はまだ行っていない。
