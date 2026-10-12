# 4781fad 再測定1

初回 `../rss-performance-4781fad/` の途中停止記録を保持し、ユーザー承認に基づき同条件のmetadata-only追加1jobを測る。無改変4781fad CLI/Workerは再build/redeployせず同じhash/versionを確認する。

- 計画: `../../logs/test-plan-rss-performance-4781fad.md` の「再測定1」。
- `previous-job-poll-*` / `previous-job-confirmed.json`: 初回jobのpublished/releasedを読み取り確認。変更要求を再送しない。
- `build-identity.json` / `installed-worker.json` / `source-status.*`: 初回build/Worker更新との同一性。
- `before-*` / `baseline-hashes.json` / `selection.json` / `verify-input.*`: 測定前idle・前回と同一入力/36件Show/同一Episode metadata。
- `harness-tests.*` / `harness-source/`: 変更した単一job待機helperと6つのunit test。製品sourceやCLI/Workerは変更しない。
- `measured-metadata-stage.*` / `measured-publication-commit.*` / `measured-job.json`: 新規正常更新の1jobとCLI各区間。
- `measured-poll-*` / `completion.json`: 個別状態照会。`*.retry.json` は厳密な `publication_status_changed` だけを分類した読み取り再照会（300秒/300回以内）、他エラーは停止する。
- `worker-logs.jsonl` / `tail-*`: Workers Logsライブ取得。既知の一時照会競合ではtailを閉じず、consumer終了とservice invocation解放を取得後に終了する。計測ログallowlistのみ保存し、request headers/URL/任意例外本文を保存しない。
- `after-*` / `final-domains.*` / `preservation.json`: Feed byte一致、metadataのrevision/updated_at以外同一、元入力/cursor/TOML/設定hash同一、open/drained・全Show idle・domain整合。
- `performance-comparison.json` / `result.md`: 測定完了後の比較。a19efb4詳細計測のconsumer境界はservice acquire開始〜release終了に合わせる。phaseは重複しているため単純加算しない。

私有workspace backup/metadata/Feed/management応答を含み得るので、無検査で公開しない。このタスクではGitHub push/Issue追記は行わない。旧環境・音源・元RSS取り込み記録・停止した初回jobは削除しない。
