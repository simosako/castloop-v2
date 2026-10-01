# M6: 初回bridge deployの読み取り専用準備

更新日: 2026-10-01

## 現在の範囲

`CloudflareApi.prepareMigrationBridge` / `prepareMigrationBridgeDeployment`は、既存legacy WorkerのREST GET照会からstrictなbridge upload metadataと準備requestを返す。Cloudflare書込・deploy・preview設定変更・R2初期化・移行受付・local journal保存は行わない。CLI commandへも公開していない。現行`deploy/init`と既存v0.1.1環境は未変更である。

初回bridgeはまだ通常deployで代用しない。専用のdurable一度限り開始、全REST終了待ち、実行bridge version/tag照合、preview無効化、read-only inspectionと中断時のunknown outcome保持を実装してから切り替える必要がある。候補PUTの既存journalはserverに凍結plan/開始許可がある工程用であり、移行APIのない旧Workerへの初回deployには流用しない。

## GET照合

対象は同Cloudflare accountの既存workers.dev serviceに限定し、期待するlegacy version UUIDを明示指定する。deployments→version→settings→Custom Domains→subdomain→settings→subdomain→deploymentsをGETし、次を要求する。

- 期待versionが単独100%を配信し、最後のGETまでdeploymentが変化しない。
- 旧versionはdefault-onlyのfetch/queue Workerで、R2/Queue/DLQ/admin secretがservice設定と一致する。named entrypoint、migration用version metadata binding、重複binding、別/欠落したresourceを拒否する。
- 旧compatibility dateは妥当なISO date（APIの午前0時表記も正規化）で、bridge buildの2026-10-01より新しくない。versionとsettingsのdate/flags/全binding snapshotを照合し、`disable_ctx_exports`は拒否する。
- legacy global cache有効と実行versionのdefault cache設定が照会できる。unknown/missing runtime fieldから設定を推測しない。settingsのexportsがある場合はversionとも一致させる。
- attached Custom Domainがなく、workers.devが既に有効である。旧previewは有効/無効を記録するだけで、この準備GETでは変更しない。
- settings/preview/deploymentを再GETし、途中の変化を拒否する。settings hashはschemaで未使用のfieldも含む元の応答object全体から計算し、追加KV等のbinding parameter変更も見逃さない。

metadataはdefault cache無効/唯一のdefault export/global cache有効/cross-version無効、version metadata binding、`enable_ctx_exports`、logs/traces有効を明示する。admin secret/追加bindingは期待legacy versionからstrict inherit用のname/type/version IDだけを生成し、本文やnamespace情報を複製しない。既存sampling/tag/tail/placement/logpushは保持し、version tagはbridge UUIDに固定する。

## 準備requestと証明範囲

strict requestにはservice/account/Worker/bridge UUID、期待legacy version/deployment UUID、旧date/cache/previewの観測値、settings/version profile/source/metadataのSHA-256だけを返す。author email、secret、Worker source、metadata本文を操作recordへ保存しない。

旧`cross_version_cache`が取得できなければ`unspecified`とし、Cloudflareのdefaultを推測してenabled/disabledへ変換しない。bridge metadataで明示的falseにしても旧version/cache scopeが消えたとは扱わない。

これはGET時点の準備であってatomic deploy fenceやsource実体のremote checksumではない。returned requestのdurable保存とPUT直前の同snapshot再照合は次の初回deploy driverで必要になる。旧CLI/PUT/consumerの終了、他端末のdeploy禁止、全route/hostname/colo、preview撤去、旧cache全scope purge、最終cutover/readinessを証明しない。未知fieldで安全な照合ができない場合は推測せず保留する。

## 検証

mock RESTのGET-only結合とpure helperで、v0.1.1型のexports省略/settings日付表記、旧preview有効、cross-version未指定/true/false、secret非コピー、resource/version/handler/date不一致、追加binding parameter差異、部分配信、Custom Domain、settings/deployment/preview変化、共通upload gateとcandidate export拒否を確認した。Cloudflare実deploy・実機response shapeの合格ではない。
