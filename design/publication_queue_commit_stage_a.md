# Queue commit移譲: 段階Aの実装契約

2026-10-15。v0.4.0 (`8e722ca`)を起点とする`feat/publication-queue-submit`。
管理者が[移譲案](publication_queue_delegation_options.md)の段階Aを承認した。公開版・Cloudflare配備済みコードではない。

## 経路と対象

```text
CLI: staging・local入力照合 → HTTP claimで既存Show ownerを確保
  → service capability/runtime・正確な既存Queue IDを読取確認
  → commit intent・submission_id・body hashをlocal journalへ保存
  → Cloudflare Queues RESTへPOSTを1回だけ送信
Queue: MAC/runtime/config照合 → own service invocation
  → 認証済み要求の保持 → exact Show executionをCAS取得
  → delivery gate → markerをconditional PUT
  → 同じexecutionで既存詳細検証・Show/Episode runner・purge・完了保存
  → 自分のsettled execution/service tokenだけ返却
CLI: job-statusでpublishedかつreleasedを確認
```

claim・staging・status・明示的な既存markerのretryはHTTPに残る。commitはアプリHTTP Workerを呼ばない。
旧HTTP commit APIと`accepted`/`committed` journalは保持するが、新CLIからのfallbackはない。
物理的な別Worker、別Queue、DB、Workflowsは追加しない。公開順序はQueue FIFOや時刻ではなく既存Show admissionで管理する。

## protocol・承認証明

- service-statusの`publication_commit_protocol: "queue-commit-v1"`を新規claim前に要求する。
  `publication_acceptance_protocol: "queue-validation-v1"`も維持し、未対応Workerではclaimを始めない。
- strict intent: version/family/action/service/submission、show/job/generation、manifest/control-request SHA-256、
  Worker version、service config SHA-256、MACのみ。metadata本文、音源、API token、管理鍵は含めない。
- `castloop/publication-commit/queue-commit-v1`のdomain separationを加え、canonical JSONを管理鍵のHMAC-SHA-256で署名する。
  consumerはWeb Crypto verifyを使う。アプリ上限は4,096 bytes。
- service config hashはaccount/bucket/Worker/Queue/URLを束縛する。consumerは現在のconfigと実行versionへ照合し、既存runtime readiness/cache owner gateも省略しない。
- 段階Aの受付windowは取得済みclaimのjob/generation/request hashとruntime/configへ束縛する。
  `last_resumed_pause_id`への追加束縛は行わず、既知ownerのpaused drainを維持する。
  未claim要求のadmission window・pause/resumeまたぎは段階Bで別途承認する。
- Cloudflare API tokenは環境変数だけ。Queue name→IDを同じaccount内で照合し、GETしたQueue identityを確認する。
  既存consumerが同じWorker・batch/concurrency 1・max retries 2・同じDLQであることもGETで確認し、設定が不明ならclaim前に拒否する。
  Queues Edit不足や応答不明でPOSTが確認できなければ停止する。権限を自動追加したり、未知Queueを作成・採用したりしない。

## marker・execution・重複

`commitExecutingPublication`はHTTP用`commitOwnedPublication`の条件を緩めたものではない。
同じjob/generation/manifest/request hash・`processing` owner・正確なexecution IDを要求し、
marker PUT直前にも現在executionを再確認する。markerはR2 bindingのIf-None-Matchで作り、既存markerも凍結要求へ照合する。

取得したexecutionは共通`runPublicationExecution`内でmarker作成から公開まで保持する。
全開始済みI/Oをawaitし、既存のsettled cleanupだけを使う。強制終了や実行token残留時はbusyにして有限retry/DLQへ入る。
経過時間・HEAD不在・DLQ履歴ではtokenを返却しない。HTTPのtokenをQueueへ渡して解放させることもしない。

