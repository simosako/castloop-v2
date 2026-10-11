# M6: 初回bridge deployの読み取り専用準備

更新日: 2026-10-02

## 現在の範囲

`CloudflareApi.prepareMigrationBridge` / `prepareMigrationBridgeDeployment`は、既存legacy WorkerのREST GET照会からstrictなbridge upload metadataと準備requestを返す。Cloudflare書込・deploy・preview設定変更・R2初期化・移行受付・local journal保存は行わない。bridge書込commandへは公開していない。同じGET照合を使う非書込`migration-preflight`だけをsource CLIとこのcheckoutからbuildするbinaryへ追加した。現行`deploy/init`と既存v0.1.1環境は未変更である。

初回bridgeは通常deployで代用しない。専用のdurable一度限り開始、全REST終了待ち、実行bridge version/tag照合、preview無効化、read-only inspectionとunknown outcome保持を未公開helperへ接続した（`m6_initial_bridge_client.md`）。CLI/実機/安全なunknown復旧のgateは未完了である。候補PUTの既存journalはserverに凍結plan/開始許可がある工程用であり、移行APIのない旧Workerへの初回deployには流用しない。

## GET照合

service workspace rootで次を実行する。期待version UUIDは管理者が確認した値を指定し、自動で最新versionを採用しない。

```sh
castloop migration-preflight LEGACY_VERSION_ID
```

`castloop.toml`と同accountの`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`が必要で、admin secret、local state/journal、Wranglerは不要である。出力はaccount ID/source/binding本文を除いたstrictな観測値/hashで、`snapshot_only=true`、`authorizes_deployment/mutation/recovery/migration_completion=false`を固定する。UUID生成・upload metadata作成・private lock取得・journal保存・Worker管理POSTは行わない。released v0.1.2 binaryには含まれない。

対象は同Cloudflare accountの既存workers.dev serviceに限定し、期待するlegacy version UUIDを明示指定する。deployments→version→settings→Custom Domains→subdomain→settings→subdomain→deploymentsをGETし、次を要求する。

- 期待versionが単独100%を配信し、最後のGETまでdeploymentが変化しない。
- 旧versionはdefault-onlyのfetch/queue Workerで、R2/Queue/DLQ/admin secretがservice設定と一致する。named entrypoint、migration用version metadata binding、重複binding、別/欠落したresourceを拒否する。
- 旧compatibility dateは妥当なISO date（APIの午前0時表記も正規化）で、bridge buildの2026-10-01より新しくない。versionとsettingsのdate/flags/全binding snapshotを照合し、`disable_ctx_exports`は拒否する。
- legacy global cache有効と実行versionのdefault cache設定が照会できる。settingsのexportsがある場合はversionとも一致させる。versionのexports/named_handlers/空flagsが省略される旧REST形式には、下記の追加照合を要求する。M6/bridgeのstrict runtime schemaは緩和しない。
- attached Custom Domainがなく、workers.devが既に有効である。旧previewは有効/無効を記録するだけで、この準備GETでは変更しない。
- settings/preview/deploymentを再GETし、途中の変化を拒否する。settings hashはschemaで未使用のfieldも含む元の応答object全体から計算し、追加KV等のbinding parameter変更も見逃さない。

metadataはdefault cache無効/唯一のdefault export/global cache有効/cross-version無効、version metadata binding、`enable_ctx_exports`、logs/traces有効を明示する。admin secret/追加bindingは期待legacy versionからstrict inherit用のname/type/version IDだけを生成し、本文やnamespace情報を複製しない。既存sampling/tag/tail/placement/logpushは保持し、version tagはbridge UUIDに固定する。

### 旧version APIの省略項目への対応

2026-10-02の既存テスト環境ではversionのexports/named_handlers/compatibility_flagsが省略されていた。legacy準備だけに限定して次を追加した。

