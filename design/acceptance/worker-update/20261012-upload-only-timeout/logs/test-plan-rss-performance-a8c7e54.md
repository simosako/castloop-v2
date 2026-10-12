# RSS公開 性能追試 — a8c7e54

- Issue #10の追加改修報告（comment-6121979331）と `docs/rss_migration.md` を確認。固定commit `a8c7e54e8c326ef238a2fcd9d672a27b002bec66` から別detached worktreeで無改変CLI/Workerをbuild。npm ci、型検査、全unit test、Linux単一CLI buildを実施する。
- 既存 `workspaces/rss-20261012-run1` / `otftalk-rss`（36件）/ completed importを保持。CLI hash・source clean・既存Worker version・全Show idle・service open/drained・入力/cursor/TOML hashを確認し、私有workspace backupを保存する。
- 正式pause → paused/drained → deploy → 新version/cutover verified → 明示resume。未知の変更要求・他エラーは停止、記録/owner維持。旧ホスト、run3、旧資源、音源を削除/変更せず、旧Workerへdowngradeしない。
- 同じEpisode `ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915` を同一metadata-onlyで2回正常更新する。1回目はカタログ初回構築として独立記録、published/released・service invocation解放・内容不変・consumer終了ログを確認してから2回目へ進む。2回目は構築済みカタログを用いる通常更新として前回4781fadと比較する。新revisionと管理generationの追加は正常更新として保持する。
- 計測helperは正式CLI/Workerとは別のローカル試験プログラム。前回修正した厳密な `operation-status publication JOB` の `publication_status_changed` のみ読み取り再照会（最大300秒/300回、1秒sleep）。変更POST/PUT再送や一般エラーretryなし。helper unit testを先に通す。
- 各jobで正式Workers Logsのライブtailを先に接続。固定event/phase/time/job/outcomeとinvocation種別/結果/例外件数だけ保存し、consumer終了ログ取得後に今回tail sessionのみ閉じる。API権限、Observability設定、Queue/cache設定は変更しない。
- consumer/unique_guid/feed_inputs/guard/progress/status/staging.finishと、CLI staging・公開受付・published/released観測までを比較。初回構築と通常更新を混ぜず、nested区間を合計しない。実機GET数/CPU時間は新たな計測コードを追加せず、fixture要求数とwall/I/O時間を区別する。
- Feed byte一致（全36GUID・日時・音源参照を含む）、metadata revision_id/updated_at以外一致、入力/cursor/TOML hash一致、カタログ36件/対象job・Show世代整合・通常更新で未変更entry不変、domain整合・全Show idleを確認。privateカタログは手動編集/削除せず、公開URLの404も確認する。
- DNSは1.1.1.1明示/curl --resolve、TLS検証有効。OS/router DNS変更・追加調査なし。
- 結果は `evidence/rss-performance-a8c7e54/`、`initial-catalog/`、`normal-update/` と `test-20261012.log` に保存。今回の依頼ではGitHub push/Issue追記は行わない。1標本ずつであり恒常性能保証や音源付き全件RSS移行/120秒超過解消の受け入れとは区別する。
