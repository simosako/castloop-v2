# M6.0 キャッシュ構成の実機実証

[`cache-worker.ts`](./cache-worker.ts)と[`verify-cache.ts`](./verify-cache.ts)は**専用環境だけで使う検証コード**。本番CLI/Workerの実装ではない。状態操作・seed・cleanupは試験fixtureを直接変更するため、運用bucketへ接続してはいけない。

## 実行方法

開発環境のBunと既存依存を使う。Cloudflare REST API tokenにはWorkers ScriptsとR2の作成・編集・削除権限が必要。アカウントの既存`workers.dev` subdomainを使い、独自ドメイン・DNS・Queueは作成/変更しない。

```sh
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
bun node_modules/typescript/bin/tsc -p experiments/m6/tsconfig.json
bun experiments/m6/verify-cache.ts
```

- 毎回ランダムな`castloop-m6-cache-<suffix>` Workerとprivate R2を作成する。既存の同名resourceがないことを先に確認し、既存サービスを再利用/上書きしない。
- Bunでbundleし、REST multipart module uploadに`cache_options`と`exports`を渡す。Wrangler・R2 S3 credentialsは使わない。
- default入口のcacheを無効化し、内部`CachedMedia` entrypointだけ有効化。公開可否は実装済み`readPublicVisibility`でR2から読み、公開可能な要求をloopback fetchへ渡す。generationはserver生成propsで指定する。
- raw結果とsecret入りmanifestは`/tmp/opencode/castloop-m6-cache-<suffix>/`へ出す。directoryは0700、manifestは0600。**manifestはGitや試験報告へ添付しない。** API tokenは保存しない。
- 成功/失敗時にテストpayloadと作成したWorker/bucketを削除し、resourceの不在を確認する。削除の応答喪失・一時エラーは有限回再試行する。cleanup失敗時も試験を成功終了扱いにしない。
- payloadは65,536 bytesの決定的なバイト列。path/content typeだけfeed/cover/MP3に合わせており、再生可能な音源や有効なXML/画像ではない。全量・部分bytesとcache動作を検証するためのもの。

## 試験内容

1. REST uploadでentrypoint別cache設定を配備し、upload応答のexportsとsettingsのcache設定を記録。
2. 内部MISS→HITでinner実行IDが同じになり、gateway実行IDは毎回変わることを確認。
3. cold/hot Range、suffix Range、416、warm/cold HEAD、HEAD後のGET全量を確認。
4. warm cacheを残したままEpisode停止404/削除410とShow停止404/削除410を確認。feed/cover/音源のGET/HEAD/Range、query/If-None-Matchでも停止を回避できないことを確認。
5. gatewayからのtag purgeでは内部cacheが変わらず、内部entrypointのRPC purgeでは更新bodyへ変わることを確認。tagなし音源のprefix purgeとcoverの非影響も確認。
6. control record破損時にwarm cacheへfallbackせず503になることを確認。
7. 内部responseを一時停止し、その間に停止/generation更新。旧response完了後も新要求は404、再開後は新generationで別inner実行になることを確認。
8. system/staging・内部class名の外部path・未認証管理要求を拒否。

外向け応答は試験では`Cache-Control: no-store`、内部は`public, max-age=300, must-revalidate`。本番の`max-age=0, must-revalidate`/conditional応答方針をこのfixtureで決定したわけではない。

## 2026-09-30 実測

最終実行は10項目すべて合格。Standard usage model、観測したHTTP応答50件のcoloはNRT。[`cache-results-20260930.json`](./cache-results-20260930.json)にsecretを含まない観測記録を保存し、判断と残件は[実装ログ](../../design/m6_implementation_log.md)へ記録した。作成したWorker/bucketは削除済み。

これはM6.0のcache/REST/Range構成実証であり、M6全体やFree対応、300MB音源、本番への移行、upload収束、削除consumerの合格ではない。複数colo・別hostname・負荷・実請求額の検証も含まない。

## CAS受付・限定abandon・REST uploadの追加実証

```sh
bun node_modules/typescript/bin/tsc -p experiments/m6/tsconfig.json
bun experiments/m6/verify-admission.ts
```

