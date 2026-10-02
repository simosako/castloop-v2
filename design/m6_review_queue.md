# M6: 承認済み方針と残る技術ゲート

更新日: 2026-10-02

管理者の指示に従い、判断待ちでも独立した開発は進める。確認待ちと明示的に承認されたpolicyを区別する。公開停止・再開・削除コマンドは未提供。現行REST単一PUTの維持と未解決懸念U1の非ブロッカー扱いは決定済みで、再承認を求めない。

## 承認済みの試験環境・移行・リリース方針（2026-10-02）

管理者が説明への3件のannotationで次の方針を決定した。先行運用・無停止移行・測定を、M6一式の構築に先行する判断待ちとして再要求しない。

1. **試験環境**: 既存サービスと同じCloudflareアカウント内に、専用のWorker/R2/Queue/DLQと使い捨て試験データを用意する。運用リソースと明確に分離し、既存環境への適用や破壊的試験を兼ねない。
2. **移行**: 予定したメンテナンス時間に、更新操作と公開配信の一時停止を許容する前提で構築する。無停止移行はMVP構築後に必要性を検討する後続課題であり、M6の必須要件にしない。既存環境の実際の移行日・停止時間上限はまだ決めていない。
3. **完成・公開範囲**: Show/Episodeの停止・再開・削除、upload/publication連携、移行・復旧、CLI/配信/consumerと利用案内までM6機能一式を構築し、次バージョンとして正式リリースする。機能を限定した先行リリースを先に必須としない。具体的なversion番号・日付は未決定である。
4. **測定の順序**: 費用測定・停止時間測定の計画はMVP構築後へ回す。これらの数値や予算承認待ちを通常の実装を止める条件やM6機能完成の条件にしない。測定済みの値や停止時間保証として表示しない。

この決定は機能・安全性の検証を省略するものではない。専用環境での配信/cache/削除/移行/復旧と300MB処理の動作確認、旧IOの収束、owner/tokenの安全な扱いは維持する。費用上限・有料契約/plan変更・無制限の支出は承認されておらず、必要ならその具体的な変更だけ別途確認する。既存サービスの即時切替や、未検証の破壊的command公開は行わない。

## 承認済みの削除後記録保持（2026-10-01）

管理者が説明へのannotationで「これでOKです。記録して、実装に進めてください」と承認した。Show予約・制御record・Episode tombstone、凍結request・publication commit marker・status/progress等の必要な小さい管理/操作記録は自動期限削除せず保持する。音源・cover・公開metadata等のpayloadは明示的deleteで物理削除する。タイトル・説明文・メールアドレス等の本文やsecretを記録へ複製しない。期限付きの記録整理は後続とする。

### tombstoneと操作記録の違い

**tombstoneは「このIDのShow/Episodeは削除済み」という小さな管理記録**。音源や番組情報のバックアップではなく、ID・deleted状態・generationなどを残す。削除済みと未知のIDを区別し、410応答・ID再利用禁止・古いjobの拒否に使う。system領域に置き、公開コンテンツとして配信しない。物理削除後もこれを残すことは、音源やタイトル/説明文を残すこととは別である。

これとは別に、**操作の記録**を次の方針で保持する。

| 記録 | 目的 | 承認済みの扱い |
| --- | --- | --- |
| 削除済みIDの最小記録（tombstone・Show予約等） | ID再利用防止、削除済み判定、旧jobの拒否 | 自動期限削除しない。保持項目は最小限にする |
| 凍結request・commit marker | どのjobがどの対象に何を要求したかの照合 | 本文を複製せず、完了後も照合に必要な小さい記録を保持する |
| status/progress・エラーreason | 完了/失敗照会、中断回復、障害調査 | 完了後も必要な記録を保持する。reasonに本文/個人情報/secretを保存しない |

エラーreasonは必要な診断情報に限定する。期限付きの監査cleanupは、安全に削れる依存関係を決めてから別途設計する。M6に自動保持期限処理を追加せず、運用記録が残ることをdeleteの説明へ明記する。未完了/回復中jobも時間だけで記録を消さない。

