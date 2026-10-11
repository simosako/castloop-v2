# M6: Publication内部client・状態照会・durable job journal

更新日: 2026-10-02

## 範囲と公開gate

未公開`PublicationAdminClient`を内部管理APIへ接続した。Show/Episode初回公開とmetadata-only/audio-only改訂のclaim/commitを使い、保持jobの読み取り専用statusを提供する。privateなdurable journalからclaimとcommitを別の明示操作として実行する。

現行Worker/bridge/candidate fetch入口や公開CLI書込commandには接続していない。`m6_ready=false`を維持し、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。legacy公開経路は置き換えていない。

## 完全manifestにbindする未公開wire契約

claimは完全なstrict publication manifestを送り、responseにoperation identityと`manifest_sha256`を返す。commitはoperation identityだけでなく、同manifest全体の`manifest_sha256`を必須とする。serverは保持manifestを照合してから既存のstaging証拠/current ETag/base revision検査とcommit marker作成へ進む。responseもhashを返す。

同じjob/対象/generationでもmetadata/audio hash、base revision、staging操作ID、timestamp等が変わればcommitを拒否する。旧staged copyを新しい入力への応答として採用しない。これは入力manifestとの一致検査であり、後から変更されたローカルTOML/MP3を直接読み直すsource adapterの代用ではない。最新local入力とfinished/staged journalsの独立guardも`m6_local_publication_inputs.md`へ追加済みだが、公開CLI/legacy stateへの接続は別途必要である。

`publicationCommitKey`とmanifest hash helperをsharedへ移し、Worker側の既存exportは互換re-exportとして保持した。Show/Episodeのexact marker pathと既存schema条件を変更しない。通常commitはmarkerを最後に作り、R2 notificationだけで配送する。HTTP側で追加Queue送信しない。

clientは共通`M6AdminJsonClient`の固定HTTPS origin/redirect拒否/no-store/bounded strict UTF-8/固定診断を使う。入力schema/上限/ID・generationを送信前に検査し、responseのservice/result/operation/完全manifest hashを照合する。Episodeのmarker pathはEpisode IDまでexact一致を要求する。ID/generation/timestamp/staging IDを自動生成せず、自動retryしない。

## 読み取り専用status

内部`action=status`は同じ完全manifestを入力とする。保持publication manifest/control request/status/progress/commitとShow control/完了receiptを読む。全recordはstrict/16KB boundedで、読取前後のETag/size/control値が変われば拒否する。複数objectの原子的snapshotとは扱わない。

manifest/control request hash、対象/action/generation、marker内容、status/progressのidentity、published時のfinished/purge証拠を照合する。partial manifestだけが保存された場合はunclaimed、保持ownerはheld、完了receiptはreleased、後のjobで置換された履歴はsupersededとして区別する。過去jobの結果を現在の公開状態として扱わず、後のpublication等から古いjobの照会を妨げない。

statusは共通read-only service/runtime gateを使い、pause中やexecution token保持中にも観測だけを行う。registry tokenを登録せず、owner/tokenを返却しない。payload/current metadata/feedを読まず、staging内容を再検証しない。`staging_verified=false`と`authorizes_recovery=false`を常に返し、observed markerやexecution不在をcommit/retry許可へ変換しない。

## Durable client phaseと記録

git-ignoredの`.castloop/publication-jobs/<serviceId>/<jobId>.json`にservice/account/Worker/origin、凍結publication manifest/hash、client phase、最小claim/commit receiptだけを保存する。タイトル・説明文・メール・payload・管理key/API token・任意exception・remote status本文はコピーしない。service TOMLへjob IDを書かない。

private directoryは0700、record/temp/lockは0600とし、exclusive作成、temp→file fsync→rename→directory fsyncと新規階層のfsyncを使う。読取時にもstrict/16KB/hash/phase/receiptを検査する。入力・identity変更、phase飛ばし/後退、偽receiptを拒否し、不正recordを上書きしない。

