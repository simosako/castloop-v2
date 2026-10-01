# M6: 移行bridge・初回候補配信のbootstrap

更新日: 2026-10-01

## 現在の範囲

`src/migration-bridge-worker.ts`と`src/m6-worker.ts`の独立entry moduleに、認証必須・no-storeの移行管理APIを接続した。現行binaryのembedded Worker、`castloop deploy/init`は変更していない。Cloudflareへdeployしておらず、既存v0.1.1環境も未変更である。

今回の完了点は**凍結planの初期化と、書込を止めたまま候補のHTTP配信を検査できる状態**である。管理操作/consumerの全面切替、旧cache全scopeの撤去、外部hostname/colo検査、移行完了CASとM6受付再開は未提供で、`m6_ready=false`を維持する。HTTP合格を`publication_routes_verified=true`や`cutover_verified=true`へ変換しない。

## 安全な順序

1. 旧端末の新規書込を止め、bridgeを100%へ切り替え、旧version previewを無効にする。初回deployの読み取り専用REST準備は`m6_migration_bridge_preparation.md`の範囲で実装したが、一度限りdeploy受付/書込adapter/CLI接続は残件である。bridge default cacheは無効にする必要があり、codeの存在だけでは成立しない。
2. bridgeでservice registryを初期化し、pauseする。既存invocation/consumer/限定recoveryはdrainし、未完了publication/uploadを先に収束させる。空registryだけを確認して移行ownerをCAS取得する。
3. 管理者が旧端末/旧Worker invocation/旧REST PUTの終了と今後の旧書込禁止を明示申告する。`quiescence.json`へbridge version/owner/request hashと定型条件だけを凍結する。これはWorkerが別REST接続や登録前invocationの終了を直接証明したものではなく、管理者の外部確認を記録するもの。時刻やHEAD不在を証拠にしない。
4. bounded applyでEpisode→Showの順に初期化し、inventory/sourceを再照合する。`initializeOnly`はprogressを`runtime`で止め、cutover callbackやM6完了CASを呼ばない。bridgeはplan凍結後の公開pathを503/no-storeにし、部分初期化状態を旧配信で迂回しない。
5. `bootstrap.json`にplan/source/metadata hashとbootstrap IDを凍結する。bridgeのdefault入口でpurgeEverythingをawaitし、成功receiptと`deploying`をCAS保存した後だけ、一度限りの開始許可を返す。開始応答喪失では再PUTの許可を出さない。
6. CLI側でREST deploy/preview設定を終了し、期待versionの100%・default/named cache・binding等を読み取り専用で照合する。CLIは全deploy RESTがsettledかつ今後deployしないことを明示し、candidateのsettlement APIへ渡す。client申告とREST設定snapshotは全scopeの切替完了や以後の変更防止を証明しない。
7. candidate自身のversion metadataとcache owner RPCを照合し、settlementとdelivery candidateを保存する。初期化完了progress/plan hash/同じrequest/quiescenceを読み取り専用で照合した候補だけが、凍結した現状の公開状態をgateway経由で配信する。serviceはlegacy/migratingのままで、通常管理書込とQueue consumerは許可しない。
8. 同じdefault入口へのloopback fetchで凍結public assetをboundedにHEAD/GET/先頭1-byte Range/条件付きGET検査する。状態別status、version/migration ID、外部再検証header、ETag/size/Content-Rangeを照合し、bodyはcancelする。本文/メール/任意exceptionをprogressへ保存せず、cursorとchain hashをCAS保存する。

## 管理API

`/admin/migration/`配下のみで、`X-Castloop-Key`認証を要求する。

- `GET status`: service admission、strictなprogress/bootstrap、実行version/protocolを照会する。payloadを読み返さない。
- bridgeの`POST initialize-admission/pause/claim/quiescence/apply/prepare-deployment/begin-deployment`。
- candidateの`POST settle-deployment/verify-delivery`。candidateはlegacy pause/resume/applyを拒否する。
- bridgeの`POST abort-unstarted/resume-legacy`はplan/progress/bootstrap作成前の限定取消だけ。plan以後の自動rollbackやM6受付再開ではない。

POST bodyは16,384 bytesにstreamで制限し、Content-Lengthがなくても超過時にcancelする。strict input、service一致、execution CASを要求し、失敗はallowlistedな診断だけを返す。`complete`やM6`resume`、汎用token奪取は提供しない。

## 応答喪失・稼働中処理

- CAS取得の応答喪失/強制終了で未知になったexecution tokenは保持する。開始前/未実行と推測して奪わない。
- bootstrap開始のCAS応答喪失でもdurable `deploying`を保持し、二度目の開始を拒否する。実deploy有無と接続終了を別途確認する。
- settlementまたはdelivery-candidate CASの応答喪失は、同じ凍結settlementだけで再開できる。別version/deployment/source hashへの差し替えは拒否する。
- HTTP progress保存の応答喪失は、保存済みcursorから再開する。所有tokenはpurge/HTTP/body cancel/保存の全Promise終了後だけ返す。
- plan凍結後はlegacyへ戻さず、source変化・未知object・不正controlをfail closedで保持する。

## 証拠の限界と残件

bridge defaultで成功したpurgeのreceiptは、**その呼出scopeの成功**である。version-isolated cacheの旧version全scope、旧preview、登録前の稼働中requestの再保存、他hostname/zoneのcacheを無条件に消したとは扱わない。bridge設定/旧IO外部確認/旧cache scopeの実機検証を含む最終cutover adapterが必要である。

default loopback probeは実際のgateway/named transportを通すが、外部DNS/hostname/colo/100% routingの証明ではない。GET bodyは全量digestをせずcancelするため、媒体の全量checksum/再生や300MB受け入れでもない。

deployment証拠は認証管理者がCLIから渡したsnapshotであり、candidateはCloudflare RESTを再GETしていない。未提供の本番finalizerは、この値だけでreadinessを確定してはならない。

候補REST adapterはdurable client journalへ組み合わせられるように接続した（`m6_migration_client.md`）。metadata/hash/指定bridge versionからのinherit/候補bootstrap tagを照合し、PUT/previewの応答不明では再送しない。初回bridge deploy、移行書込CLI、staging/publication/lifecycle管理操作・外部HTTP検証・最終証拠照合・pausedでの完了/明示再開は残る。通常処理のtoken強制終了回復とrollback手順、実機受け入れも残る。
