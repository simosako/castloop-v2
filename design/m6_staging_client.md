# M6: Staging内部client・状態照会・durable upload journal

更新日: 2026-10-02

## 範囲と公開gate

未公開`StagingAdminClient`を内部管理APIへ接続した。Show metadata+cover、Episode metadata、Episode audioの受付/一度限りbegin/明示settlement/検証・取消と、読み取り専用statusを使う。`.castloop/staging-uploads/<serviceId>/<operationId>.json`のdurable journalから各操作を実行する内部runnerも追加した。

現行Worker/bridge/candidate fetchや公開CLI書込commandには接続していない。`m6_ready=false`を維持し、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。既存の通常upload/publication経路を置き換えてはいない。

## Strict clientと読み取り専用status

`M6AdminJsonClient`へ固定HTTPS origin/redirect拒否/no-store/16KB request/64KB response/strict UTF-8/異常stream cancel待ち/固定診断を共通化した。既存lifecycle clientも同helperを使い、wire契約と非再送の回帰を維持した。移行clientやlegacy CLIの通信は変更していない。

staging clientはcallerのstrict manifestだけを使い、operation IDとdraft job IDを区別する。begin receiptのservice/show/operation/generationに加え、payloadの個数・順序・正確なstaging key・サイズ・checksumを凍結manifestへ照合する。別draft/episodeや任意prefixのPUT許可を採用しない。ID/generation/timestampの生成、自動retry、body/mediaの管理API送信はしない。

最初の新規Episode stagingではserverが、公開中Showの共通owner取得後にgeneration-zero draftを条件付き初期化する。metadata-first/audio-firstの両方を許可し、既存control/tombstone/orphanを上書きしない。clientのunknown outcome/一度限りbegin規則は変えない。`m6_new_episode_staging.md`参照。

内部`POST /admin/staging`の`action=status`は完全なmanifestを入力とし、retained manifest/control request/progress/status、Show owner/completion receipt、draft commitの存在を読む。manifest/control request hash、対象/generation/全検証assetを照合し、Show controlと各record/markerの読取前後ETag/sizeが変わったら拒否する。これは複数objectの原子的snapshotではなく、途中変化を保守的に拒否するbounded照会である。

statusはservice tokenを登録せず、`withM6ManagementRead`でservice設定/readiness/実行version/cache ownerを前後照合する。pause中や保持verification tokenがある場合にも観測だけを行う。ownerはunclaimed/held/released/superseded、検証tokenは`verification_active`のboolだけで返す。後のjobがreceiptを置換しても過去の完了statusを履歴として読める。

statusはpayload本文を読まず、owner/token/progressを変更せず、常に`authorizes_put=false`、`authorizes_recovery=false`を返す。partial claimのmanifestだけが保存された場合もunclaimedとして照会できるが、PUT permissionや旧処理終了の証拠にはしない。legacy statusやsecret/任意exceptionを含む不正recordは採用しない。

## ローカルjournal

private directoryは0700、record/temp/lockは0600で作る。recordはexclusive新規作成、更新は一意temp→file fsync→rename→directory fsyncとし、新規directory階層もfsyncする。strict schema/16KB上限/identity/manifest/phase/receiptを毎回検査する。

保存するのはservice/account/Worker/origin、凍結manifest、最小claim/begin receipt、phase、成功応答を受けたPUT数、予定finish outcome、固定`put_failed`診断とfinish receiptだけである。本文/タイトル/メール/管理key/API token/任意exceptionをコピーせず、service TOMLにjob IDを書かない。operationとdraft IDの変更、foreign identity、phase飛ばし/後退、PUT許可の再開は拒否する。

| phase | 意味 |
| --- | --- |
| `prepared` | ローカルmanifest凍結だけ |
| `claim_requested` → `claimed` | POST前保存 → 一致するclaim receipt保存 |
| `begin_requested` → `begin_acknowledged` | 一回限りbegin POST前保存 → exact PUT permission保存 |
| `puts_running` → `puts_settled` | 最初のPUT前保存 → このrunnerが所有する全PUT Promiseの終了を保存 |
| `settlement_requested` → `settled` | 明示終了申告POST前保存 → 一致する応答保存 |
| `finish_requested` → `finished` | 検証/取消POST前保存 → 一致する応答保存 |