## 承認済みの公開時の利用条件（2026-10-01）

管理者が本資料へのannotationで「これでOKです」と承認した。

- 停止時HTTP 404、削除中/削除済み410、公開中の空Showのfeedは200。
- 外部cacheは再検証必須とし、削除したIDは再利用しない。
- 進行中publication/uploadへ停止・削除を割り込ませない。
- 毎要求の状態照会と内部cache呼出に伴うrequest/CPU/R2 read増を許容する構成。

これは仕様・構成の承認であり、測定済みの性能/料金値や実機受け入れ合格を意味しない。専用環境での機能・安全性の回帰は継続し、費用・停止時間の測定計画は2026-10-02の決定に従ってMVP構築後へ回す。運用記録保持policyの承認も、実削除の実機合格とは区別する。

## 管理者の判断待ちではない技術残件

1. **upload/publication統合**: staging操作IDとdraft job IDの分離、単一PUT前の受付/一度限りの開始、明示的client終了確認、検証token、size/全量checksum/metadata/cover照合、完了/取消receiptとowner解放の基礎処理を追加した。凍結publication manifest・共通CAS受付・staging証拠/current ETag/base revision照合後のcommit準備も追加した。Show/Episode publication runner/実行token付きconsumer/内部purge effect、stream媒体保存と2種改訂の再開まで独立moduleで追加済み。管理API/既存CLIのREST PUTへの接続、状態喪失後の回復手順、本番publication routingを完成する。未知の検証tokenは時間で奪わない。
    staging/publication/lifecycleの3内部管理handlerを未公開の`fetchM6ManagementIntegration`へ接続した。認証/readiness/version照合後のrouteを結合testで検証し、通常candidateはmock readinessがあってもmanagement書込を拒否する。公開入口・CLI書込commandと実機受け入れは未完了である。`m6_management_api.md`参照。
    staging内部client/非書込status/privateなdurable upload journalも接続した。一度限りbegin/PUTと明示settlement/検証を記録し、未知応答/保存失敗/残存lockでは再送/終了認定しない。固定checksumのprivate一時snapshot・最新source照合・単一REST PUT/全量GET検証を内部runnerへ追加した。公開CLI、unknown outcomeの外部復旧、実Cloudflare REST/300MB受け入れは残る。`m6_staging_client.md`と`m6_staging_rest.md`参照。
    local Show/cover・Episode TOML・MP3からstrict manifest/source snapshot/prepared journalを自動準備するhelperも追加した。固定ID/期待generationをcallerから受け、requested/lock/変更入力を拒否する。targetごとのdurable draft ID管理と公開CLI組込は残る。`m6_local_staging_preparation.md`参照。
    publication内部client/非書込status/privateなdurable job journalも追加した。commitは完全manifest hashを照合し、claim/commitを別の明示操作としてPOST前requested保存と未知応答非再送を行う。同jobの明示retryも未完了owner/token/marker検査とdurable通番/requested保存へ接続した。ローカルdraft state、公開CLI/安全な外部復旧/実機受け入れは残る。`m6_publication_client.md`参照。
    finished/staged local journalsと最新TOML/cover/audio、audio-onlyのbase metadataをclaim/commit直前に照合する独立guardも追加した。旧local stateの自動変換/公開command接続は行っていない。`m6_local_publication_inputs.md`参照。
    finished staging集合からpublication manifest/durable journal/送信前guardを自動準備するhelperも追加した。Show/Episode初回・metadata-only/audio-only・audio-firstをlocal入力からconsumerまで結合し、stage記録/lockの途中変更も送信前に拒否する。target別draft ID管理・公開CLI/外部復旧・実機受け入れは残る。`m6_local_publication_preparation.md`参照。
    新規Episodeの最初のmetadata/audio stagingへ、generation-zero draft制御の条件付き初期化を追加した。orphan/tombstone拒否・Show共通CAS・exact owner照合後だけ初期化し、公開fixtureの手動draft投入も除いた。公開CLI接続・実機受け入れは残る。`m6_new_episode_staging.md`参照。
    新規Showの永久reservation ID/CAS登録とdraft制御初期化、partial登録時の共通受付拒否、内部`POST /admin/shows`とstrictな非再送clientも追加した。既存/advanced/tombstoneを再初期化せず、同IDの限定補完だけを許す。private/fsync付き登録journal/送信前requested保存/一度限りrunnerも接続した。unknown outcome/残存lockを観測から昇格・再送せず、offline診断のshow-registration familyだけをsource CLIへ追加した。registered receipt/非期限lockを使うローカルShow/Episode下書きhelperも追加したが、legacy confirmedは変換しない。公開`create-show`/local staging state統合/外部復旧/実機受け入れは残る。`m6_show_registration.md`、`m6_show_registration_client.md`と`m6_local_drafts.md`参照。
