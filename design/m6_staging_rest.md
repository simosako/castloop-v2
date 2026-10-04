# M6: 未公開のREST単一PUT・ローカルsource adapter

更新日: 2026-10-04

`staging-sources.ts`、`staging-rest.ts`、`staging-rest-operation.ts`をdurable staging runnerへ接続した。M6試験専用CLI/管理routeで使い、通常releaseの書込gateは開けない。既存サービスの変換・未知ownerの解放は行わない。

## 固定入力とIO所有

- 正規化したmanifestと各assetのsize/checksumを凍結する。regular fileだけをno-followで開き、size/hashと読取前後statを照合する。asset上限はshared schemaでsnapshot作成前に検査する。
- `.castloop/upload-inputs-<random>/`のprivate directoryへ64KiBずつcopy/hashし、fsyncした読み取り専用snapshotを作る。本文は一時的なローカルpayloadであり、保持journalにsource path/title/本文/secretを記録しない。元ファイルは消さない。
- claim/beginの直前と各PUT前に、編集可能な元ファイルを凍結checksumへ再照合する。begin後に元ファイルが変わってもPUTは固定snapshotを読む。publication時の最新local draft照合は別途必要である。
- durable runnerはclaim/beginのrequested保存より前にも`checkLocalInputs`を実行する。beginはread-only owner照会の後に検査し、その間の編集も拒否する。この送信前検査の失敗はprepared/claimedを保ち、元の凍結入力へ戻した後に明示操作をやり直せる。requested保存後の検査/送信/応答不明は従来どおり未知として凍結し、再送しない。
- source sessionとREST adapterの両方が各indexを一度だけ消費する。stream終了前の早期応答は成功としない。fetch/response処理、source streamのdestroy/終了・handle close、response cancellationをawaitする。稼働中IOがあるsessionのdisposeは拒否する。
- disposeはこのsessionが作成したexact snapshotと空directoryだけを除去する。強制終了で残ったsnapshotは自動期限cleanupしない。残存snapshotからPUT許可を復元しない。ローカルdisk失敗後の外部cleanup/recoveryは未提供である。

## REST契約

- 固定`api.cloudflare.com`、serviceのaccount/bucket、manifest由来のexact staging key/length/hashだけを使用する。account一致の環境credentialsを使い、redirectを拒否する。
- PUTは一回だけ。REST `If-Match`/`If-None-Match` fence、multipart、別R2 credentials、Wrangler依存を追加しない。応答は64KiB以下のJSON success・固定key/size・ETag/versionを確認する。sizeは安全整数numberまたはdecimal integer stringに限定する。identityの欠落は補完せず失敗にする。
- 同じkeyをGETし、PUT ETagと一致するstrong quoted ETag、Rangeでない200、全量size/SHA-256をstreamで検証する。全IO終了後にasset/size/SHA-256/ETag/versionの小さい証拠を返す。失敗・timeout・応答喪失・取消失敗で自動再送しない。GET/PUTのapplication retryもない。
- runnerはIO終了後も明示settlement/finishを別途要求する。証拠をprivate journalと認証付きsettlementへ保存し、Workerはexact owner/generation・終了確認・manifest・HEAD size/ETag/versionを照合する。音源のWorker GET/全量再hashはしない。metadata/coverのbounded schema/identity/形式検査、検証token、明示publicationは維持する。
- 接続終了をCloudflare側の遅延確定不在の証明にはしない。承認済みの未検証仮定U1を維持する。native runtimeの一般的なretry/切断保証を新たに主張しない。

2026-10-04、管理者が承認した[完全性検証案B](./m6_upload_integrity_review.md)を実装した。CLI証拠は認証済み管理者の観測を信頼するものであり、Worker独立hashや別REST接続の終了観測と表示しない。公開音源はR2 binding PUTのSHA-256検証とHEAD native checksum照合で確認する。

## 検証と残件

mock RESTと実Bun/loopback HTTPでexact path/header、3種stagingの明示完了、8MiB snapshot転送、転送中の元ファイル変更、checksum/size/過大応答/早期応答/Range/応答喪失、取消await、live IO中dispose拒否、symlink/foreign account/再送拒否を確認した。新規専用`castloop-m6-test-7c97f1a0`でもShow/小さいEpisode公開とREST receipt/GET/HEAD identity照合を通した。300MBを含む全受け入れ、通常CLI公開、unknown outcomeの安全な外部復旧は別途[受け入れ記録](./m6_standalone_acceptance.md)へ記録する。