成功responseを受信し、対応receiptの保存まで成功した場合だけ次へ進める。response喪失・不正receipt・保存失敗では最後のdurable phaseを保持する。観測statusやHEADからphaseを昇格させず、POST/PUTを自動再送しない。

## 一度限りPUTと明示的終了

`runStagingClaim`は受付だけを行う。`runStagingBeginAndUpload`はclaimedから、同owner/ready progress/検証token不在/未commitを照会し、begin_requestedを保存してbeginを一回送る。exact receiptを保存し、puts_runningを保存してから、注入したPUT effectを順に一回ずつawaitする。

REST/source adapterはclaim/beginのrequested保存より前に`checkLocalInputs`を使い、凍結size/checksumと最新の元ファイルを照合する。beginの検査はowner照会後に行う。送信前検査の失敗ではjournalをprepared/claimedのまま保持し、HTTP/PUTを送らない。入力を元のmanifestへ復元した後の明示操作は可能だが、未知requested phaseからの再送許可には使わない。settlement/finish/statusは後のローカル編集で妨げず、既受付IOの収束を優先する。

PUT effectの契約は、その一回のPUTと付随する検証等の全IO Promiseを所有し、終了までawaitすること。background PUTや独自retryを行わない。HTTP clientとREST payload接続は別で、begin管理HTTPの終了をREST PUT終了とみなさない。

PUTが正常/例外で終了したら、それ以上PUTしない。例外では後続payloadを送らず、任意exceptionを保存せず、puts_settledと固定put_failed/予定abortedを保存する。成功応答数はobjectの存在/不存在の証明ではない。`put_outcome=staged`も予定検証outcomeだけで、server検証済みや公開済みを意味しない。

begin応答が不明、permission保存が不明、PUT稼働中または終了保存が不明なら、再begin/再PUT/自動settlementしない。時間やHEAD不在で終了と認定しない。正常に記録されたputs_settledからだけ、callerの明示的`put_requests_settled=true`/`no_more_puts=true`を要求する`runStagingSettle`が可能になる。

`runStagingFinish`はsettledからidle verificationと同ownerを照会して、一回だけ予定staged/abortedを送る。payload検証とowner解放はserverが再度検査する。abortはpayloadを削除しない。pause中でも既受付のsettlement/finishは収束できる。

この終了申告はserverによるREST接続終了の直接観測ではない。承認済みREST単一PUT方針と未確認のU1仮定を維持し、切断後書込がないことをCloudflare保証として扱わない。U1をM6 release blockerへ追加せず、supportへ連絡しない。

## Lock・照会・残件

変更操作はexclusive非期限lockを全client/PUT/保存Promise終了まで保持する。残存lockを期限で奪わず、未知verification/service tokenも解放しない。`readLocalStagingOperation`はkey/token/HTTPなしでrecord/lockを読むだけで、空workspaceにfileを作らず、`remote_state_checked=false`を返す。`inspectStagingOperation`もrecordを更新しない。

ローカルdisk/client/API/binding mockで3種payload、非公開のままstaging完了、PUT例外から明示settled abort、paused drain、live PUT排他、各HTTP応答喪失・保存失敗、偽permission、未知verification token、offline非書込/残存lock/foreign identity、不正recordを回帰した。全557テスト/9437 assertions、型検査、Worker/browser・client/Bun bundle、M6実証tsconfig、Linux binary buildに合格した。

実REST PUT/source検査adapterとpublication client/journal/statusも内部runnerへ追加済みである（`m6_staging_rest.md`、`m6_publication_client.md`参照）。本番管理入口/公開CLI、unknown outcome/残存lock/tokenの安全な外部復旧、full cutover、専用Cloudflare環境での300MB/配信受け入れ、利用・復旧案内は残る。費用測定計画は承認済み方針に従ってMVP構築後へ回す。mock PUT effectやローカル合格をCloudflare実機の合格とはしない。
