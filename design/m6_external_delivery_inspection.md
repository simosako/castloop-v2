# M6: 外部公開URLの読み取り専用HTTP検査

更新日: 2026-10-02

## 範囲

未公開の`packages/cli/src/migration-public-delivery.ts`へ`inspectMigrationPublicDelivery`を追加した。凍結移行planと対象Worker versionを使い、service設定の公開HTTPS originへ外部HTTP要求を送る部品である。CLI commandや移行finalizerにはまだ接続しない。

公開path parserをsharedへ移し、Worker側は互換re-exportを維持した。同じallowlistでfeed/cover/immutable audioだけを選び、system/staging/current metadata/revision TOMLを要求しない。planの全公開assetに対応するShow/Episodeが必要で、期待HTTP状態は凍結lifecycleから決める。公開中の空payloadは1-byte Rangeで検査できないため拒否する。

## 検査契約

- service identityとplanをstrictに検査し、公開URLはcredentials/query/fragment/pathを持たないHTTPS originだけを使う。管理key・API token・Cookieを要求へ添付しない。追加hostnameや任意URLを引数から受け付けない。
- cursorは0〜asset件数、1ページは1〜20 assets（既定2）。1 assetにつきHEAD、GET、先頭1-byte Range、凍結ETagの条件付きGETを順に一回ずつ送る。redirectを拒否し、自動retryしない。各要求のtimeoutは30秒であり、旧IO終了や復旧の判定期限ではない。
- activeは200/206/304、停止・draftは404、削除済みは410を期待する。全応答のWorker version・migration IDと、activeの外部再検証header、非公開状態のno-storeを照合する。activeでは凍結ETag/size、206ではContent-Range/1-byte lengthを検査する。
- `Accept-Encoding: identity`を指定し、圧縮されたactive応答を拒否する。通常GET/エラー本文は読まず、cancel終了までawaitする。Rangeだけは1 byte/最大16 readsで終了を確認する。取消失敗・transport失敗・不正応答は固定診断にし、任意本文/exception/secretを返さない。
- 未終了のresponse IOを残して次の要求や成功reportへ進まない。他のreaderが所有する応答も採用しない。

reportはservice/migration/version/origin、plan hash、検査pageのcursor/件数と観測hashだけを返す。payload・path一覧・ETag・secretを複製しない。file・R2 record・registry・bootstrap progressを変更せず、tokenも取得/解放しない。

## 証拠の限界

常に`snapshot_only=true`、`authorizes_completion=false`、`authorizes_mutation=false`、`payloads_verified=false`、`routing_scope_verified=false`を返す。0件のpageも移行完了とは扱わない。

これは単一originから実際に返った応答の限定snapshotであり、全hostname/colo・100% routing・旧cache全scopeの消去・旧IO終了・以後の設定変更防止を証明しない。通常GETは本文を全量hashせず、1-byte Rangeも300MB音源の完全性/再生やruntime受け入れを証明しない。全pageの観測だけで`cutover_verified`やreadinessを成立させない。

## 検証と残件

mock transportで状態別status、7種の公開asset、page境界、拒否path/foreign service、version/cache/ETag/size/encoding/Range/304/redirect/応答取消失敗、空chunk継続のread上限、live cancellationのawaitを回帰した。実候補gateway/named配信への結合でも、bootstrap settlement前の503拒否、settlement後の3 assets検査、全R2記録不変・migrating/readiness未成立を確認した。

結合transportとR2/cacheはローカルmockであり、実Cloudflare・外部DNS/TLS/coloの合格ではない。専用環境への接続、凍結外部検査対象と最終証拠の保持、full cutover/finalizer/明示受付再開は引き続き残件である。