- 省略項目があれば、Worker script GETを準備の前後で追加する。最大4MiBの単一JavaScript moduleだけを受け付け、multipartでは`index.js`一つ（Fileまたはfilenameなしのtext part）に限定する。UTF-8、実長、取消終了を検査する。
- Bun 1.4.2の`Transpiler.scan`でdefaultだけのexport、importなしを確認する。remote codeを実行せず、regexだけでexportを判定しない。複数module/asset、named export、re-export、不正sourceは拒否する。
- version flagsの省略は、current settingsが明示的な空配列の場合だけ受け付ける。non-empty/不明settingsからversion flagsを補完しない。
- version exportsの省略は、settingsにもper-entrypoint exportsがなく、versionとsettingsの明示global cache設定が一致してenabled=trueの場合だけ受け付ける。default-only moduleを確認した上で、公式のper-entrypoint未指定時のglobal cache継承規則を使う。cross-version設定の省略/不一致を勝手に同一視しない。
- 二度のmodule hashが一致し、settings/preview/deploymentの既存再照合も合格することを要求する。module hashはversion profile hashの入力へ組み込み、旧sourceそのものをrequest/journalへ保存しない。

これはlegacy準備snapshotの互換性であって、named cache/M6 routing/readiness/旧cache全scope purgeの証拠ではない。moduleを読めない・未知fieldで補完条件を満たせない場合は引き続きfail closedとする。

## 準備requestと証明範囲

strict requestにはservice/account/Worker/bridge UUID、期待legacy version/deployment UUID、旧date/cache/previewの観測値、settings/version profile/source/metadataのSHA-256だけを返す。author email、secret、Worker source、metadata本文を操作recordへ保存しない。

旧`cross_version_cache`が取得できなければ`unspecified`とし、Cloudflareのdefaultを推測してenabled/disabledへ変換しない。bridge metadataで明示的falseにしても旧version/cache scopeが消えたとは扱わない。

これはGET時点の準備であってatomic deploy fenceやsource実体のremote checksumではない。returned requestのdurable保存とPUT直前の同snapshot再照合は別の初回deploy driverへ接続した。準備GETだけで旧CLI/PUT/consumerの終了、他端末のdeploy禁止、全route/hostname/colo、preview撤去、旧cache全scope purge、最終cutover/readinessを証明しない。未知fieldで安全な照合ができない場合は推測せず保留する。

## 検証

mock RESTのGET-only結合とpure helperで、v0.1.1型のexports省略/settings日付表記、旧preview有効、cross-version未指定/true/false、secret非コピー、resource/version/handler/date不一致、追加binding parameter差異、部分配信、Custom Domain、settings/deployment/preview変化、共通upload gateとcandidate export拒否を確認した。CLI subprocessでも実形式の省略項目とmultipart text part、GET-only 10件、変更/不正入力拒否、壊れたadmin secret/stateを読まず全local file不変を確認した。mock検査だけでCloudflare実deployを合格としない。

2026-10-02に既存`smoke-20260930`環境へ更新後の実REST adapterをGET-only guard付きで実行した。service設定GET 1件と準備GET 10件（script 2件を含む）が成功し、期待legacy version/default cache有効/cross-version無効/preview無効を照合した。bridge sourceはローカルでbundleしたが、準備結果はメモリ上だけで破棄し、journal保存・PUT/POST・deploy・R2変更は行わなかった。この限定GET経路の実機確認を、移行完了・受付再開・実deployの合格へ拡張しない。

続いてLinux x86-64 standalone binaryの`migration-preflight`を、同serviceのTOMLだけを置いたprivateな一時workspaceから実行して合格した。同じlegacy version/deployment、default cache有効/cross-version無効/preview無効を照合し、local TOML不変・追加file/journalなし・admin secret不要・全変更許可falseを確認した。全670テスト/11019 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、Linux binary buildに合格した。既存serviceの配備やR2 payloadは変更していない。

資料: [Workers Cache継承規則](https://developers.cloudflare.com/workers/cache/configuration/)、[Bun Transpiler](https://bun.sh/docs/runtime/transpiler)。
