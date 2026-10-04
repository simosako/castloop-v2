# M6: standaloneと専用Cloudflare環境の受け入れ

更新日: 2026-10-04

## 対象と公開制限

初期の六lifecycle/更新応答喪失/cache試験は`castloop-m6-test-ff3bfd8c`で実施した。後述の300MB失敗後は未知owner/tokenを保持し、再利用・再配備・強制解放をしない。新しい完全性検証方式は別名`castloop-m6-test-7c97f1a0`で検証した。workspaceはそれぞれ`/tmp/opencode/<Worker名>`。既存v0.1.1環境・独自domain・有料planは変更せず、Worker/R2/Queue/DLQ資源自体も削除しない。承認済みMVP範囲で通常binary/Workerを既存runnerへ接続し、正式入口の実機確認を進める。配布済みv0.1.2や既存serviceを切り替えるものではない。

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

## 改修前の300MB: WorkerのCPU制限で未合格

正確な300,000,000-byte MP3のlocal stream解析とREST単一PUT/全量GET照合は成功した。300,000,001 bytesはlocal size limitで拒否され、remote targetが非変更であることも確認した。続くWorker検証の応答は未確認となった。

- staging operation: `4156d1e5-3e22-4b19-b842-b0135fc56cdb`、draft: `d05d71fc-0c58-463d-904c-20704be807ae`。
- local `finish_requested`/`put_outcome=staged`/acknowledged PUT 1件、server `verifying`/`verification_active=true`/service invocation保持。成功扱い・再送・token奪取はしていない。
- 明示pause `cd7922c5-3103-4000-9e7d-198613b3dfd9`で新規配信/書込を閉じた。registryには未収束tokenを保持し、pausedをdrainedと表示しない。300MB staging payloadも回復可能性のあるdraftとして保持する。
- 独立した`castloop-m6-test-digest-e975e1b4`は同じ既知objectを条件付きGETするだけの診断Worker。R2/control/Queueには書き込まない。native DigestStream直結と現行byte-count付き経路を各一回試し、両方の503と`exceededCpu`をsanitized realtime tailで観測した。直結はCPU 2068ms/wall 3215ms、現行経路はCPU 10ms/wall 50msで終了した。直結だけに変えても現CPU制限を回避できない。
- Worker settingsの`usage_model=standard`はPaid契約の証拠ではない。契約照会は403/code10000であり、billing権限の追加・契約変更・CPU limit変更をしていない。

