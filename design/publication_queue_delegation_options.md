# 公開受付をHTTPから後続Queue実行へ移譲する案

2026-10-14。`818c642`後の検討。管理者から、処理回数の削減だけでなくHTTP以外への移譲を検討するよう指示された。
**設計提案であり、実装・配備・権限変更はしていない。**
[固定負担の削減案](http_acceptance_fixed_cost_optimization_plan.md)と比較する。

2026-10-15追記: 管理者が段階Aの開発を承認し、v0.4.0を起点に`feat/publication-queue-submit`を作成した。[段階Aの実装契約](publication_queue_commit_stage_a.md)参照。以下は当初の比較・提案。
後続の承認による段階A配備/測定は[実機結果](publication_queue_commit_measurement_20261015.md)、
さらにclaim/staging/statusも移す現在の案C開発は[実装契約](async_management_implementation.md)参照。
案Cは実装・ローカルテストのみで、未配備・未実機測定。別Worker分離・権限変更は行っていない。

## 結論

移譲できる。現在のCLIはCloudflare REST APIを直接使っているので、
**CLIから既存QueueのREST APIへ公開要求を送り、service/runtime確認・CAS・marker作成をQueue実行へ移す案**を推奨する。
アプリのHTTP Workerで残る18回のR2 GETを減らすのではなく、その受付経路自体を通らなくする。

```text
CLI: local入力検証・要求の凍結・journal保存
  → Cloudflare Queues REST API: 公開要求を永続キューへ送信
  → Queue handler: service/runtime確認・所有権/実行token取得
  → commit marker保存・既存の詳細検証/公開runner
  → purge・完了記録・自分のtoken返却
CLI: 同じ要求/jobの進捗とpublished/releasedを確認
```

REST APIへのHTTP通信は残るが、castloopのHTTP Workerは実行しない。
Queue consumerはWorkerだが、HTTPとは別のinvocationであり、Queues文書の既定CPU上限は30秒、wall上限は15分。
スクリプトを新設しなくても、現在の`src/worker.ts`の`queue()`でこの実行予算を利用できる。
現行accountの実効設定は別途確認する。QueueにもCPU/memory/wall制限があり、無制限とは扱わない。

## 移譲先の比較

| 構成 | 判断 |
| --- | --- |
| CLI → Queues REST → 現在のQueue handler | **第1候補。** publication受付でアプリHTTP CPUを消費せず、既存CLI/Queue/R2を使える |
| 軽いHTTP入口 → `await Queue.send()` → Queue handler | 第2候補。API tokenなしのクライアントにも対応しやすいが、認証・bounded parse・enqueueのHTTP CPUは残る |
| HTTP入口 → 別Workerの同期HTTP/RPC | HTTPへの転送だけではQueueの実行予算に変わらない。RPCはcaller終了/切断でcalleeもcancelされ得る。独立したdurable jobとして扱わない |
| HTTP/RPC内の`waitUntil()` | durableな後続実行の代用にしない。HTTPのCPU予算を変える方法ではなく、応答/切断後の延長も最大30秒 |
| Queue → 新しいprivate consumer Worker | 可能だがCPU予算の変更には不要。独立deployが必要になった場合にruntime/配備設計を追加する |

Queues RESTのpublishには公式文書上`Queues Edit`権限が必要。
現在のtokenに含まれるかは確認するが、自動的にscopeを増やさない。
既存configのaccount/queue nameから正確なqueue IDを照合し、未知の資源を採用・作成しない。
Wrangler、Node.js、別のR2認証情報は要求しない。API tokenは引き続き環境変数だけで使用する。

## 段階A: claimを残し、commit処理全体をQueueへ移す

最初の変更は、現在の即時Show予約を維持する小さい構成にする。

1. stagingとCLIのlocal入力確認、現行の同期claimは維持する。
   凍結publication/control requestとreserved Show ownerがR2に残る。
2. CLIは同じjob/generation/manifest hashに束縛したcommit要求を凍結し、Queue RESTへ送る。
   HTTP commitを呼ばず、HTTPのservice invocationも取得しない。
