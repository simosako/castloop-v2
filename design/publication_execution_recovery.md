# 凍結publication実行の診断と明示解放

Issue #13(2026-10-12、`a8c7e54`、新規service `rssperf-1012-r2`での初回Show公開)を対象に、
canceled consumer invocationが残した実行token/service invocationの凍結状態の診断・運用・明示解放を定義する。
経過時間やDLQ到達だけでの強制解放は行わない。本方針は[m6_review_queue.md](./m6_review_queue.md)の
「consumer invocationの安全な回復」条件の延長である。

## 観測された事象と解析結果

最初のShow公開job(`publish/show`)のQueue invocationがwall 34,982ms / CPU 146msで`canceled`になり、
Show実行token(`owner.execution_id`)とservice invocation(`m6_consumer`)が残った。
同じjobの再試行2・3は`Another invocation still owns this lifecycle execution`で拒否され、`max_retries: 2`を使い切ってDLQへ到達した。
DLQ consumerは`system/jobs/<jobId>/dlq.json`へmarkerを保存するだけで所有権を解除しないため、
jobは`processing / validating`+`progress: feed`+`execution_id`保持のまま再開不能になった。

Dashboard export 1,757件(証跡branch `test-evidence/show-publication-canceled-20261012`)のspan解析で、
初回invocationの終了位置を特定した。

- 中断位置: `recordProgress("feed")`のPUT完了(11:34:57Z、progress保存と一致)後、
  `overwrite()`内部の`guard()`→`requireOwnedOperation`による凍結request GET(`system/jobs/<job>/request.toml`)
  の待機中。このGET spanは`ok=None`のまま終了している。
- CPU 146msに対しwall 35秒: CPU制限超過ではない。142回のR2操作が各200〜800msと遅く、
  待機時間が全体を占めた。canceledの直接の引き金(runtime側の中断理由)はログからは確定できない。
- 通常のcatch/finallyもR2アクセスを必要とするため、それ自体が中断すればtoken返却は完了しない。

## 凍結の仕組み

`consumeOwnedPublication`は`acquireShowExecution`で実行tokenを取得する。
token返却(`releaseSettledExecution`)とservice invocation返却(`withServiceInvocation`のfinally)は
catch/finally経由であり、runtimeによる強制終了では実行されない場合がある。
残留`execution_id`がある間、同じjobのconsumer・明示retry(`requeuePublicationOperation`)・CLI retryはすべて拒否する。
これは「稼働中invocationを解放しない」方針の意図的な動作であり、時間経過/HEAD不在だけで解除しない。

## 明示解放の安全条件

`release-job`(内部action `release`)は、次の条件を**すべて**R2の保存記録だけで検証してから実行tokenを解放し、
同じjobのcommit keyを再送する。いずれかが欠ければ拒否し、何も書き換えない。

1. 凍結publication manifest・凍結control request・commit marker・Show ownerが厳密に一致すること
   (job/generation/action/kind/request hash。`requireOwnedPublication`とmarker完全一致)。
2. ownerが未完了の`reserved`/`processing`であること(完了済みなら解放不要)。
3. `system/jobs/<jobId>/dlq.json`が存在し、内容がこのjobのcommit keyと完全一致すること。

DLQ markerがこの検証に使える根拠: Cloudflare Queuesは同じメッセージを逐次再配信し、
`max_retries: 2`を使い切った時点でこのjobの全配信試行が終了している。
attemptsは前の試行の終了後にのみ開始されるため、DLQ markerの存在は
「残留tokenを掴んだ元のinvocationを含め、このメッセージ由来の実行がすべて終了した」ことの保存証拠になる。
再送後に開始する新しいconsumerは、解放後のownerから新規tokenを取得するため競合しない。

解放操作は`m6_recovery` service invocationの下で実行し、次をこの順で行う。

1. 上記の検証。
2. service admissionに残留した`m6_consumer` invocationが**ちょうど1つ**のときだけ返却する
   (1メッセージbatch・concurrency 1では同時実行consumerは最大1つ。複数残っていればどれがどのjobか判別できないため触らない)。
3. `releaseShowExecution`(CAS)で実行tokenを解除。ownerは`processing`のままexecution_idなしになり、
   再送されたconsumerが`acquireShowExecution`から再開する。
4. 同じcommit keyを主Queueへ再送。

冪等性: 解放済み(execution_idなし・DLQ marker一致)の再実行は再送だけを行い、状態を壊さない。
メッセージの重複配信は元々想定内であり、consumer側のmarker/owner検査が冪等に処理する。

## 診断表示

- `operation-status`(publication status)は`execution_active`に加え`dead_letter_present`を返す。
- RSS import(`publish-rss-import`)の待機は、`execution_active`かつ`dead_letter_present`を検出した時点で
  待機上限(300秒)まで待たず、`publication-release`を案内するエラーで即座に停止する。

## 運用手順(凍結jobを見つけたとき)

1. `operation-status publication <job>`で`ownership: held`・`execution_active: true`・
   `dead_letter_present: true`を確認する。
2. Dashboard等で当該jobの配信試行がすべて終了していること(canceled/例外の記録、DLQ到達)を確認する。
3. `release-job <job>`(CLI)を実行する。応答`publication-released`は実行token解放・
   service invocation返却有無(`invocation_released`)・再送keyを返す。
4. `job-status <job>`で`published`+`released`になるまで確認し、元の操作(RSS import等)を再実行して続きから再開する。

`invocation_released: false`でservice admissionに`m6_consumer`が複数残る場合は、
他jobの実行と区別できないため個別に調査すること。実行tokenの解放自体には影響しない。

## 適用範囲と限界

- publication(Show/Episode公開)のみ。lifecycle(unpublish/restore/delete)の同種の凍結には
  同じ証拠構造が使えるが、今回は接続していない。必要になった際は同じ条件でlifecycle側にも
  解放操作を追加する。
- 経過時間・DLQ到達単独・HEAD不在を解放条件にしない。本操作は管理者の明示実行と
  DLQ marker一致検証の両方を要求する。
- service invocation tokenとjobの対応はR2に記録していないため、複数残留時の自動判別はできない。
- U1(中断されたPUTが後から書き込む可能性)は[m6_upload_recovery_options.md](./m6_upload_recovery_options.md)の
  未検証仮定のまま。公開出力の上書きはHEAD+CASで保護されているため、仮に後発書き込みがあっても
  再開時の検査が不整合として拒否する。
