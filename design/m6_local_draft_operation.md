# M6: target排他付きlocal staging/publication統合

`packages/cli/src/local-draft-operation.ts`の二つの内部runnerは、既存target draft journalを必須にして準備から終了までtarget lockを保持する。公開CLIへは未接続。legacy workspaceの自動採用、IDの再生成、unknown outcomeの再送は行わない。

## アップロード

`runLocalDraftStaging`はstrict caller headerからoperation ID/期待generation/固定timestampを受け、target/draft IDをdurable headから取り出す。全slotの未解決/残存lockを検査し、local入力からmanifest/private snapshotを準備する。REST credentialsとeffectsを作成してからprepared operation参照をheadへfsync保存し、その後だけclaim→begin→一度限りsingle PUT/全量GET→settlement→finishへ進む。

送信前guardはsource hashに加えてheadの意味的な前後一致を確認する。target lockはsource preparation、管理HTTP、全PUT/GET、検証とsnapshot disposalの間ずっと保持する。slot追加や変更は同targetの別runnerからできない。

settlementは現在のrunnerがawaitした全PUT effectの終了と、以後のPUTがない事実だけを申告する。時間/HEAD不在/外部statusから申告しない。REST disconnect後の遅延書込は未検証のU1という既存の前提を維持し、Cloudflare保証とは扱わない。PUT失敗時の明示aborted receiptも保持し、公開成功に扱わない。unknown claim/begin/settlement/finishはrequestedのまま再送しない。

## 公開

`runLocalDraftPublication`はheadのcurrent upload集合とexact base IDを使って最新local入力/finished receiptsからpublicationを準備する。prepared manifestでheadを先に凍結してからclaim/commitを行い、exact acknowledged local commit後にのみfrozenへ移す。各送信直前にheadとlocal入力/receiptを再検査する。

commit応答が失われればpublication journalは`commit_requested`、headは`publication_prepared`のまま。新upload/再公開/rotationを自動許可しない。commit成功はQueue consumer完了や公開配信成功を意味しない。

## 検証と残件

local TOML/MP3→durable target head→実内部管理handler→simulated REST PUT/GET→明示publication commitをShow/Episode初回/metadata-only/audio-onlyで結合した。全transport中のtarget lock、並行operation拒否、途中head変更、lost acknowledgement保持、aborted operationからの明示置換を回帰した。実Cloudflare検証ではない。

CLIのgeneration/current/base取得とstable IDの明示初期化/rotation、書込command接続、unknown outcome/残存lockの外部復旧、移行・実機受け入れは残る。通常candidateのmanagement/readiness公開gateは閉じたまま。
