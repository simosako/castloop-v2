# M6: 単一PUTの維持と切断後書込の未解決懸念

更新日: 2026-10-01

状態: **現行のCloudflare REST単一PUTを維持する方針を決定（2026-10-01）。切断後の遅延書込は未解決の懸念として保持する。** [M6設計](./m6_content_lifecycle_plan.md)と[実測ログ](./m6_implementation_log.md)の補足。

## M6の決定事項

管理者の指示により、M6では**クライアント切断後に、そのPUTが遅れてobjectを作成・更新することはない**と仮定し、metadata/cover/MP3を従来どおりCloudflare REST APIの単一PUTで送る。Worker経由の分割upload sessionは採用せず、この懸念の解消や方式変更をM6の公開条件にしない。

これはCloudflareの確認済み仕様や実機実証ではなく、未確認のリスクを認識した上での設計上の仮定である。下記の懸念と既存の`If-Match`実測は記録に残す。サポートへの問い合わせは行わず、困難な境界条件のローカル再現を合格の根拠にしない。

同じShowのupload/publication/lifecycle間の原子的排他、PUT成功後のsize/内容照合、明示的publish、300,000,000 bytes上限は維持する。通信がまだ継続中のPUTや、書き込み可能なWorker/consumerを時間切れ・HEAD不在だけで解放する許可ではない。中断後の受付回復はこの仮定の下でowner/generationを照合して実装し、終了・再試行・解放の競合を検証する。現行の基礎関数がuploadingのabandonを拒否することは、変更方針が未接続である実装状況として区別する。

## 未解決の懸念 U1: クライアント切断後の単一PUT確定

- **未確認の点**: REST単一PUTのbody全量受信後・metadata commit前にクライアントが切断した場合、保存処理が必ず中止されるか。切断後にcommitするか、終了を確認する手段があるかは公開資料から確認できなかった。
- **確認済みの点**: [R2の内部構成説明](https://developers.cloudflare.com/r2/how-r2-works/#write-data-to-r2)はデータ保存→metadata commit→object可視化→200送信の順序を説明する。[R2の整合性仕様](https://developers.cloudflare.com/r2/reference/consistency/)は競合するPUT/DELETEで最後に完了した操作が勝つとする。どちらもabort後の保存継続を証明するものではない。
- [IncompleteBody/ClientDisconnect](https://developers.cloudflare.com/r2/api/error-codes/)はWorkers/S3 APIのエラー仕様であり、[現在のREST Upload Object](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)の取消保証へ無条件に流用しない。公開事例・binding側の公開実装からも、対象REST経路でabort後に保存が完了する根拠は得られなかった。
- 部分的なobjectが読取可能になり、その部分ファイルをDELETEすることを前提にしない。単一PUTは完成objectの保存として扱う。既に保存されたobjectの成功応答喪失と、まだ確定していないPUTの切断は区別する。
- **仮定が誤っていた場合の影響**: 削除側の列挙時にはobjectがなく、受付解放・削除完了後に旧PUTが確定するなら、staging payloadが残る可能性がある。これは確認済みの障害ではなく条件付きのリスク想定である。公開状態のtombstoneによる配信拒否と、R2 payloadの物理削除は別の保証である。
- **扱い**: U1は未解決のまま記録し、M6をブロックしない。反例や明確な公開仕様が得られた場合は、受付解放・削除完了条件とupload方式を再検討する。仮定の成立をテスト合格や削除保証の実証と表示しない。

## 実測で分かった制約

既存CLIはCloudflare R2 REST object PUTでmetadata/cover/MP3を直接送る。MP3の上限300,000,000 bytesを維持し、管理端末へS3 credentialsや別runtimeを要求しない。

専用R2で既存objectへ不一致`If-Match`付きPUTを送った結果、HTTP 200で上書きされた。[証拠](../experiments/m6/admission-results-20260930.json)を参照。R2 binding側のonlyIf/CASは成立しても、このREST object PUTに同じ保証はない。

この実測は条件付きREST PUTをfenceとして使えないことを示すが、クライアント切断後にPUTが保存を続けることを示さない。以前はその未確認の可能性をM6公開ゲートにしたが、上記の管理者判断で未解決の懸念へ変更した。HEAD不在や一度の再列挙をU1解決の証拠にはしない。

## 以前検討した選択肢と今回の採否

| 選択肢 | 利点 | 制約/判断 |
| --- | --- | --- |
| A: 現行直PUTを維持 | 既存のCloudflare REST経路・300MB対応を変えず、実装を簡潔に保つ | **M6で採用。** 切断後に遅延object作成がないという仮定を明示し、U1を残す。通常の排他・照合・回復実装は必要 |
| B: 同じWorkerの認証付きAPIで分割upload sessionを管理 | completeとcancelの権限をサーバー側へ集約する候補。追加Worker/bucket/product/S3 credentialsは不要 | **M6では採用しない。** 当初の候補であり安全性は未実証。将来変更する場合は改めて承認・実証が必要 |
| C: 管理端末からS3 multipartを直接操作 | multipartのupload IDを使う標準経路 | 管理端末へ別R2/S3 credentialを要求しない方針に反するため、採用しない |

当初はBを推奨候補にしたが、未確認のU1を理由に方式変更が必要とする根拠は不十分だった。今回の決定はAであり、Bの案は比較・経緯としてのみ保持する。

## 参考: Bの技術実証案（M6では実施しない）

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

現行REST単一PUTを維持し、原子的なstaging受付、PUTの照合、切断後の回復・受付解放を新recordへ接続する。U1の解消や分割sessionの実証はM6公開ゲートにしない。publication processingの強制解放は禁止したまま、cache・移行・削除consumer・CLIの残るゲートを進める。今回の文書更新ではruntimeやCloudflareリソースは変更していない。

### staging受付の実装契約（2026-10-01）

`claimStageUpload`/`beginStageUpload`は操作IDとdraft job IDを分離し、同じShow CASのuploading ownerと、凍結asset/size/hashからの固定keyを使う。ready→uploadingのCASで1 callerだけがPUT許可を取得し、開始済みの再送や開始応答喪失では新しいPUT許可を発行しない。

`settleStageUpload`には`put_requests_settled=true`と`no_more_puts=true`の明示的な申告が必要である。単一PUTが継続している間や、旧clientが後でPUTを開始/再試行し得る間は申告してはならない。新client helperは自身の全PUTをawaitして以後PUTしない場合だけ送信し、beginの結果不明では自動送信しない。別端末からの回復も旧clientの終了確認が必要である。この申告は認証された管理者/準拠CLIの契約であって、R2/Workerが別経路のREST接続終了を直接証明するものではない。Cloudflare tokenによる手動REST書込や虚偽の終了申告を防ぐ保証はない。

終了確認だけではownerを解放しない。内容検証と検証実行排他・receiptが必要であり、時間/HEAD不在だけの解放は追加しない。これらの基礎関数とclient helperは既存CLI/管理APIへ未接続である。
