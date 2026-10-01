# M6: 候補Worker入口のgateway/consumer統合

更新日: 2026-10-01

## Entry module

`src/m6-worker.ts`を現行の`src/index.ts`とは別の候補entry moduleとして追加した。default fetch/queueと`CachedPublicAssets`のnamed exportを同じbundleに含め、`ctx.exports.CachedPublicAssets`のloopbackをgateway/consumerへ渡す。既存の実行バイナリのembedded Workerと`castloop deploy`/`init`は引き続き`src/index.ts`を使う。候補Workerを運用/既存v0.1.1環境へdeployしていない。

## Public fetch

1. 許可された公開pathのGET/HEADだけを処理する。system/staging/未知pathは配信しない。
2. strict/boundedなpublished service設定とservice admissionを毎要求読む。M6 mode・durable readiness・現在のWorker version metadata IDとの一致を必須とし、legacy/未移行/移行中/別versionは503/no-storeにする。
3. lifecycle gatewayが毎要求Show/Episode状態を照会してから、正確なgeneration propsでnamed cacheへ渡す。Range/validatorだけを転送し、host/query/Cookie/管理キーをcache transportへ持ち込まない。
4. 停止404、削除中/削除済み410、不正control/cache障害503をno-storeで返す。成功/304は外部再検証を必須にする。cached response/304でも状態照会を省かず、障害時にlegacy feed配信へfallbackしない。

この入口はdefault cache無効のREST metadataと組み合わせる必要がある。codeだけでcache設定が成立したとはしない。

## Queue/DLQ

- service設定とenv DLQ名を照合し、設定されたprimary Queue/DLQ以外や複数message batchを副作用前に拒否する。
- readiness/versionを照合後、同じservice registryにM6 consumer invocationを登録し、新publication/lifecycle consumerへdispatchする。effect factoryはShow execution token取得後に作り、配信gateのservice token/readiness/version/cache owner照合と内部purge/Queue送信を利用する。
- Show/Episode publicationは凍結manifest付きの新consumerだけを使う。legacy markerを新manifestへ暗黙に昇格したり、旧publisherへfallbackしたりしない。
- lifecycle削除の続行は同じ凍結jobのmarkerへ送る。Show execution tokenは正常にawait済みの終了後に返し、続行送信を含む全callback終了後だけservice tokenを返す。取得応答喪失/強制終了の未知tokenを時間で奪わない。
- DLQ到達は固定diagnostic/対象markerを保存するだけで、job status/Show ownerを変更・解放しない。未知primary通知は無視し、未知DLQは本文/secretを保存せずallowlistedなreasonだけを記録する。

## 管理APIとcapability

候補入口の通常管理APIは認証されたGETだけである。現行のjob-status/current/published照会を利用できるが、reservation/claim/retry/cleanup/staging/publication/lifecycleの管理書込は409で拒否する。独立した移行bootstrapのsettlement/HTTP検査だけを`/admin/migration/`へ接続した。full cutover/完了/受付再開は未提供である。`m6_migration_bootstrap.md`参照。

capabilityは`worker_protocol=m6_candidate`とcompiled gatewayの`lifecycle_delivery=true`を返すが、未提供の管理操作・M6 staging/publication commandはfalse、`m6_ready=false`を維持する。これは候補codeの接続状態を表すもので、実機合格やRelease可否を表さない。healthも`result=candidate`/`m6_ready=false`であり、通常初期化への置換を意図しない。

## 検証と残件

自動統合でstate-first GET/HEAD/Range/validator transport、cached 304からの停止/削除、foreign/missing readiness、cache fail-closed、候補APIのread-only、Show/Episode初回/2種改訂の新consumer、Show停止/物理削除と同job続行、live purge中の2種token保持、DLQ、legacy marker拒否、service token取得応答喪失を確認した。媒体stream digest/cacheは既存mockによる検証であり、Cloudflare実機ではない。

候補入口はreadinessも初期化完了bootstrap windowもない間、公開pathを503にする。初期化→凍結deploy→明示settlement→HTTP検査の順序を追加したが、外部切替/最終証拠/受付再開・移行可用性はまだ完成していない。候補の503やloopback合格だけを見て`cutover_verified`/`publication_routes_verified`を成立とすることは禁止する。

次に移行管理API/CLI、bootstrapの原子的なdeploy受付、旧IO終了確認、旧cache purge、本番REST設定検査/HTTP検証、rollback、staging/publication/lifecycleの管理操作を接続する。token取得応答喪失/強制終了の安全な復旧も残る。これらが成立するまで候補入口を現行バイナリのdeployへ接続せず、6 lifecycleコマンドを公開しない。
