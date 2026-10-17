# CLIアップロードのsource完了順序（Issue #30）

## 調査対象と原因

[Issue #30](https://github.com/simosako/castloop-v2/issues/30)は、Bun 1.4.2の正式CLI子process＋loopback transportで、SQLite `update-show`のPUTがHTTP 200を返した後に`source_completed`検証が失敗する現象。
Cloudflare実環境へのPUT失敗を観測したものではない。

旧実装の順序は次のとおりだった。

1. 検証済みのprivate snapshotをNode `ReadStream`で開き、`Readable.toWeb`で送信bodyに変換する。
2. preloadがbodyをloopbackへ転送する。fixtureは`request.arrayBuffer()`と模擬R2保存をawaitしてからPUT receiptを返す。
3. CLIはHTTP 200とreceiptのkey/size/ETag/versionを検証する。
4. `requireConsumed()`がNode streamの`readableEnded`を同期的に調べる。

`Content-Length`の全bytesがtransportへ渡った時点と、元のファイルのEOFを追加readしてNodeの終了を観測する時点は同じではない。
前者だけでHTTP本文が完了できるため、後者が遅れると全量を受信・保存したfixtureの正常応答も手順4で拒否される。
責務はfixtureの応答前消費不足ではなく、共有CLI source adapterの完了順序にある。特定のBun内部不具合やCloudflareの取消保証を断定しない。

## 修正契約

`freezePayloadSources().withPayload()`はNode streamのasync iteratorをbackpressure付きWeb streamで包む。

- `highWaterMark: 0`で、consumerがreadするまでWeb streamへ先読みしない。
- 累積bytesが凍結長に達した最終チャンクは、次のiterator readでEOFを確認するまで渡さない。
- EOF確認後、完了flagの設定・最終チャンクのenqueue・closeを同じpullで行う。
- 短いsnapshot、余分なbytes、未読・途中消費・途中取消は完了扱いにしない。
- ファイル全体をbuffer化せず、既存のstream破棄・終了待機・handle closeと、active中のsnapshot削除拒否を維持する。

これにより順序を「元sourceのEOF確認→最終bytesの転送→fixtureの本文消費/保存完了→HTTP応答→receipt/source検証→全量readback」にする。
完了flagはローカルsourceの証拠にすぎない。PUT成功には引き続きreceiptとGETの全量size/hash/ETag照合が必要で、HTTP 200やflagだけでは成功しない。

SQLiteとQueueは同じsource helperを使うため、両者へ適用される。protocol、受付・settlement・journal契約は変更しない。
PUTの自動再送、完了判定のsleep/retry、未知IOの解放、U1の変更は行わない。

## ローカル検証

Linux / Bun 1.4.2 (`744846f84`)で確認した。

- 修正前の正式CLI単独テストは一度成功したが、別途行った連続実行の6回目にIssueと同じ`update-show` / `source_completed` / HTTP 200の失敗を再現した。
- 新規の決定的回帰テストでは、4 / 65,536 / 65,537 / 8,388,608 bytesをちょうど読み、追加のEOF readなしで即座に完了検査する。旧実装は4ケースすべて失敗し、修正後は通過する。
- 未読・部分読取・取消後の完了拒否と再送拒否、消費中のsnapshot切詰め・増大拒否を追加した。
- 既存のREST早期応答・receipt不正・readback不一致・取消待機、およびネイティブHTTPの8MiB snapshot送信も通過した。
- 修正後の正式CLI単独テストは20回連続で通過した。各回は新規のローカルfixtureであり、失敗したPUTの再送ではない。
- 修正後の`bun test`は1,276 pass / 0 fail（140 files）。
- `npm run check`、単体CLI build、生成binaryのversion表示と各commandのhelp表示も通過した。

Cloudflare資源の作成・配備・PUT・公開は行っていない。ローカル確認は過去CIの内部イベントを遡って証明するものでも、実Cloudflareの大容量性能・切断後取消を保証するものでもない。
