# M6: upload中断・収束の選択肢

更新日: 2026-10-01

状態: **検討資料。upload方式の変更は未承認・未実装。** [M6設計](./m6_content_lifecycle_plan.md)と[実測ログ](./m6_implementation_log.md)の補足。

## 実測で分かった制約

既存CLIはCloudflare R2 REST object PUTでmetadata/cover/MP3を直接送る。MP3の上限300,000,000 bytesを維持し、管理端末へS3 credentialsや別runtimeを要求しない。

専用R2で既存objectへ不一致`If-Match`付きPUTを送った結果、HTTP 200で上書きされた。[証拠](../experiments/m6/admission-results-20260930.json)を参照。R2 binding側のonlyIf/CASは成立しても、このREST object PUTに同じ保証はない。

したがって、Show ownerを取得してから直PUTし、失敗/時間切れならownerを消すだけでは安全でない。旧HTTPが後から完了すれば、削除後にstaging payloadが再作成され得る。CLIのfetch abort、HEADの不在、経過時間、削除prefixの一度の再列挙は「旧writeが今後起きない」ことの証明にしない。

## 選択肢

| 選択肢 | 利点 | 制約/判断 |
| --- | --- | --- |
| A: 現行直PUTを維持し、不明uploadはブロックを保持 | 既存のCloudflare REST経路・300MB対応を変えない。unsafe releaseを防げる | 中断したuploadを安全に取消/再開する仕組みは未成立。M6公開ゲートが残る |
| B: 同じWorkerの認証付きAPIで分割upload sessionを管理 | 旧part要求をmultipart sessionの取消で無効化し、completeとcancelをShow CASで競合させる設計が可能。追加Worker/bucket/product/S3 credentialsは不要 | **R2 uploadをCloudflare REST直PUTからWorker経由へ変更するため承認が必要。** session/part/complete/recoveryを新規実装・実証する必要がある |
| C: 管理端末からS3 multipartを直接操作 | multipartのupload IDを使う標準経路 | 管理端末へ別R2/S3 credentialを要求しない方針に反するため、採用しない |

推奨する検討候補はB。方式を黙って変更したり、Bの安全性が確認済みであると扱ったりはしない。

## Bを承認した場合の技術実証案

### 維持する利用者向け仕様

- Linux x86-64単一バイナリ、既存Cloudflare API token/管理キー、1 Worker/1 private R2を維持。
- `update-show`/`update-episode`/`update-episode-audio`はstagingのみ、`publish-*`だけがcommit markerを書き公開する。
- draft job IDとupload操作IDを分離。MP3上限300,000,000 bytes、size/内容の検証、成功前の旧draft/公開音源の保持を維持。
- リソース作成・Worker deployは引き続きCloudflare REST APIから行う。新しいSDK/runtimeやS3 credentialsを管理端末へ追加しない。

### プロトコルの候補

1. Show CASでstage ownerを取得。対象Show/Episode/draft、asset種別、操作ID、期待generation、全長/SHA-256を凍結する。CLIから任意のR2 keyを受け付けない。
2. 小さいmetadata/coverとMP3を、同じserver-owned upload sessionのルールで扱う。MP3はたとえば16,000,000 bytes単位に分割し、最終part以外を同じ長さにする。単一HTTPで300MBをWorkerへ送らない。
3. R2 multipart upload IDとpart番号/length/checksum/ETagをR2に耐久保存する。complete/abortはWorkerだけが行い、CLIのpart ETagや成功申告だけで検証完了としない。multipart IDの単なるresumeは存在確認ではない。
4. upload中断時はsessionを原子的に取消状態へ移し、新規part/completeを拒否。R2 multipart abortが成功し、旧completeが開始していないと確認してからstage ownerを解放する。cancelとcompleteのCASの勝者を1つにする。
5. complete開始後は、公開processingと同様に強制解放しない。応答喪失は同じ操作ID/phaseから再照会し、継続し得る旧invocationが書ける状態のまま別操作を始めない。
6. completion後のsizeと全量SHA-256を検証し、metadata/cover/音源の正規staging keyへの反映とdurable terminal receiptを書き終えてから解放する。失敗時は旧published mediaを壊さない。

### 必須の未解決ゲート

- createMultipartUploadの応答喪失/Worker中断で、upload ID保存前のorphanをどう扱うか。取消後の旧create/partがpayloadを再作成しないこと、期限だけでprocessingを解放しないこと。
- 部分body切断、同partの重複/不一致要求、last part、part hash不一致、completeとcancelの競合、abort/complete応答喪失を実機で確認する。
- R2 multipart ETag/custom metadataを全量SHA-256の検証に代用しない。全量read/hashをstreamで行う候補として[Workers DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#constructors)があるが、300MBのCPU/料金/Free制限は実測が必要。
- [Workers request body制限](https://developers.cloudflare.com/workers/platform/limits/#request-limits)はCloudflare account planに依存する（Free/Proは100MB）。[R2 multipart制約](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2multipartupload-definition)、同key writeのrate limit、128MBのisolate memoryを守る。大きなbodyの全量bufferをしない。
- R2 multipartには未完了uploadの既定abortがあるが、recoverable draft全体へのTTLは追加しない。取消済みupload/orphanと、再開可能なdraft/公開mediaを分けて扱う。
- 旧CLIの直PUTと旧Workerが完全に停止・収束したことを移行時に確認する。新APIだけではCloudflare token所有者の手動REST writeを禁止できない。

## 現在の進め方

uploading/processingの強制解放やdelete CLIは提供しないまま、状態schema・原子的受付・限定reserved abandon・読み取り専用移行plan・公開snapshot/path/cache keyの共通処理を進めている。Bを採用する場合は、まず方式変更の承認、その後に専用環境の技術実証を行い、成立後にCLI/Workerへ接続する。
