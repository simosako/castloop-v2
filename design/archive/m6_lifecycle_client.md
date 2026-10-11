# M6: Lifecycle内部clientとdurable job journal

更新日: 2026-10-02

## 範囲と公開gate

Show/Episodeの停止・再開・削除を内部管理APIへ接続する`LifecycleAdminClient`と、`createLifecycleJournal`/`runLifecycleClaim`/`runLifecycleCommit`/`runLifecycleRetry`を追加した。公開CLI commandや現行Worker fetch入口には接続していない。candidateの通常書込と`m6_ready=false`を維持する。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。

wire契約は[`m6_management_api.md`](./m6_management_api.md)を参照する。clientは固定HTTPS origin、redirect拒否、一回限り送信、bounded strict response照合を使う。ID/generation/timestamp/confirmationを自動生成せず、callerの確認済み入力を凍結する。

## 保存する最小記録

git-ignoredの`.castloop/lifecycle-jobs/<serviceId>/<jobId>.json`に次だけを保存する。

- service/account/Worker/public originのidentity。
- 完全なclaim requestと明示confirmation。deleteには不可逆削除/運用記録保持の二つの承認を要求する。
- client phase、対象/action/generation/request hashを照合したclaim receipt、commit key/created。
- 明示retryの通番、requested/requeuedと一致するmarker key。

タイトル・説明文・メール・payload・管理key/API token・任意exception・remote status本文は保存しない。service TOMLへjob IDを書かない。strict schema/16KB上限/凍結request hash/identity/phaseとreceiptの整合を読取時にも確認する。同jobの入力変更や他account/Worker/originへの流用は拒否し、不正/過大recordを上書きしない。

新規directoryは0700、record/temp/lockは0600で作る。recordはexclusive作成し、更新は一意tempへ書込→file fsync→rename→directory fsyncを使う。新規directory階層のfsyncも実施する。保存失敗から未送信/成功を推測せず、残ったrecordを検査する。

## 受付とcommitは別の明示操作

| client phase | 意味/許可 |
| --- | --- |
| `prepared` | 確認済みrequestをローカル凍結しただけ。claim未開始 |
| `claim_requested` | claim POST前の保存が済んだ。結果不明を含み、再claim/commitしない |
| `claimed` | 一致するclaim responseの保存成功。明示commitの開始だけが可能 |
| `commit_requested` | commit POST前の保存が済んだ。結果不明を含み、再commit/retryしない |
| `committed` | 一致するcommit responseの保存成功。consumer完了ではない |

`runLifecycleClaim`はpreparedから一回だけclaimし、公開状態を変えない。`runLifecycleCommit`はclaimedから、同jobのheld owner・active execution不在・marker未作成を読み取り専用で確認し、requestedを保存してから一回だけcommitする。claimからcommitを自動実行しない。preflightは予約や原子的な実行許可ではなく、serverが再度CAS/gateを照合する。

応答喪失・不正response・成功receipt保存失敗ではrequestedを保持する。後のstatusにowner/marker/完了が見えてもphaseを昇格させず、POSTを再送しない。未知service/consumer tokenや残存lockからの安全な外部復旧は未完成で、この実装を復旧許可へ読み替えない。

## 同jobの明示retry

retryはcommit receipt保存済みのjobだけに限定する。読み取り専用statusで同jobの未完了held owner、marker存在、execution不在を検査後、`retry.attempt`を一つだけ進めたrequestedを保存する。一致するrequeued responseを受信・保存して初めて同attemptをrequeuedへ進める。

正常にacknowledgeされたretryの後には、改めて管理者が明示した次attemptを開始できる。unknown requestedからは開始しない。marker/status/progressを上書きせず、新しいjobを作らず、完了済み/foreign/active executionを拒否する。Queue送信応答はconsumer完了や一回限り配送の証拠ではない。

## Lockと読み取り専用照会

変更操作はservice/job別のexclusive非期限lockを保持し、全client Promiseと保存処理の終了後だけ返す。稼働中/強制終了で残ったlockを時間で奪ったり削除したりしない。HTTP timeoutはserver処理終了の証拠ではなく、requested recordを保持する。ローカルlockの正常返却もremote registry/consumer tokenを返す操作ではない。

`readLocalLifecycleJob`はkey/token/HTTPなしでrecordとlockの有無を読む。空workspaceにdirectory/fileを作らず、常に`remote_state_checked=false`を返す。公開CLI commandにはまだ接続しない。

`inspectLifecycleOperation`は同凍結requestのstatusを読むだけで、ローカルrecordを書き換えずlockを削除しない。完了やmarkerを見ても未知phaseを解放せず、statusの`authorizes_retry=false`を維持する。live/残存lockがあるときも観測から変更許可を作らない。

## 検証と残件

ローカルdisk/client/内部API/M6 Queue結合で停止・再開・削除の独立claim/commit、保存前POST禁止、claim/commit/retryの応答喪失・receipt保存失敗、unknown phase非再送、複数明示retry、live HTTP排他/残存lock保持、offline非書込、foreign identity、phase改変、偽receipt、不正/過大record、secret非保持を回帰した。全528テスト/9050 assertions、TypeScript検査、内部module bundle、M6実証tsconfigとLinux binary buildに合格した。

これはCloudflare実機の合格ではない。staging/publication側のclient/journalと状態照会、本番管理入口/CLIの接続、安全なunknown outcome/lock/token外部復旧、full cutover/paused移行完了/明示受付再開、専用環境での受け入れ、README/help/移行・復旧案内は残る。安全gate成立前に書込コマンドを公開しない。
