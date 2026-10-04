# M6: 未公開のREST単一PUT・ローカルsource adapter

更新日: 2026-10-02

`staging-sources.ts`、`staging-rest.ts`、`staging-rest-operation.ts`をdurable staging runnerへ接続した。公開CLIや候補Workerの書込routeには接続しない。既存Cloudflare環境への適用・実機合格ではない。

## 固定入力とIO所有

- 正規化したmanifestと各assetのsize/checksumを凍結する。regular fileだけをno-followで開き、size/hashと読取前後statを照合する。asset上限はshared schemaでsnapshot作成前に検査する。
- `.castloop/upload-inputs-<random>/`のprivate directoryへ64KiBずつcopy/hashし、fsyncした読み取り専用snapshotを作る。本文は一時的なローカルpayloadであり、保持journalにsource path/title/本文/secretを記録しない。元ファイルは消さない。
- claim/beginの直前と各PUT前に、編集可能な元ファイルを凍結checksumへ再照合する。begin後に元ファイルが変わってもPUTは固定snapshotを読む。publication時の最新local draft照合は別途必要である。
- durable runnerはclaim/beginのrequested保存より前にも`checkLocalInputs`を実行する。beginはread-only owner照会の後に検査し、その間の編集も拒否する。この送信前検査の失敗はprepared/claimedを保ち、元の凍結入力へ戻した後に明示操作をやり直せる。requested保存後の検査/送信/応答不明は従来どおり未知として凍結し、再送しない。
- source sessionとREST adapterの両方が各indexを一度だけ消費する。stream終了前の早期応答は成功としない。fetch/response処理、source streamのdestroy/終了・handle close、response cancellationをawaitする。稼働中IOがあるsessionのdisposeは拒否する。
- disposeはこのsessionが作成したexact snapshotと空directoryだけを除去する。強制終了で残ったsnapshotは自動期限cleanupしない。残存snapshotからPUT許可を復元しない。ローカルdisk失敗後の外部cleanup/recoveryは未提供である。

## REST契約

- 固定`api.cloudflare.com`、serviceのaccount/bucket、manifest由来のexact staging key/length/hashだけを使用する。account一致の環境credentialsを使い、redirectを拒否する。
- PUTは一回だけ。REST `If-Match`/`If-None-Match` fence、multipart、別R2 credentials、Wrangler依存を追加しない。応答は64KiB以下のJSON success/sizeを確認する。
- 同じkeyをGETし、Rangeでない200の全量size/SHA-256をstreamで検証する。失敗・timeout・応答喪失・取消失敗で自動再送しない。GET/PUTのapplication retryもない。
- runnerはIO終了後も明示settlement/finishを別途要求する。GET成功はserver側の検証tokenやpublicationを代替しない。HTTP handlerの独立検証・owner/generation照合を維持する。
- 接続終了をCloudflare側の遅延確定不在の証明にはしない。承認済みの未検証仮定U1を維持する。native runtimeの一般的なretry/切断保証を新たに主張しない。

2026-10-04の[完全性検証調査](./m6_upload_integrity_review.md)では、上記の現行契約を、CLIの全量照合証拠＋Worker HEADのidentity照合とR2の公開保存時checksum検証へ集約する案を推奨した。まだ証拠伝達を実装しておらず、現在のHTTP独立hashを削除済みとは扱わない。

## 検証と残件

mock RESTと実Bun/loopback HTTPでexact path/header、3種stagingの明示完了、8MiB snapshot転送、転送中の元ファイル変更、checksum/size/過大応答/早期応答/Range/応答喪失、取消await、live IO中dispose拒否、symlink/foreign account/再送拒否を確認した。Cloudflare RESTの実経路・300MB資源使用量・CLI公開・最新draft/publication照合・unknown outcomeの安全な外部復旧は別の残件である。
