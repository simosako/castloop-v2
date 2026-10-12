# 4781fad 性能追試の証跡

試験計画: `../../logs/test-plan-rss-performance-4781fad.md`。

## 識別・手順

- `build-identity.json`: 無改変source commitと新CLI SHA-256。
- `npm-ci.*` / `check.*` / `bun-test.*` / `build.*`: 依存取得・型検査・971件unit test・Linux build。
- `source-head.*` / `source-status.*`: 固定commitとclean worktree。
- `baseline-hashes.json` / `selection.json` / `verify-input.*`: 元のcompleted import/入力/TOML/設定のhashと前回同一Episode、正規化metadata比較。
- `before-*` / `install-*` / `installed-*` / `installed-worker.json`: 前状態、正式pause/deploy/cutover verified/resume、新Worker version。

## 測定・事後確認

- `measured-metadata-stage.*`: 同一metadataのstaging、CLI所要時間。
- `measured-publication-commit.*` / `measured-job.json`: 1jobの公開受付、CLI所要時間。
- `measured-poll-*` / `completion.json`: 既知jobの照会、published/releasedを観測した時刻。
- `worker-logs.jsonl`: Workers Logsのライブtail。認証headerやURL、任意例外本文は保存せず、正式 `worker_timing` / `publication_delivery` allowlistとinvocation種別/結果/例外件数だけを保存する。
- `tail-create-status.json` / `tail-ready.json` / `tail-closed.json`: stream接続/終了の証跡。tail sessionの作成/終了のみで、Workerログ設定/権限は変更しない。
- `after-drain-*` / `after-*` / `final-domains.*` / `preservation.json`: service invocation解放、全Show idle、feed/metadata/元入力の不変性とdomain整合。
- `performance-comparison.json` / `result.md`: 測定完了後の前回比較と結論。

前回baseline: `../rss-local-timing-20261012/`（a19efb4、36件Showの同一Episode metadata-only）。以前のroot consumer計測は今回のphaseよりroute/readiness分広いため、元traceのservice acquire開始〜release終了で境界を合わせた比較も出す。nested phase時間は加算しない。

今回、正式4781fadへ詳細R2 Proxy/trace header等のローカル改変は追加しない。ログの時間はI/O wall-time checkpointで、CPU profileでもGET数の実機計測でもない。各version 1標本、音源upload/copy・全件初回importの性能を代表する保証はない。暫定300秒待機への延長は速度改善に数えない。

**私有ファイルあり。ディレクトリ全体を無検査で公開しないこと。** `private-workspace-backup/`、`before/after-metadata-private.toml`、`before/after-feed-private.stdout`、設定/management応答にはメール・個人metadata・アカウント/execution情報を含み得る。本タスクではGitHubへのpushは行わない。
