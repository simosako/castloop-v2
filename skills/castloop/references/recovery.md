# 中断・エラー・結果不明

同じworkspaceのjournalが正本。会話履歴からIDを再生成しない。

1. 同じShow/job/operationを記録から特定する。`operation-list --local --workspace PATH --json`、`operation-status KIND ID --show SHOW --workspace PATH --json`、`job-status JOB --workspace PATH --json`を使う。
2. `queued`/`running`: 同じjobを観測する。待機切断・timeoutを公開失敗扱いしてpublishを再送しない。
3. publicationの`succeeded`: その操作の公開完了。uploadの`succeeded`: stage完了のみ。空queueや終端jobは全IOのsettlement証明ではない。
4. `failed`: 理由と確定した入力/base失敗を確認してから、新しい編集として扱う。
5. `blocked`、未知PUT/POST、未確認配備: 記録を保持して停止。新IDで再送、lock/journal削除、owner token奪取、強制解除、prefix削除は禁止。
6. `operation-resume upload ID --show SHOW --workspace PATH --json`は変更操作。元の対象・入力が一致し、既知の未着手または保存済み成功receipt等のCLI条件を満たす場合だけ、別途許可された限定続行を行う。名前だけで安全と判断しない。

Resume、deploy、取消、cleanup、非公開化、復元は通常編集の許可から推測しない。時間経過・HEAD不在・Feedが読めることを復旧根拠にしない。他Showの障害を理由に健全なShowを停止しない。診断に秘密や未公開本文を載せない。