native R2 marker通知は同じQueueに残す。新intentの重複とnative通知は、既存owner・immutable marker・progress・完了記録へ収束する。
submission終端状態は戻せず、同じIDの異なるbody／同じjobの別IDでは既存要求を置き換えない。
公開が完了した後にsubmission完了記録だけ失敗した場合は、既存published/releasedを照合して記録を進め、公開書き込み・purgeを繰り返さない。

## journal・記録・待機

- `prepared → claim_requested → claimed → submit_requested → queued`。
  submission ID・署名済みbody・Queue ID・intent hashは`submit_requested`を保存してからPOSTする。
- CLIの`publication-queued`と`queued_receipt.result: "queued"`はQueueのsuccess応答を確認したことだけを示す。
  `key/created/staging_verified`は返さず、marker作成や公開の証拠にしない。
- POST応答喪失・403・未検証receiptは`submit_requested`を保持する。自動retry・新job置換・旧HTTPへのfallbackはない。
  read-only statusにより公開完了を確認してもjournalを`queued`へ自動昇格しない。
- `system/publication-submissions/<submissionId>.json`: 署名済み小さい要求のimmutable identity。
  `system/jobs/<jobId>/queue-submission.json`: 同じ要求とallowlistの`pending/committed/completed/failed/rejected`結果。更新はbinding CAS。
  既存publication/control request、marker、status/progress、CLI journalも保持する。自動expirationはない。
- `job-status`は従来のownership/status証拠に加え、小さいsubmission summaryを返す。
  summaryもmanifest/request/job/generationと照合し、同じsnapshotのGET/HEADで変更を検知する。
  不一致・破損記録は拒否し、都合のよい完了証拠へ補正しない。
- consumer未到達ではR2 submissionがないこともある。CLIのqueued receiptとfrozen requestを保持する。
  Queue保持切れ・R2記録不在は不送信や旧I/O終了の証明ではない。
- RSS waitingはqueued receiptでも同じjobを待ち、最大300照会・5分以降は新規照会しない。
  `published/released`まで次Episodeへ進めず、failed/rejected/DLQで停止する。
- `retry-job`は**marker存在を検証済み**かつ実行tokenなしの同じjobだけ。未確認・markerなしintentの再送操作は未提供。
  `release-job`は引き続き無効。未知送信・残るownerを取消す安全な汎用操作は未提供。

詳細検証の確定的な公開前入力失敗は従来どおり`failed / validation_failed`でShow ownerと凍結draftを保持する。
重複で公開せず、immutable media/history、purge成功後の完了、allowlist診断を維持する。

## 検証と未確認事項

自動試験の対象はHMAC相互運用・全identity改変・strict schema、通常Show/初回Episode/metadata-only/audio-only、
marker前のexecution取得、native通知とintent重複、paused drain、active tokenとDLQ保全、
入力失敗、marker一時失敗、pending PUTの両token保全、完了記録の応答喪失照合、
CLI送信前journal永続化、403/応答喪失/receipt不一致時の非再送、未対応Worker/未知Queueのclaim前拒否、RSS正式runner経路。

実装時の確認: `bun test`は**1,086件成功・0失敗**（120 files）、`npm run check`、
`npm run build:cli -- linux-x64`、開発バイナリのhelp／必須引数拒否と文書リンク確認が成功した。
36件のpublished Episodeを持つShow更新もローカルfixtureで確認し、既存音源への追加書き込みはなかった。
これはCloudflare CPU・wallの測定ではない。公開版のpackage versionは変更せず、開発ビルドはSHA-256で識別する。

初回の実装依頼ではCloudflare配備・実機測定・権限変更を行わなかった。
後続の管理者指示によるcommit・Push・隔離環境での測定は[2026-10-15実機結果](publication_queue_commit_measurement_20261015.md)参照。
7公開が成功しHTTP commitは観測0だったが、残るHTTP CPUのFree目標は未達。権限・課金変更は行っていない。
claim/staging/statusのHTTP CPUが残るため、サービス全体のFree適合・Issue #13の完全解消は主張しない。
段階B（claimの非同期化）は未実装・未承認。
