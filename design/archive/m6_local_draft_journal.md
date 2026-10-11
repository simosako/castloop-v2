# M6: target別のdurableローカル下書き

`packages/cli/src/local-draft-journal.ts`は未公開の内部helper。ShowまたはEpisodeごとに一つのdraft job IDとEpisode base revision IDを固定する。legacy `.castloop` stateを採用・変換しない。HTTP、R2、Queue、公開CLIの切替は行わない。

## 保存と排他

- `.castloop/drafts/<service>/show-<show>.json`
- `.castloop/drafts/<service>/episode-<show>--<episode>.json`

immutable slugには連続hyphenがないためEpisode名の区切りは衝突しない。strict recordはservice/account/Worker/origin、target、draft/base ID、最大二つのupload slot参照、publication manifest hash、phaseだけを保存する。本文、GUID、local path、音源、secretは複製しない。

private file/directory、exclusive create、file/directory fsync、temp renameを使う。親directoryとrecordのsymlinkを拒否し、recordは既存のbounded/no-follow readerで読む。target lockをcallback全体で保持し、並行操作・既存lockを拒否する。時間によるlock奪取・削除はない。未知IOを伴うcrashではlockを保持し、通常callback終了でのみ返却する。

## 状態

1. `editable`: prepared staging journalをtarget/job照合してslotへ記録する。送信より前に参照を永続化する。同一IDの参照は維持できるが、別IDへ交換できるのは前slotの明示finished receiptがある場合だけ。古いupload journalは消さない。
2. `publication_prepared`: prepared publication journalのexact target、draft、base、upload集合、finished/staged receiptを照合してhashを固定する。以降は編集不可。claimより前にこの状態へ移す。
3. `frozen`: exact local publication journalのacknowledged `committed`だけを受けて移す。status観測、R2 marker観測、時間、HEAD不在で完了を認定しない。

## 次の下書き

`rotateLocalDraft`はtarget排他下で旧frozen recordとexact acknowledged commitを再照合する。旧recordを`history/<old-job>.json`へexclusive保存・fsyncしてから新しいeditable headをatomic renameする。過去history/publication IDは再利用不可。archiveだけ保存して中断した場合、exact同内容のarchiveだけを認めて続行できる。異なるhistoryは上書きしない。旧journal handleは新headを編集できない。

新headが既に指定IDなら同identity/baseのhandleだけを返し、phaseやuploadを初期化しない。新しいEpisode base IDはcallerが指定するが、current revisionやconsumer終了を証明するものではなく、server側のadmission/current/base照合を省略しない。commitはpublication完了ではなく、rotationはremote ownerを解放せず、進行中consumerへ割り込まない。

準備helper/runnerとの一体化、公開CLI、unknown outcomeの外部復旧、Cloudflare受け入れは残る。内部helperの自動testは実機受け入れではない。
