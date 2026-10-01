# M6: 初回bridge deployのdurable client

更新日: 2026-10-02

## 実装範囲

未公開helper `runMigrationBridgeDeployment` / `createMigrationBridgeRestEffects`に、読み取り専用準備からの初回bridge REST PUT、preview無効化、実行version/tag/設定の検査を接続した。現行`deploy/init`、embedded Worker、CLI書込commandは変更していない。Cloudflare実deployも既存v0.1.1環境の更新も行っていない。

この工程は**旧Workerからbridgeへの初回切替**だけであり、候補Worker deploy/Show・Episode初期化/旧IO終了・旧cache purge/M6移行完了/受付再開ではない。候補deployのserver開始許可やjournalを、移行APIのない旧Workerへ流用しない。

## 開始前の明示申告

strict requestは読み取り専用準備requestに`administrator_writes_stopped=true` / `other_deployers_stopped=true`を加える。管理者が旧管理端末の新規書込と、別端末・CI・手動操作からのdeployを止めたことを確認するための申告であり、client lockが別端末や稼働中RESTを停止した証明ではない。自動でtrueにするCLIは提供しない。

旧Worker invocation/consumer/R2 PUTの完全終了は、bridge切替後のpause/drainと既存のquiescence確認で別途必要になる。この開始申告だけで`old_io_quiesced`等を生成しない。

## Durable recordとlock

- `.castloop/bridge-deployments/<serviceId>.json`にstrict requestとphase/version/allowlisted検査receiptだけを保存する。bootstrap UUIDではなくservice IDをfilenameにし、同workspaceで別UUIDを作って不明deployをやり直すことを拒否する。別workspace/端末には及ばない。
- directory 0700/file 0600、exclusive初期作成、更新は同directoryのprivate temp file→file fsync→rename→directory fsync。本文/secret/namespace parameter/任意exceptionは複製せず、Worker source/metadata/legacy設定はhashだけを残す。
- 同fileの`.lock`をexclusive create/fsyncし、全REST/保存Promise終了まで保持する。強制終了後の残存lockを時間で奪わず、自動削除しない。破損/過大record、凍結request/version/receiptの変更、phase後退/段階飛ばしを拒否する。

## 実行と中断

1. ローカル`prepared`を読み、source/metadata hashとbridge UUID tagを照合する。metadataはdeep snapshotし、callerの後続変更をPUTへ混ぜない。
2. 同legacy version/deployment/settings/previewの準備GETを再実行し、凍結snapshot一致を要求する。ここまでCloudflare書込はない。
3. ローカル`uploading`をdurable保存して開始を一度限り消費する。PUT直前にも同snapshotを再照合し、`bindings_inherit=strict`の一回のPUTをawaitする。
4. 初回bridgeの認証no-store statusでpublished service/account/Worker、実行version、bridge UUID tagを照合する。制御recordが未作成でもservice identityを必須にする。candidate/migrating/M6移行済みを初回bridgeとして扱わない。
5. RESTで期待version単独100%を要求してpreview無効化POSTをawaitし、同bridgeのstatusを再確認する。全REST終了後だけ期待versionと`rest_settled`をdurable保存する。
6. bridgeのHTTP statusとREST deployments/version/settings/domain/previewを読み取り専用で検査・再照合する。default cache無効、version-isolated cache、loopback flag、service/version metadata binding、logs/traces、preview無効を要求し、前後のHTTP statusも同version/tagを確認する。receiptを保存した後だけ`verified`に進む。

PUT/preview応答喪失、tag/version/部分配信不一致、PUT後のlocal保存失敗では`uploading`を保持する。GETや時間経過から「書込未実行」「REST終了」を認定せず、PUT/previewを再送しない。開始消費後のpreflight失敗でPUT未送信だった場合も同じ保守的状態に止める。

`resumeMigrationBridgeInspection`はdurable `rest_settled`からのGETだけを再開する。`verified`は保存済みreceiptでのno-opであり、現在の設定や後続移行の安全性を再認証した結果ではない。ローカル残存lockやunknown outcomeを外部確認して安全に解決する手順は未成立で、release gateとして保留する。

## 限界と検証

GET snapshotはatomic deploy fenceではない。特定bridge UUIDのHTTP実行version照合はsource実体のremote checksumでもない。100% deployment/preview設定のGET合格を、外部全hostname/coloへの切替、旧preview cache/旧version全cache scope撤去、登録前invocationの再保存防止へ昇格しない。`m6_ready=false`を維持する。

mock RESTと実bridge管理handlerのローカル結合で、一回のPUTとpreview POST、旧snapshot変化、消費後preflight失敗、PUT/preview応答喪失、foreign tag/部分配信、inspectionのみの再開を確認した。private journal/他client排他/残存lock/保存失敗/破損・過大record/phase飛ばし/secret非保持も回帰した。Cloudflare実deploy、実response形状、全route/colo、旧IO/cache、300MB/CPU/料金の合格ではない。
