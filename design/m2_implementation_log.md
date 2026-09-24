# M2 実装・検証記録

## 2026-09-24: Showと1 Episodeの公開経路

- `update-show`はstrictなローカルTOMLとJPEG/PNGを検査し、同じ未公開jobのstagingへ両方を置く。`publish-show`はローカルとstagingの入力hashを照合し、Show単位の共通受付枠をWorkerの条件付きPUTで取得した後、`commit.json`を最後に置く。Workerは入力を検証してから`processing`へ移り、Show snapshot・固定キー画像・feedを更新し、feed/画像のtag purge後にstatus=`published`と受付=`free`へ進める。
- `update-episode`と`update-episode-audio`は同じ未公開jobへTOMLとMP3を別々にstagingする。MP3はWrangler uploadより前に300,000,000 bytes以下と判定し、CLIで`ffprobe`からcodecとdurationを調べる。`publish-episode`は両入力のローカルhashを再照合してからcommit markerを置く。WorkerはR2の音源サイズを確認し、既知長のstreamでSHA-256を照合しながらimmutable revisionへコピーする。revision履歴・current metadata・feed更新・feed tag purge・job status・予約解放を同jobの再実行で収束させる。
- 公開Workerは許可したfeed・固定キー画像・revision MP3だけを配信し、R2の`system/`と`staging/`は公開しない。CLIの`job-status`でR2 status、commit、受付、DLQ記録を照合できる。DLQの形式不明な通知もprivate R2の`system/dlq/unmatched/`へ保持する。

### 専用サービスでの実測

M1で作成した検証専用サービス（`/tmp/opencode/castloop-m1-smoke/`）を使用した。ShowとMP3は技術試験用の小さな入力。API tokenや管理用keyは文書・Gitには保存していない。

| ケース | 結果 |
| --- | --- |
| Show初回公開・更新 | `demo-show`で`update-show`後のfeed/coverは未変更のまま。`publish-show`後、R2 status=`published`・受付=`free`。2版目は両URLで新内容の`MISS → HIT`、画像bytes一致。ローカルTOMLをstaging後に変更した場合はcommit前に拒否した |
| Episode stagingと公開 | `first-episode`のTOMLと49 KBの有効MP3を別々にstagingし、commit前はfeedにitemなし。commit後に同jobで公開され、feedにGUID・enclosure・RFC 2822のpubDateを含むitemが追加された。metadataとrevision履歴、immutable MP3をR2に保持 |
| 音源配信 | GET `200`・HEAD `200`、有効Range `206`で10 bytes、範囲外Range `416`。MP3 GET本文のSHA-256はローカル元ファイルと一致。feedはEpisode公開後の新内容で`MISS → HIT` |
| 途中失敗からの回復 | 初回の実機検証ではR2の長さ不明streamの書き込みが失敗し、status=`retrying`・受付=`processing`を保持。`FixedLengthStream`へ修正し、同じ凍結jobを明示的に再投入して`published`・`free`に収束した。ローカルテストではShow/Episode両方のpurge失敗時に解放しないことを確認 |
| DLQの照合 | 上記の最初の失敗では、DLQ consumer導入前の配送について**R2 DLQ記録が残らなかった**。その後、DLQ consumerの記録経路を追加し、同じcommitへの診断メッセージを検証用DLQに手動で投入して`dlq: true`の記録と`retry-job`による明示的な再送を確認した。最初の配送がどの段階で消えたかは不明 |
| Show再更新 | Episode公開後のShow更新でfeedのShowタイトルが変わり、既存Episode itemは残った |
| 上限前拒否 | 300,000,001 bytesの疎なMP3をCLIがアップロード前のサイズ確認で拒否。R2へは送っていない |

**現状:** 初回Show＋Episodeの製品経路は実機で通った。metadataのみ・audioのみの更新、複数Episodeの競合、cleanupはM3の範囲。実公開jobのretry超過からDLQ記録までの一連の状態照合は追加の障害注入で確認する。

### 実Queueのretry超過からDLQ記録まで（2026-09-24）

検証専用Workerを**一時的に**診断ラッパーへ切り替え、特定の未登録jobId（`fe4253ab-9708-4806-a908-6186ec211051`）へのQueue通知だけを失敗させた。該当する公開job・commit marker・Show予約は作らず、既存のShowとEpisodeは変更していない。主Queueへテスト通知を送り、`max_retries: 2`による失敗を経て同じDLQに届いたメッセージを、製品のDLQ consumerがR2の`system/jobs/<jobId>/dlq.json`へ記録し、管理用status照会で`dlq: true`になるまでを確認した。終了時に**通常のM2 Workerへ戻した**。

このテストはQueueとDLQ consumerの接続・R2記録を実測したもの。実公開jobの途中失敗、purge失敗、statusと同時に発生したDLQ配送ではない。先の実公開jobでDLQ記録が欠けた理由を、存在しない記録で埋めたものとしては扱わない。M2の公開経路・管理者の同job回復は成立しており、実公開jobのretry超過とDLQ記録の組合せは後続の障害注入で継続確認する。