3. Queue側が現在runtime、凍結要求、Show/Episode状態、同じclaim ownerを確認する。
   service invocationとShow executionを**自分の実行として**CAS取得する。
4. そのexecutionを保持したままmarkerを作成し、既存のpublication runnerへ進む。
   service/gate、詳細検証、公開書き込み、purge、完了保存は省略せずQueue側で行う。

重要なのは、**HTTPが保持したtokenをQueueへ渡して解放させる方式ではない**こと。
Queue側が最初からR2操作を所有し、その実行のI/Oがsettleした後に自分のtokenを返す。
Queueへの送信応答が不明ならCLIは要求を保持して停止し、POSTを自動再送しない。

### 現行runnerへの接続で必要な変更

現在の`commitOwnedPublication`はreserved/no executionのownerだけを許す。
新しいQueue実行では、marker PUTより前にexecutionを取得して未知I/Oを保護する必要がある。
単にこの条件を緩めず、**正確なjob/generation/request hash/executionに束縛したQueue用commit runner**を作る。
`acquireShowExecution`等のCAS/owner照合を再利用し、通常HTTP用の許可条件は混ぜない。

可能なら同じexecutionでmarker作成から既存Show/Episode runnerまで進める。
途中でtokenを別invocationへ引き継がず、service/runtime確認も同じQueue scopeで行える。
markerのR2通知は維持するため、後続の重複messageは同じjobへ収束させる。
一旦executionを返して別のpublication messageで続ける場合は、marker書き込み等の全I/O終了を確認してから返す。

Queue concurrency 1だけで安全とはしない。強制終了した旧実行のtokenが残る場合は、
再配送も新しい実行として公開へ進めず、既存のbusy/有限retry/DLQ/調査経路へ入れる。
unknown IO、elapsed time、HEAD不在、DLQ履歴からtokenを解除しない。

段階Aなら即時claimによるShowの編集/競合禁止と、更新・URL変更時の未終了owner確認を維持できる。
既知ownerのdrainはpausedでも可能にし、runtime readinessはQueue側で検証する。
**claim・staging・statusはまだHTTPであり、service全体のFree適合が完成するとは言わない。**

## 段階B: claimも含め、公開要求をまとめてQueueへ移す

公開mutationを全面的にHTTPから外すなら、CLIが凍結publication requestを1つ送信し、
Queue側で`claimPublicationOperation` → execution取得 → marker → publicationを実行する。
この場合も正式なatomic Show admissionを再利用し、順序/FIFOに依存しない。

ただし、段階Aより契約変更が大きい。

- enqueue成功時にはserver Show ownerをまだ確保していない。CLI local draftは凍結するが、
  server側の競合はconsumerがCASする時に決まる。
- 待ち時間中に別操作がgenerationを進めたら、その要求を拒否する。新しいgenerationへ自動補正しない。
- 新規claimはopen時だけ許す。既に同じownerを取得済みの再開と、未admitted要求を区別する。
  全messageをpausedでも許す`m6_consumer`として扱わない。
- pause/resume・互換更新・URL変更をまたいだ古い要求を勝手に開始しない。
  current runtimeと、明示的なadmission windowに要求を束縛する。
  候補は既存`last_resumed_pause_id`、実行version、config hash。generationや時刻だけでは代用しない。
- admission前の拒否ではShow ownerがないため、ownerを要求する`writeLifecycleJobStatus`へ失敗記録を押し込まない。
  小さなsubmission記録で`rejected/unclaimed`と、admission後の`failed/held`を区別する。
- 待機要求があるだけでservice updateを禁止するか、古いwindowの要求を拒否して更新するかを明示する。
  registry空とShow ownerなしだけで「Queueに古い要求はない」と推定しない。

競合で拒否した要求を修正・再提出する手順も必要。凍結requestやstaging job identityを書き換えず、
未知要求と確定拒否を分ける。万能な自動復旧や所有権強制解除は追加しない。
この契約変更への承認後に段階Bへ進む。

## 送信・認証・保持・進捗の必須条件

- application独自の`submission_id`を**送信前にjournalへ保存**する。
  Cloudflareのmessage IDは再送/重複排除の唯一のidentityにしない。
  同じIDの別bodyは拒否し、完了/拒否した要求を再配送で別操作として復活させない。
