# Issue #10 再試験（既存run1を続行）

- 対象commit: dc33f75ae7e02beefe5cf37d1d02aa9fd804abec。
- docs/rss_migration.md と README の compatible Worker updates に従う。
- 既存service rsstest-1012-r1 / hostname castloop-rss-r1.otftalk.com を維持。
- 同じimport 908efe60-3585-4a6a-af01-f1c5d8afb206を続行。入力・GUID・公開URL・journalを変更しない。旧ホストは変更・削除しない。
- 別worktreeでnpm ci、型check、全自動試験、Worker同梱CLI buildを実施。
- workspace設定・秘密journalを私有backupへ保存。入力hashと既存cursor/jobを記録。
- 既存serviceを読み取り、全Showをページング列挙。既存pauseがあれば採用、openなら新pause IDでpause。
- invocations=[]、全Show unfinished_show_operation=false を検証してからdeploy。未完了/エラーなら変更せず停止報告。
- 新runtime・domain・公開URLの保持とpaused状態を確認して明示resume。
- 新CLIで同じpublish-rss-importコマンドを一度実行。既知waiting jobを確認し、完了済み公開を再送しない。
- publication_status_changedのみCLI仕様内の最大120回/2分再照会を許容。他のエラーで停止。時間切れを強制解除理由にしない。
- 完了後は全36件のGUID/日時/番組情報、カバーと音源URL/GET/HEAD/Range/内容hashを照合。必要なDNS対応はプロセス限定1.1.1.1を使用、OS設定は変更しない。
- 証跡: evidence/rss-import-retest-dc33f75/。秘密原本は公開しない。今回の依頼には証跡push/Issue closeは含めない。
