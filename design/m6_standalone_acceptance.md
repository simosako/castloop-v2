# M6: standaloneと専用Cloudflare環境の受け入れ

更新日: 2026-10-04

## 対象と公開制限

新規初期化・通常更新が確認済みの`castloop-m6-test-ff3bfd8c`を再利用する。workspaceは`/tmp/opencode/castloop-m6-test-ff3bfd8c`。既存v0.1.1環境・独自domain・有料planは変更せず、Worker/R2/Queue/DLQ資源自体も削除しない。通常binary/WorkerのM6公開gateは閉じたままである。

実行scriptは`experiments/m6/README.md`参照。before/plan/acceptance/incompleteはprivate fileであり、secretを含むlocal manifestを報告へ添付しない。mutationは一度だけ、readonly観測は有限回とし、commitの受付とconsumer完了・owner解放・invocation返却を区別する。

## 六lifecycle操作: 合格

`verify-lifecycle.ts`からLinux standaloneを使用し、Worker version `1e29cc26-676a-430f-95a8-1040b84c6f9c`の実HTTP/通知/Queue/consumerで小さい`fresh/first` fixtureを検証した。

| 操作 | job ID |
| --- | --- |
| Episode unpublish | `fe9fa769-509e-4340-bbe3-011725d021b1` |
| Episode restore | `32419732-5141-4445-965a-4f4d2a41fc9a` |
| Show unpublish | `503c94a1-0812-485f-b8ec-42c1bda4185d` |
| Show restore | `70c3d39d-5643-460a-a6cb-735d71d445db` |
| Episode delete | `ad1d38fa-ad5b-4bf2-b21e-e60bd49c7cae` |
| Show delete | `26fcafdb-4ce4-46ff-b930-9f38572316d9` |

- 公開GET/HEAD/Range、ETag付き304と範囲外416、毎回再検証する外向けheaderを確認。
- warm要求後の停止404・削除410を、GET/HEAD/Range/If-None-Match/query付き要求で確認。Episode停止/削除後もShow feedは200で当該GUIDを含まず、Show停止/削除はfeed/cover/音源すべてを隠す。
- restoreでGUID/revision/URL・metadata/history/audio checksumを保持。
- private R2の既知payload物理不在と対象scopeの残存markerを確認。Show control/永久reservation/Episode tombstone、六jobのrequest/status/progress/commitは保持。
- 実行終了時はpause `a9a75d6b-aa49-410c-baad-536757f197fd`、空registry。これは当該試験の終了checkpointであり、以後の試験中も同じpause/versionとは限らない。

結果は`lifecycle-acceptance.json`。二回GETしたことだけでは内部cache HITを証明しないため、この試験の`cache_hit_proven`はfalseである。

## 完了応答喪失の照合: 合格

`verify-completion-recovery.ts`の更新operation `6bb77144-ded9-427e-88c9-171ba5be8735`で、実serverの成功completion応答だけを試験transportが破棄した。local journalは`completion_requested`、serverは新version `756ab58d-9289-4fbd-a0df-cdc9377b71f4`でpaused/空registryを保持した。

別のstandalone `update-service-reconcile`が永久request/Queue receiptと現在の配備をreadonly照合し、localをcompletedへ進めた。照合前後でservice status（generation/readiness/ownerを含む）とruntime-checkのETag/全量checksumが同じであり、再配備・complete再送・自動resumeはしていない。結果は`completion-recovery-acceptance.json`。強制終了IOの収束証明ではない。

全884テスト/13409 assertions、TypeScript/M6試験tsconfig、通常/試験Linux build、local HTTPS四family statusとproduction資源拒否も合格した。

## 実cache HIT: 合格

version `756ab58d-9289-4fbd-a0df-cdc9377b71f4`で`large` Showと小さい`boundary` Episodeを公開し、feed/cover/音源の内部HITを確認した。NRTで同じ内部nonceが返り、gateway nonceは変わった。300MB試験失敗後にも公開GETだけで再照合し、`cache-hit-acceptance.json`へ記録した。実測を複数coloや300MB cache HITまで一般化しない。

## 300MB: WorkerのCPU制限で未合格

正確な300,000,000-byte MP3のlocal stream解析とREST単一PUT/全量GET照合は成功した。300,000,001 bytesはlocal size limitで拒否され、remote targetが非変更であることも確認した。続くWorker検証の応答は未確認となった。

- staging operation: `4156d1e5-3e22-4b19-b842-b0135fc56cdb`、draft: `d05d71fc-0c58-463d-904c-20704be807ae`。
- local `finish_requested`/`put_outcome=staged`/acknowledged PUT 1件、server `verifying`/`verification_active=true`/service invocation保持。成功扱い・再送・token奪取はしていない。
- 明示pause `cd7922c5-3103-4000-9e7d-198613b3dfd9`で新規配信/書込を閉じた。registryには未収束tokenを保持し、pausedをdrainedと表示しない。300MB staging payloadも回復可能性のあるdraftとして保持する。
- 独立した`castloop-m6-test-digest-e975e1b4`は同じ既知objectを条件付きGETするだけの診断Worker。R2/control/Queueには書き込まない。native DigestStream直結と現行byte-count付き経路を各一回試し、両方の503と`exceededCpu`をsanitized realtime tailで観測した。直結はCPU 2068ms/wall 3215ms、現行経路はCPU 10ms/wall 50msで終了した。直結だけに変えても現CPU制限を回避できない。
- Worker settingsの`usage_model=standard`はPaid契約の証拠ではない。契約照会は403/code10000であり、billing権限の追加・契約変更・CPU limit変更をしていない。

Cloudflareの[limits](https://developers.cloudflare.com/workers/platform/limits/)ではFree HTTP CPUは10ms。2026-10-04、管理者が**Workers Paidは利用不可**と決定した。Paid環境への変更ではなく、CLIの既存全量照合とR2の検証能力、Workerで保持するidentity/size/owner検査の責務を無料枠前提で見直す。代替方式はまだ実証済みではなく、単にchecksum検査を削除する承認でもない。300MB保存/CLI全量照合は成功しており、今回の失敗を無料枠での300MB運用そのものが不可能という証明にしない。

診断結果は`/tmp/opencode/castloop-m6-test-digest-e975e1b4/results-2.json`。tailの終了通知を旧IOがすべて収束した保証として扱わず、元のserviceのtoken/ownerは保持する。既存資源・診断資源の削除もしていない。

## 後続

300MB/audio-only/metadata-only/配信/明示deleteの未完了受け入れ、安全なunknown IO/残存lockの外部終了確認、復旧手順、通常CLI/README/help/version/releaseの完成は残る。harnessは新規初期化のacknowledged journal/paused checkpointからも開始可能にし、既に確認した通常更新と六lifecycleを300MB試験のたびに再実行しない。failed workspaceの再送/採用/強制解放を許可するmodeではない。
