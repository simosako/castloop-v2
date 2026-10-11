# M6: 配信runtime gateとcache owner識別

更新日: 2026-10-01

## 実装した照合

`createM6DeliveryGate`をWorker effectの`checkDeliveryGate`へ渡せる独立adapterとして追加した。現在の本番routing/CLI deployには未接続であり、lifecycle操作やM6 readinessを公開する変更ではない。

副作用前のgateは以下を照合し、いずれかが欠けた場合は失敗させる。

1. 現invocationがservice CAS registryに登録されたM6 admin/consumer/recovery tokenを持つ。
2. serviceが移行完了済みM6 modeで、durable readinessを持つ。paused中の既存consumer/recoveryは収束できるが、migratingやlegacyは拒否する。
3. 本番adapterがuncached gateway protocolを実装しており、実行中Workerのversion metadata binding IDが検証済みcutoverのWorker version IDと一致する。
4. 内部cache ownerへの`describeRuntime` RPCがstrictな`m6-cached-assets-v1` / `CachedPublicAssets` / 同Worker version ID / purge API存在を返す。
5. RPCをawaitした後にservice token/readinessを再照合し、返却済みtokenや途中で変わった証拠を拒否する。

gateはR2書込もpurgeも行わない。Worker effectは対象とShow execution tokenを別途照合し、feed/purge/物理削除等の前後でgateを使う必要がある。consumer factoryでgate失敗した場合、公開状態/payload/purgeを進めず、通常終了後に既知Show execution tokenだけを返してjob ownerは保持する。今回の統合テストはShow停止consumerでこの振る舞いを確認した。

## Runtime RPC

`CachedPublicAssets.describeRuntime`は`this.env.CASTLOOP_VERSION_METADATA.id`と`this.ctx.cache.purge`の存在から小さいstrictな識別結果だけを返す。version metadataが未設定/不正、purge APIがない場合は失敗する。タイトル/説明/メール/admin keyや任意診断は含めない。内部RPCであり、HTTPの公開診断routeは追加しない。

接続時は同じWorkerに`{type: "version_metadata", name: "CASTLOOP_VERSION_METADATA"}` bindingを追加する。IDは管理API入力の自己申告ではなく、Cloudflare runtimeが現在実行しているversionのものを使う。

## このgateだけでは証明しないこと

- version metadataは**現在実行している1 invocationのversion**を識別するもので、全trafficの100%切替を証明しない。
- `ctx.cache.purge`の存在はpurge APIを利用できることを示すだけで、default cache無効/named entrypoint cache有効のREST設定を証明しない。
- runtime protocol定数の一致は本番adapterの契約であり、未接続の現行legacy入口に同じ文字列を渡して安全と見なしてはならない。
- 旧cache purge、旧Worker/CLI/PUTの終了、各hostname/coloのstate-first配信、料金/CPU/Free制限は別のmigration/runtime実機ゲートである。
- R2 readiness保存後にdeployment/route/cache設定を外部から変更した場合、このadapterが自動で全設定を検出するわけではない。後続のdeploy/migration/domain経路はservice排他と証拠の更新を必須にし、稼働中旧invocationの排除を単なる100%設定/時間経過から推測しない。

別entry moduleのM6候補Workerへnamed export/loopback/gateway/Queueを接続したが、現行binary/deployには接続していない。候補capabilityはcompiled gatewayの存在だけを区別し、M6管理操作とreadyはfalseを維持する。default/named cache設定・実binding・M6管理API/staging/CLI・runtime証拠の本番検証と安全な回復が成立するまでReleaseしない。`m6_candidate_worker.md`参照。