| phase | 意味 |
| --- | --- |
| `prepared` | ローカル凍結だけ。server claim未開始 |
| `claim_requested` | claim POST前保存。結果不明を含み、再claim/commit不可 |
| `claimed` | 一致するclaim responseを保存済み。明示commitだけが可能 |
| `commit_requested` | commit POST前保存。結果不明を含み、再commit不可 |
| `committed` | 一致するcommit responseを保存済み。consumer完了ではない |

`runPublicationClaim`はpreparedから一回だけ受付する。`runPublicationCommit`はclaimedから、同jobのheld owner・active execution不在・marker未作成を読み取り専用で観測し、commit_requestedを保存してから一回だけPOSTする。preflightは実行capabilityではなく、serverがcurrent owner/runtime/staging証拠を改めて検査する。

POST応答喪失・不正response・成功receipt保存失敗ではrequestedを保持する。後でowner/marker/published statusが見えてもphaseを昇格せず、自動POSTや新job作成をしない。別callerが作ったmarkerも自動採用しない。unknown outcomeの安全な外部復旧は未提供である。

## 同jobの明示retry

内部`action=retry`はcommitと同じoperation/完全manifest hashを入力とし、`requeued`とexact marker key/hashを返す。保持manifest/marker/request、現在の同owner/generation、reservedまたはprocessing、consumer/verification token不在を再照合してQueue.sendを一回awaitする。pause中の既受付jobも収束可能で、完了/foreign/未知tokenは拒否する。

marker/status/progressを初期化・上書きせず、staging/sourceを再PUTせず、新jobを作らない。Episode visibility後に同jobのgenerationが進んだ場合も、purge確認済みの同job progressがある場合だけ既存publication runnerと同じ再開条件を使う。`requeued`は配送/consumer完了の証明ではない。

`runPublicationRetry`はcommit応答保存済みで、前retryが未知requestedでない場合だけstatus preflight後に通番と`retry.state=requested`を保存してPOSTする。一致する応答を保存した後にだけrequeuedへ進める。次のretryは別の明示呼出で通番を増やす。Queue送信応答喪失/不正receipt/保存失敗ではrequestedを保持し、観測で再送許可へ変換しない。

## Lockと照会

変更操作はexclusive非期限lockを全client/保存Promise終了まで保持する。残存lockや未知service/consumer tokenを時間で奪わない。ローカルlockの正常返却をremote処理終了の証拠にはしない。

`readLocalPublicationJob`はkey/token/HTTPなしでrecord/lockを読み、空workspaceにfileを作らず`remote_state_checked=false`を返す。`inspectPublicationOperation`は同凍結manifestのremote statusを読むだけで、local phaseを更新しない。これらも公開CLI commandには未接続である。

## 検証と残件

disk/client/内部API/M6 Queue adapterをローカル結合し、Show/Episode初回公開と2種改訂、claim/commit非自動接続、immutable媒体/historyとGUID/date保持、purge完了後published化、stale入力拒否、応答喪失/receipt保存失敗非再送、live/残存lock、offline非書込、paused status、active execution、履歴status、不正/過大/変更record/偽receipt/secret非保持を回帰した。

全576テスト/9776 assertions、TypeScript、Worker/browser・内部client/Bun bundle、M6実証tsconfig、Linux x86-64 binary buildに合格した。これはCloudflare実機の合格ではない。

同job retry追加後は全601テスト/10145 assertions、TypeScriptと候補Worker/内部handler browser bundleにも合格した。Show/Episode/2種改訂のpurge失敗からの同job完了、pause収束、token保持、Queue応答喪失/receipt保存失敗/偽key/通番飛ばし拒否を回帰した。

REST/source adapterは`m6_staging_rest.md`へ追加済み。ローカルdraft/job state連携、公開CLI/管理入口、unknown outcome/残存lock/tokenの安全な外部復旧、full cutover/paused移行完了/明示受付再開、専用環境受け入れと利用・移行・復旧案内は残る。公開gate成立前に書込commandを公開しない。