Cloudflareの[limits](https://developers.cloudflare.com/workers/platform/limits/)ではFree HTTP CPUは10ms。2026-10-04、管理者が**Workers Paidは利用不可**と決定した。Paid環境への変更ではなく、CLIの既存全量照合とR2の検証能力、Workerで保持するidentity/size/owner検査の責務を無料枠前提で見直す。代替方式はまだ実証済みではなく、単にchecksum検査を削除する承認でもない。300MB保存/CLI全量照合は成功しており、今回の失敗を無料枠での300MB運用そのものが不可能という証明にしない。

診断結果は`/tmp/opencode/castloop-m6-test-digest-e975e1b4/results-2.json`。tailの終了通知を旧IOがすべて収束した保証として扱わず、元のserviceのtoken/ownerは保持する。既存資源・診断資源の削除もしていない。

後続の独立試験では、R2 bindingにSHA-256を渡す300MB stream保存とHEAD native checksum照合がCPU 2msで成功し、CLI全量読み戻しとも一致した。管理REST PUTへのchecksumヘッダー追加は誤ったhashを拒否しなかった。[完全性検証調査](./m6_upload_integrity_review.md)参照。これは代替機能の実証であり、現行M6 staging/publicationの実装変更や全受け入れ合格ではない。元serviceの未知owner/tokenは保持する。

## CLI/R2完全性検証への改修: 小さい公開が合格

管理者承認の案Bを実装し、試験専用Linux standaloneを新規`castloop-m6-test-7c97f1a0`で実行した。初期化operation `0cbab4d5-7b15-4ee2-a199-630b2c8cad79`からpaused初期化→明示再開→Show job `412ce195-33b3-40f2-a20a-09bb603100d0`/Episode job `d359f27a-7f8c-4a02-9be9-c2898a5da61f`の公開→GET/HEAD/Range→明示pauseまで通した。

CLIの全量SHA-256読み戻しとPUT receiptのETag/versionが、保存journal/認証付きsettlement/Worker HEADへ一致した。公開音源のR2 native SHA-256検査も実経路で成功した。音源のWorker staging/publication全量再hashは除き、owner/generation/IO終了確認は維持する。結果は`acceptance.json`。pause `ab089857-d110-429a-8b4f-f16647b00348`はこの小さい試験の終了checkpointであり、後続300MB試験の現在状態を示さない。

## 後続

管理者承認により、残件を正式CLI/Workerの接続、変更入口と正式バイナリの一通りの検証、短い利用案内・release準備へ絞る。新規初期化fault harnessや網羅的異常系は追加しない。unknown IO/残存lockは停止・ブロックを保持し、万能な外部復旧をMVP完成条件にしない。費用/停止時間測定・無停止移行・必要時の旧形式変換は後続とする。下記の300MB合格を旧環境の未返却owner/token解放へ流用しない。

## CLI/R2方式の300MB・二種改訂・明示削除: 合格

`castloop-m6-test-7c97f1a0`、version `77775577-cf6f-47e1-be97-a271f9d618e5`で`verify-large-media.ts`を実行し、以下が合格した。Paid契約/CPU limitは変更していない。

- 正確な300,000,000-byte MP3の解析・REST単一PUT・CLI全量SHA-256読み戻し・ETag/version証拠伝達・Worker HEAD照合と、R2 SHA-256付きstream PUT/native checksum照合による公開。
- 300,000,001-byte入力のlocal拒否とremote target非変更、音源だけの改訂、metadataだけの改訂、GUID/公開日時/immutable履歴と旧音源の保持。
- 公開音源の全量GET/size/SHA-256、HEAD、末尾Range、304。feed/cover/小さい旧音源の実cache HITとgateway毎要求実行。300MB音源自体のcache HIT・複数colo・聴取品質の合格とはしない。
- 明示Show delete後の既知音源R2 GET 404と公開410、owner/token通常終了、明示pause。最終generationは149、registryは空。Worker/R2/Queue/DLQ資源は保持する。

| 操作 | job ID |
| --- | --- |
| Show公開 | `1a091043-e620-4e97-9cc5-adcf1070ebf6` |
| 小さいEpisode公開 | `ee7a258e-8a20-4cdf-a811-2ed39749a4c9` |
| 300MB audio-only改訂 | `5f4a2cb8-4b3f-4c8b-b191-a3487c1e0a56` |
| metadata-only改訂 | `d0811f94-52ac-43ed-9d27-e667f726d750` |
| Show明示削除 | `28b77bf2-cf57-4f8a-8a53-8f2182d2701c` |

初回は300MB公開/全量配信後、試験CLIがmetadata-onlyにもMP3 pathを必須にしていたため送信前guardで停止した。metadata upload `542eb77e-2099-45ed-b805-c0d64a957dad`は正常finished/staged、publication journalは未作成、service registryとShow ownerも空であった。CLIをoptional pathへ修正し、既存の「changed audioだけsource path必須」検査は緩めていない。

続行は`--metadata-staged-workspace`でexact version/readiness・同じbase・finished local/remote released staging・読戻し証拠一致・publication未作成・lock/token不在を照合したcheckpointに限る。別の`wx` before fileを作り、元incompleteを保持する。再PUT/再staging/未知POSTの再送・ownerの強制解放はしていない。

最終pauseは`d89332da-8564-42c9-b605-e37a5af0596d`。private `large-media-acceptance.json`と[sanitized結果](../experiments/m6/large-media-results-20261004.json)を保存した。readonly snapshot競合は9件を有限観測で扱い、mutationは再送していない。全891テスト/13475 assertions、TypeScript/M6試験tsconfig、Linux binaryとlocal HTTPS readonly/production拒否も合格した。

## 正式CLI/WorkerのMVP walkthrough: 合格

既存runnerを共有した通常Linuxバイナリで、新規`castloop-m6-test-d5fd9895-4fe3e736`/bucket `castloop-m6-test-formal-d5fd9895`を使用した。workspaceは`/tmp/opencode/castloop-m6-test-formal-d5fd9895`。初期化operation `fe060824-fd94-483d-891e-311499aa3a68`のpaused完了・明示再開、サービスrootのShow commandとShow directoryのEpisode command、MP3引数付き初回公開と引数なしmetadata-only公開、GET全量SHA-256/HEAD/Range/304、private path非公開・管理API認証、試験nonce header不在を確認した。

通常更新operation `82aff843-2621-4521-a318-23af97a15629`はpausedで完了し、明示再開後のcurrent revision全体（GUID/日時/音源URL/hashを含む）が同じであった。六lifecycle操作の配信404/復元200/削除410と、全jobのcompleted/finished/purge確認・execution非稼働を確認した。終了後のreadonly R2監査で既知8 payloadの404、永久reservation identity・Episode tombstone・Show/Episode publication marker保持、service snapshot非変更が合格した。より広いimmutable object/300MB/cache HIT検証は上記の既存受け入れを再利用し、今回の小さい合成音源試験を聴取品質・複数colo・費用/停止時間測定へ一般化しない。

試験scriptは当初create-showのfile path出力をJSONとして読んで停止し、その後は処理中のreadonly照会未確認で停止した。初期化/登録または公開のlocal acknowledged receipt、remote完了・owner/lock/token不在、未開始の次工程を照合したcheckpointだけから続行した。mutationを再送せず、元incompleteを保持した。最後のrunではreadonly未確認16件を有限再照会で扱った。公開完了stateは`published`、lifecycle完了stateは`completed`であることもREADME/helpへ正しく反映した。

最終versionは`c2d68ee0-d81a-4d70-99b4-539751c88904`、pause `c626b2f5-94ed-48a5-b8d2-8903126f4446`、generation 146、空registry。正式Workerの最終source hashは試験済みbundleと同じ`ae052ebb5d6aa279ba5a14c97449ef14d1e9cdbfadc493813335f24c52a9bfdc`で、test headerは含まない。資源はpausedで保持し、既存環境/Paid/未知ownerには手を加えない。[sanitized結果](../experiments/m6/formal-entry-results-20261004.json)を保存した。

全893テスト/13526 assertions、両TypeScript検査、正式/試験Linux build、認証情報・ソースのないcwdで正式standaloneのversion/全27 help・fault command拒否も合格した。CLI実行権限を保持し、checksum/license同梱の候補artifactをローカルへ用意した。README/help/Release notes草案は完成したが、正式version/tag/GitHub Releaseはまだ作成していない。
