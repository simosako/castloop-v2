# M6: 移行applyとruntime証拠の契約

更新日: 2026-10-02

## 現在の実装範囲

独立bridgeの移行管理APIへ`runLifecycleMigrationStep`の初期化限定モードを接続した。候補HTTP検査windowも追加したが、CLI・本番full cutover/完了/受付再開は未接続である。現行binary/Workerは変更せず、`GET /admin/capabilities`は引き続き認証必須・no-store、`worker_protocol=legacy_fenced`/`m6_ready=false`を返す。R2にmock readinessがあっても、このWorkerがlifecycle配信/操作に対応するとは報告しない。`m6_migration_bootstrap.md`参照。

旧Worker/CLIから移行を実施できるリリース手順や、安全なrollback手順はまだ完成していない。既存v0.1.1環境の更新・削除は行わない。

2026-10-02に管理者が、予定メンテナンス中の更新操作・公開配信の一時停止を許容した。M6は停止時間を取れる前提で構築し、無停止移行を必須にしない。費用・停止時間の測定計画と無停止移行の検討はMVP構築後へ回す。これは旧IO終了・cache撤去・安全な切替の条件を省く決定でも、既存環境を今すぐ切り替える指示でもない。

## 凍結planと進捗

- serviceをpause/drain後、同じservice CASで空のmutating invocation registryを確認し移行ownerを取得する。
- `system/lifecycle-migrations/<migrationId>/request.json`はpause ID・期待service generation・対象を凍結する。
- `plan.json`はrequest hash、既存objectの許可key/ETag/size、初期化または保持するstrict制御recordだけを保持する。本文・メール・secretや arbitrary exception messageを複製しない。未知object key、未完了owner/commit、不整合なmetadata/history等は拒否する。service設定のIDもownerと一致させる。
- 初回のShow/Episode制御recordはgeneration zeroのdraft/activeだけを初期化する。既存lifecycleの公開停止状態・generation・tombstoneはbyte単位で保持する。
- Episode制御recordを先に、Show制御recordを後に、R2 bindingの条件付きPUTで初期化する。既存payload/feed/cover/音源/current metadata/revision履歴は変更・削除しない。
- stepごとに実行tokenをCAS取得し、すべての副作用Promise終了後にだけ返す。1 stepの初期化件数は既定20、最大100。取得応答喪失/強制終了のtokenを時間で奪わない。
- `progress.json`はplan hash、next target、applying→verifying→runtime→finishedを記録する。処理中のsource消失/追加/ETag変更を拒否し、初期化済みcontrolだけは凍結値との一致を確認して途中再開できる。progress書込応答喪失でも再初期化で既存controlを上書きしない。
- 最終inventoryで全targetが凍結値に初期化/保持されていることを確認する。runtime確認後も再検証する。完了はM6 modeへのCASと証拠保存だけで、serviceはpausedのまま。受付再開はpause ownerによる別の明示操作である。
- plan/progressを作成した移行はunstarted abortの対象外であり、legacyへ自動復帰しない。一般的なrollbackは未実装。finished証拠の保存後にservice完了CASが失敗した場合、同じdeployment/version等の証拠を再確認してから完了できる。

## 必須callbackの本番契約（未接続）

`checkQuiescence(execution)`は毎stepで実行する。mockの即時成功は本番証拠ではない。本番adapterでは少なくとも以下を確認し、確認不能なら失敗させる必要がある。

1. pause/migration ownerと現在の実行tokenが一致し、service registryが空である。
2. 登録前の旧Worker invocationを含む書込が終了し、旧CLI/端末のREST PUTも終了して今後書かないことを管理者が明示的に確認している。時間経過・HEAD不在・新Worker 100%設定だけを終了証明にしない。
3. 旧consumerと旧管理APIが再び書込できないdeployment/受付状態である。Queue deliveryを無視して完了扱いにせず、未完了jobを先に収束させる。

`verifyCutover(execution)`は本番adapterで次のすべてを実証してstrictな証拠を返す。booleanを管理API入力からそのまま信用してはならない。

- deployment IDとWorker version IDを検証し、100%を対応Workerへ切り替えている。
- default入口のWorkers Cacheが無効で、`CachedPublicAssets`だけがcacheを所有し、loopbackが同じWorkerの正しいentrypointを指す。
- 旧cacheがpurge済みであり、各公開hostname/GET/HEAD/Range/条件付きGETで状態照会を迂回しない。
- publication/staging/lifecycle routesとconsumerが同じservice/control受付・配信gateに接続している。
- 旧IO終了の確認を保持し、新たな旧書込を許可していない。

証拠にはallowlistedなIDと成立した条件だけを残す。正常に返ったcallbackとR2 mockによる自動テストは、Cloudflare実機・旧invocation収束・runtime制約内の300MB処理・複数colo等の機能/安全性の受け入れに置き換わらない。費用・停止時間の定量測定はMVP構築後の別計画とし、runtime証拠から測定済みの費用や停止時間保証を推定しない。

## 次の接続作業

本番配信gateとdefault/named entrypoint deploy設定、旧cache purge、Worker/CLI/API/Queue切替、外部終了確認、移行applyのAPI/CLI、token取得応答喪失/強制終了後の安全な回復、rollbackを完成する。6 lifecycleコマンドの公開とv0.1.1環境の移行案内はこれらのゲート成立後とする。