- Queueへの送信権限を持つことだけを、Show操作の許可とは扱わない。
  intent familyには、administrator key由来のdomain-separated署名/MAC等の承認証明を要求する案とする。
  service/action/submission/job/generation/manifest/admission windowを束縛し、consumerでもstrict検証する。
  秘密鍵・API tokenそのものはQueue bodyやR2記録に入れない。
- messageは既存のpublication manifest/identity/hash等に限定し、MP3・metadata本文・タイトル・emailを入れない。
  native Queueの128KB上限より小さいアプリ上限を設ける。
- Queue publish成功は**queued**であって、claim済み/marker作成済み/publishedの証明ではない。
  現行の`accepted` receiptの`key/created`を、そのまま作成済みmarkerの証拠として返さない。
  protocol/capability、CLI journal、RSS waiting、status schemaを同時に変更する。
- consumerは認証済みの小さなsubmission/request/resultをR2へ条件付き保存し、
  重複処理、公開状態照合、有限retry終了後の調査に使う。既存の凍結request/job記録も保持する。
- Workers FreeのQueue保持は24時間であり、Queueを永続job台帳にしない。
  consumer到達前はCLIの凍結要求/送信receiptと既存staging/requestを保持する。
  保持切れやR2記録不在だけで「送信されなかった」「旧I/Oがない」と判定しない。
- 同じ要求の明示的な再配送は別設計として限定し、未知POSTの自動retryや新job置換はしない。
  R2にある確認済み処理結果からの照合と、未確認要求の再送を区別する。
- consumerはすべての開始済みI/Oをawaitする。正常終了時だけown execution/service tokenを返す。
  確定的な公開前検証失敗の`failed/held`、immutable media/history、purge後の完了を維持する。

既存Workerのstatus endpointはHTTP CPUを使う。必要ならpublication進捗だけを
CLIの認証付きR2 REST読取へ移せるが、複数objectの整合照合・完了証拠・現在ownerの再読取を実装する必要がある。
単一status/HEADだけで成功やrecovery権限を決めず、runtime readinessを再検証していないsnapshotであることも区別する。
REST PUTにCASがあるとは仮定せず、状態書き込みは引き続きconsumerのR2 binding CASで行う。

## 物理的に別consumer Workerへ分離する場合

CPU予算の切替だけなら不要なので、当初は現在のQueue handlerを使う。
実際にprivate consumer Workerを新設する場合は、現行のruntime証明をそのまま流用できない。

現在の`requireM6ServiceRuntime`/delivery gateは、実行Workerとcache ownerが同じversionであることを要求する。
新consumerのversionはpublic Workerと異なり、そのまま接続すると拒否される。
public/consumer/cache ownerのidentityとbindingを証明するreadiness、Queue consumer設定の検証、
両方の配備・pause/drain・未知deployのjournal/recoveryを限定的に設計する必要がある。
片方だけ新しい状態でresumeしたり、version照合を削除して通したりしない。

## 次に具体化する範囲

まず段階AのQueue intent schema/MAC、consumer所有のcommit execution、receipt/journal、重複/応答喪失を設計する。
既存Queueとrunnerを使い、独立した別Queue/DBや汎用状態機械は作らない。
公開mutation全体を非HTTP化したい場合は、段階Bの非同期admissionとpause/window/拒否回復の契約を先に承認する。
固定負担のsnapshot/parse削減は、後続consumerの効率改善や残るHTTP endpointへの補助案とする。

実装後は入口の変更を含む自動回帰と、小容量→36件Show metadata更新で測定する。
publishがHTTP Workerを呼ばないこと、consumer CPU/wall、owner保全、duplicate時の非重複公開を確認する。
Free適合は残るHTTPも含めて判断し、Paid/権限の変更や既存環境への配備はこの検討だけでは行わない。

## 参照（2026-10-14）

- [Queues REST APIによる外部clientからのpublish](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/)
- [Queues CPU/wall/retention](https://developers.cloudflare.com/queues/platform/limits/)
- [Queuesのat-least-once配送](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [RPC lifecycleとcaller終了時のcancel](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
- [waitUntilの寿命](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
