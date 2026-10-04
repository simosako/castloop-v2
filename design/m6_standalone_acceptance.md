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

## 後続の受け入れ

- `verify-large-media.ts`: 正確な300,000,000-byte MP3、過大入力のlocal拒否、audio-only/metadata-only改訂、全量stream照合、GUID/date/history/旧媒体保持、配信・明示deleteを検証する。試験Workerだけのnonce/headerでfeed/cover/小さい音源の実cache HITとdefault gatewayの毎回実行を確認する。

これらのscriptの実装・型検査は実機合格を意味しない。実行結果は別途追記する。unknown live PUT/consumerや残存lockを安全に解放する外部終了確認、復旧手順、通常CLI/README/help/version/releaseの完成は引き続き残る。elapsed time・HEAD不在・traceの終了通知だけを旧IO収束の保証として扱わない。
