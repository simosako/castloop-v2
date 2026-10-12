# RSS公開 性能追試 — 4781fad

- `feat/m7-rss-import` の `4781fadbbd8a7b5dd1d4957024b165d774e7e2c1` を別detached worktreeに取得。無改変で型検査・全unit test・Linux CLI build。CLIに内包された同commitのWorkerを既存RSS試験workspaceへ正式更新する。
- workspace/取り込み素材/completed cursor/全ローカルTOMLをhash保存し、workspaceは私有コピーbackup。service open/drained、全Show未完了なし、前回と同じEpisodeの正規化metadata一致を先に確認。
- 正式 `service-pause` → drained/paused → `deploy` → runtime cutover verified/新version → 明示 `service-resume`。未知の変更要求は再送せず停止する。既存run3等・旧ホスト・公開音源は変更/削除しない。
- Worker更新後、Cloudflare Tail API（Workers Logsのライブstream）を対象Workerに接続し、接続完了後に計測。設定/権限は変更しない。request headers/任意例外/本文は保存せず、固定計測eventとphase/outcome/time/job ID、およびinvocation種別・結果・例外件数のみ保存する。tail作成失敗なら公開操作前に停止。終了時に今回作成したtail sessionだけ閉じる。
- 前回と同じShowの36件、同じEpisode `ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915` の同一metadata-only更新を1回実施。Show directoryで `update-episode EPISODE` → `publish-episode EPISODE`（MP3なし）。新revisionと正常なcontrol generation追加は許可済み計測に付随する変更として保持する。
- 既知のcommit済みjobのみ、1秒sleep付きで最大300秒/300回照会し、published/releasedを確認。失敗・未知状態・timeoutでは停止し、owner/記録を維持。CLI完了後はservice invocationの解放も読み取り確認する（Show解放とservice解放は別）。
- Workerログの consumer/guard/verify_staging/unique_guid/audio/feed_inputs/progress/status/purge/owner_release/invocation_release と staging各action、CLI各command/照会時間、Queue配送/attemptsを前回と比較する。CPU計測ではなくI/O区間wall time。nested区間を単純加算しない。前回と今回は各1標本で、計測方式/配置/負荷による差もあり恒常性能の保証ではない。
- 今回は無改変正式Workerログを利用し、詳細R2 Proxyや応答trace headerを追加しない。したがって実機GET数削減は計測できず、コード/mock操作数と実機区間時間を区別する。音源PUT/copyと全36件再importは対象外。完了済みimportを再実行しても公開性能の試験にならないため実施しない。
- 最後にFeed byte一致、metadataのrevision_id/updated_at以外一致、入力/cursor/TOML hash一致、domain整合、service open/drained/全Show未完了なしを確認。DNSは1.1.1.1明示・curl --resolve・TLS検証有効、OS DNS設定を変更しない。
- 改善済み4781fad Workerを試験環境に維持（a19efb4へ戻さない）。本タスクではGitHubへのpush/Issue追記はしない。結果と活動は `evidence/rss-performance-4781fad/` と `test-20261012.log` に保存。
