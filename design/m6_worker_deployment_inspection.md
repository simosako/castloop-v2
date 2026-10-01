# M6: REST deploy metadata準備と読み取り専用の設定検査

更新日: 2026-10-01

## 実装範囲

`buildM6WorkerUploadMetadata`と`CloudflareApi.inspectM6WorkerDeployment`を追加した。前者はupload用metadataを生成する純粋関数で、後者はCloudflare RESTのGETだけを実行する。現行`castloop deploy`/`init`はM6 uploadへ切り替えず、M6移行・lifecycleコマンドも公開しない。

現在のlegacy deployは、取得したWorker settingsに`CachedPublicAssets`または`CASTLOOP_VERSION_METADATA`があれば、PUT前に拒否する。これは誤ってM6 Workerをlegacy bundleで置き換えることへの追加preflightであって、サービス排他/移行受付やout-of-band変更の原子的な防止ではない。旧バイナリへこの拒否をretrofitするものでもない。

## Upload metadata

- compatibility dateは新経路の`2026-10-01`、`enable_ctx_exports`を明示する。既存の`disable_ctx_exports`は黙って除去せず、移行前の確認が必要として拒否する。
- global Workers Cachingは有効、cross-version cacheは無効。default exportをcache無効、`CachedPublicAssets`だけをcache有効にする。
- R2/Queue/DLQ/admin secretの既存契約を維持し、`CASTLOOP_VERSION_METADATA`のversion metadata bindingを追加する。loopbackは`ctx.exports`を使うため、別Workerへのservice bindingを作らない。
- admin keyが既存ならinheritし、取得結果からsecret本文をコピーしない。無関係なbindingもname/type=inheritだけを生成する。既存のsampling/destination/tag/tail/placement/logpushは保持し、logs/traces/observabilityは明示的に有効にする。
- 初期実装はmetadata生成/GET検査のみだった。その後、凍結bootstrap/旧IO確認/初期化完了bridgeからの候補PUTとpreview無効化を未公開adapterへ接続した（`m6_migration_client.md`）。指定bridge versionからstrict inheritし、version tagへbootstrap UUIDを固定する。初回bridge deploy/CLI書込command/full cutoverは未接続で、実uploadも行っていない。

## REST検査

同じaccount/service/Workerを対象に、deployments→指定version→settings→subdomain→settings→subdomain→deploymentsをGETする。

1. API仕様で最新active deploymentは配列の先頭。期待versionを1件だけ100%配信していることを確認する。複数version（0%を含む）・部分配信・別versionは拒否する。
2. 指定versionのresourceからfetch/queue/default gatewayと唯一のnamed cache entrypoint、明示的cache override、compatibility date/flag、R2/Queue/DLQ/admin/version metadata bindingを照合する。
3. current settingsにも同じ所有binding/default cache無効/named cache有効とcross-version cache無効、logs/traces有効を要求する。
4. workers.devを有効、old-version previewを無効にする。古いpreview URLを通常切替の対象外として放置しない。
5. 設定/preview/deploymentを再GETし、検査中の変化を拒否する。並び順や関係ないmetadataだけの変化は保持情報へ取り込まない。

返すstrictな証拠はallowlistedなservice/account/Worker/deployment/version IDと成立した設定条件だけ。author email、secret本文、deployment messageや任意API metadataを操作記録へ複製しない。

## 限界と実機残件

これはその時点で取得した設定の照合であり、読み取り後の設定変更を止めるlease/CASではない。旧invocation/REST PUT終了、旧cache purge、公開hostnameの網羅、HTTP state-first配信、consumer/admin routesの機能合格、CPU/Free/300MB/料金を証明しない。`old_io_quiesced`/`old_cache_purged`/`cutover_verified`等の移行完了条件へ無条件に変換してはならない。

自動テストはdocs形状を使ったmock REST。version/settings responseの実際のbinding/exports形状、version metadata・cache override・preview反映は専用Cloudflare環境で検証が必要である。必要なfieldが取得できない場合はfail closedとし、100%配信やcache設定を推測しない。

参照:

- https://developers.cloudflare.com/workers/cache/configuration/
- https://developers.cloudflare.com/workers/runtime-apis/context/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
