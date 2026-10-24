# 中断・エラー・結果不明

同じworkspaceのjournalが正本。会話履歴からIDを再生成しない。

1. 同じShow/job/operationを記録から特定する。`operation-list --local --workspace PATH --json`、`operation-status KIND ID --show SHOW --workspace PATH --json`、`job-status JOB --workspace PATH --json`を使う。
2. `queued`/`running`: 同じjobを観測する。待機切断・timeoutを公開失敗扱いしてpublishを再送しない。
3. publicationの`succeeded`: その操作の公開完了。uploadの`succeeded`: stage完了のみ。空queueや終端jobは全IOのsettlement証明ではない。
4. `failed`: 理由と確定した入力/base失敗を確認してから、新しい編集として扱う。
5. `blocked`、未知PUT/POST、未確認配備: 記録を保持して停止。新IDで再送、lock/journal削除、owner token奪取、強制解除、prefix削除は禁止。
6. `operation-resume upload ID --show SHOW --workspace PATH --json`は変更操作。元の対象・入力が一致し、既知の未着手または保存済み成功receipt等のCLI条件を満たす場合だけ、別途許可された限定続行を行う。名前だけで安全と判断しない。

停止・再開の返答を失った対応開発版では、`show-control-status SHOW OPERATION_UUID --workspace PATH --json`でその操作の保存結果を読む。同じ制御コマンドを同じIDで再実行しても、送信開始済みなら照会だけでPOSTを再送しない。`result.control.result`は適用時、`result.state`は照会時の状態なので区別する。結果が見つからなくても未実行と推測せず、別IDでやり直さない。旧形式の記録や残存lockを変換・削除しない。

Resume、deploy、取消、cleanup、非公開化、復元は通常編集の許可から推測しない。時間経過・HEAD不在・Feedが読めることを復旧根拠にしない。他Showの障害を理由に健全なShowを停止しない。診断に秘密や未公開本文を載せない。
