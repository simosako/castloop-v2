# M6: 完了応答喪失の明示照合

更新日: 2026-10-04

## 対象と安全条件

初期化・通常更新がserverで正常に完了した後、HTTP応答またはlocal保存だけが失われた場合を扱う。未知のupload/deploymentや実行中consumerを終了扱いにする機構ではない。

- localの`initialization_requested`/`completion_requested`には、応答確認済みの凍結targetが必要。record欠落/異なるconfig/残存lockでは続行しない。
- 初期化と更新で共通の`M6SetupClient.observeCompleted`を使う。更新では永久update requestもserverで照合する。
- 現在の100% deployment/version/settingsを前後検査し、認証付きservice statusのpaused/pause ID・空invocation registry・exact runtime readinessを確認する。永続runtime-checkの凍結requestとQueue receiptも必須とする。
- 前後のservice statusが完全一致する場合だけlocal journalを完了へ進める。`true`の完了申告、時間経過、HEAD不在、最新versionを見つけたことだけでは昇格しない。
- remote呼出は読み取り専用statusとREST GETだけ。prepare/complete、Queue送信、purge、upload/deployment、resume、lock除去は行わない。

file保存とlockは既存共通storageへ置き、初期化/更新固有のphase遷移は各journalへ残す。全操作を扱う汎用回復状態機械は追加しない。

## 試験専用binary

`init-reconcile OPERATION_UUID`と`update-service-reconcile OPERATION_UUID`を接続した。後者の`update-service-verify`（保存済みupload/deployment receiptから未実行の検証を続行）とは別責務である。通常公開CLI/entryのgateは開けない。

現在のbinary/source bytesが元のbuildと異なっても、回復時に再uploadしないため、保存済み初期化journalをそのまま開く。config hashと既知targetは厳密に照合する。

## 検証と残件

実HTTP handler/Queue/CASを使うlocal結合で、初期化・更新のcompletion応答喪失→永続証拠の非書込照合→local完了→paused維持を確認した。未完了、欠落/別request receipt、別pause、live token、途中generation変更を拒否し、remote writes/Queue送信が増えないことを回帰する。

専用Cloudflareで通常更新のcompletion応答だけを失わせたstandalone照合が合格した。local requested/server pausedからの非書込照合で、service generation/readinessと永久runtime-checkのETag/checksumを保持した。対象operation/versionは`m6_standalone_acceptance.md`。新規初期化の同種fault実機試験、強制終了受け入れ、未知の実行中PUT/consumer、残存lockの外部終了確認は残る。この実装を任意のunknown IOの安全な解放や、M6全体の受け入れ合格とは扱わない。

試験binaryの`update-service-drop-completion`は通常更新を一度実行し、serverの200 completion応答だけを消費して破棄する専用fault入口。production資源prefixを先に拒否し、通常binaryには含めない。`verify-completion-recovery.ts`がlocal requested・server pausedと新targetを検査してから別commandで照合する。通信障害の結果を捏造したreceiptや、強制終了したIOのsettlement申告は作らない。