2. **consumer invocationの安全な回復**: 全副作用をawaitした通常終了/例外終了からのtoken返却・続行/requeueを独立consumerで実装した。取得応答喪失・runtime強制終了ではブロックを保持する。稼働中invocationを解放せずに終了を確認する手順と、安全な回復を成立させる。時間/HEAD不在だけの奪取を追加しない。
3. **本番配信とpurge**: cache有効named entrypoint向けの内部fetch/stream配信、所有entrypoint内purge、service token/readiness/実行version/cache ownerを照合する配信gate adapterを実装した。adapter/RPCは実cache設定や100%切替を単独で証明せず、まだ本番main moduleへexport/接続していない。gatewayをdefault cache無効の入口へ接続し、CLIのdeploy設定と移行capabilityを完成する。GET/HEAD/Range/304・再検証header・失敗時no-storeを実機回帰する。`m6_delivery_runtime_gate.md`参照。
   別entry moduleの`src/m6-worker.ts`へgateway/named export/新Queue consumerを接続した。現行binary/deployには接続せず、通常候補のmanagement書込は閉じたまま、ready=falseを維持する。未公開fetch結合入口の追加は公開gateを変更しない。bootstrap/本番REST設定/HTTP検証/旧IO/cache purge等は残る。`m6_candidate_worker.md`参照。
4. **移行とcapability**: サービスCAS registry/pause/drain/atomic移行受付と凍結planのCAS初期化/途中再開を追加した。現行管理API/Queue/DLQのregistry接続と認証必須の読み取り専用capability照会も追加したが、M6 route=false/ready=falseを維持する。旧Worker/CLI直PUTの外部収束確認は別途必要。本番quiescence/cutover callback、applyのAPI/CLI、旧cache purge、100% Worker切替、安全なrollbackを完成する。未知のregistry tokenも時間で解放しない。`m6_migration_runtime_contract.md`参照。
    M6用REST metadata生成と読み取り専用deployment/version/settings/preview検査も追加済み。実upload/CLI接続は未提供で、GET照合を旧IO/cache purge証明としては扱わない。`m6_worker_deployment_inspection.md`参照。
    非書込`migration-preflight LEGACY_VERSION_ID`をsource CLI/build binaryへ追加した。旧RESTの省略項目はboundedな単一module解析と前後hash/明示settings照合で裏付ける。既存v0.1.1テスト環境でGET-only adapterとLinux binary診断が合格したが、journal/deploy/停止/復旧許可はなく、旧IO収束・full cutover・破壊的試験は未検証である。`m6_migration_bridge_preparation.md`参照。
   独立bridge/candidateの移行APIへpause/claim/旧IO明示申告/初期化限定apply/凍結bootstrap開始・終了/HTTP検査を接続した。候補HTTP window中も通常書込・consumer・完了/再開は閉じる。CLI/full cutover/旧cache全scope/外部検証/rollback等が残る。`m6_migration_bootstrap.md`参照。
    移行client/durableローカルdeploy journalと実REST deploy adapter、pause/claim/旧IO申告/1-step初期化のdurable setup journal、読み取り専用`migration-status [--local]`も追加した。実Cloudflare deploy検証/移行書込command/full cutoverは未完了で、不明応答のPUT再送や残存lock/token奪取はしない。`m6_migration_client.md`と`m6_migration_setup_client.md`参照。
    service公開originへの未公開外部HTTP inspectorも追加した。凍結public assetsのHEAD/GET/1-byte Range/304をbounded pageで照合し、response IOの終了をawaitする。単一originのsnapshotだけでreadinessを成立させず、CLI/finalizer・全hostname/colo・実機受け入れは残る。`m6_external_delivery_inspection.md`参照。
