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