[`admission-worker.ts`](./admission-worker.ts)と[`probe-harness.ts`](./probe-harness.ts)を使い、別の新規Worker/private R2だけで実行する。検証用seed/cleanupは本番で使わない。作成したresourceは終了時に削除・不在確認し、途中のHTTP要求もすべてsettleしてから後片付けする。初回配備の一時的な500/Script not found等は、同一要求を有限回再送する。

2026-09-30、CAS/abandonの5チェックに合格。[`admission-results-20260930.json`](./admission-results-20260930.json)に記録する。ただしuploadゲートは**未通過**。既存objectへの不一致`If-Match`付きREST PUTが200で上書きされ、binding側CASと同じ条件付きwrite保証を使えなかった。runnerの終了コード0は「測定が完了しcleanupに成功」の意味であり、`uploadEvidence.conditionalRestSupported=false`をupload安全性の合格と扱わない。

**2026-10-01の方針更新**: 上記の「uploadゲート未通過」は条件付きREST PUT fenceを検討した時点の判断。この試験はクライアント切断後の保存継続を検証していない。M6では管理者判断によりREST単一PUTを維持し、切断後の遅延object作成がないと仮定する。[未解決懸念U1](../../design/m6_upload_recovery_options.md)として記録し、その解消・分割upload実証を公開条件にしない。既存JSON/試験コードは変更せず、方針決定を実測合格として扱わない。通常のupload排他・照合・回復ゲートは残る。

`abandonReservedShowOperation`は凍結requestとreserved ownerを同じCASで失効させる基礎関数だけ。processing/uploadingは拒否し、CLI/管理APIにはまだ接続していない。bindingでのCAS成功をREST object PUTの条件付き動作の根拠として流用しない。

## M6 standaloneの全体受け入れ（2026-10-04）

以下は上のseed/prefix cleanup試験とは別経路で、実M6管理API/consumerを試験専用binaryから使う。既存サービスを対象にしない。全resourceの専用prefixと同account、直前のacknowledged acceptance・paused owner・空registryを検査し、privateなbefore fileを`wx`で作ってから一度だけmutationする。

```sh
bun scripts/build-cli.ts linux-x64 --m6-test
bun experiments/m6/verify-lifecycle.ts /tmp/opencode/ACKNOWLEDGED_TEST_WORKSPACE
bun experiments/m6/verify-completion-recovery.ts /tmp/opencode/ACKNOWLEDGED_TEST_WORKSPACE
bun experiments/m6/verify-large-media.ts /tmp/opencode/ACKNOWLEDGED_TEST_WORKSPACE
```

- lifecycle: compatible-update受け入れ済みの小さい`fresh/first` fixtureで六操作を実行し、GET/HEAD/Range/304/416、404/410、GUID/revision保持、payload物理削除と永久記録保持を確認する。二回GETしただけでcache HIT合格とはしない。
- completion recovery: lifecycle合格後の同じpaused環境を通常更新し、serverの成功completion応答だけを試験transportで破棄する。local requested/server pausedを確認し、別のbinary commandで非書込照合する。強制終了したIOの収束証明とは別である。
- large media: recovery合格後に別Show `large`を作る。719424個の417-byte MPEG framesと192-byte ID3 prefixで正確な300,000,000-byte MP3をchunk書込・stream解析する。300,000,001 bytes拒否、audio-only/metadata-only改訂、全量stream checksum、GUID/date/history/旧音源保持、HEAD/suffix Range/304、最後に明示Show deleteを検証する。音声内容の聴取品質を検証するfixtureではない。
- cache: 試験Workerだけが内部/外部invocation nonceとinner cache statusをresponse headerへ追加する。feed/cover/小さい音源で、内部HITの同じnonceと毎要求異なるgateway nonceを照合する。通常Worker/公開binaryへ計測headerを追加しない。

mutationの自動再送、未知lock/tokenの解放、Worker/bucket/Queueの削除はしない。readonlyな観測競合だけ有限回待ち、失敗数を記録する。途中失敗は固定phase/codeだけ保存し、任意exception本文・secret・metadata本文は保存しない。before/incompleteを消して再実行してはいけない。既知の完了checkpointからの続行は個別に証拠を照合する。

各試験は成功時もserviceを明示pausedで残す。これらのscriptの実装・local型検査だけをCloudflare合格として扱わず、実行結果を設計logへ別途記録する。複数colo・独自domain・請求額・無停止移行・unknown live IOの解放・正式releaseは対象外。