5. **再開・物理削除**: 削除開始のstate/feed/purge、owner-gated payload batchと先頭からのverification、最終purge/子tombstone/deleted/完了解放までを独立moduleで実装した。restoreも保存済みsnapshot検証→feed/purge準備→durable証拠→active化を実装した。凍結commit・consumer続行/同job requeueの基礎処理は追加済みだが、本番gate確認、本番Queue/管理APIへの接続と実機確認は残る。未知keyを黙ってprefix削除しない。
   lifecycle内部APIを共通service boundaryへ接続し、非予約dry-run/削除確認/6操作の受付とcommit、読み取り専用job照会、live tokenを拒否する同jobの明示retryを追加した。API→M6 Queue adapterのローカル結合は確認済みだが、公開入口/CLI client・durable復旧・実機確認は未完了である。`m6_management_api.md`参照。
   未公開lifecycle clientの固定origin/redirect拒否/一回限り送信/strict応答照合と6操作のローカル結合も追加した。確認済みrequestと送信前requestedをprivate/fsync付きjournalへ保存する明示claim/commit/retry、非書込offline/remote照会も接続した。公開CLIとunknown outcome/残存lock/tokenの安全な外部復旧は残る。`m6_lifecycle_client.md`参照。
6. **接続と受け入れ**: 実行token付きeffect factoryとWorker binding用のfeed書込/内部purge/Queue送信を追加した。本番配信gateとQueue routingへ接続し、管理API・CLIの6操作、確認入力/dry-run、job-status/retry、README/help・復旧手順を完成する。専用Cloudflare環境とLinux x86-64単一バイナリで確認してからReleaseを判断する。
    認証情報/HTTP/書込なしの`local-operation-status FAMILY ID`をsource CLIへ追加し、4familyのprivate journal/残存lockを照会可能にした。phase昇格/lock除去/復旧許可は行わず、書込commandの公開gateは閉じたままである。`m6_local_operation_status.md`参照。
    `operation-status FAMILY ID`もsource CLI/standalone buildへ接続した。凍結local要求のstatusだけを一回送り、local/remoteの非変更・requested非昇格を4familyとlocal HTTPS binaryで検証した。通常candidateのmanagement gateを開けず、保持record不足/未知応答/途中変更は拒否する。実Cloudflare受け入れではない。`m6_remote_operation_status.md`参照。

## 今回実装済みだが本番未接続

strictな制御/request/status/progress/commitとallowlist診断、CAS job journal、Show CAS受付、reserved限定abandon、invocation token、完了解放receipt、移行inventory、削除対象ページ、owner-gated payload batch/verification pass、削除開始/最終purge/子tombstone/完了解放、lifecycle対応feed入力、Show/Episode停止・保存済みsnapshot再開状態機械、通常終了consumer/続行/requeue、公開gateway、内部cached entrypoint/transport/purge。既存本番DLQ handlerの固定診断化は接続済みだが、lifecycle操作はまだ本番へ接続しない。個々の自動テスト合格はM6全体の受け入れ合格ではない。

詳細は[M6設計](./m6_content_lifecycle_plan.md)、[実装ログ](./m6_implementation_log.md)、[U1と単一PUT方針](./m6_upload_recovery_options.md)を参照。
