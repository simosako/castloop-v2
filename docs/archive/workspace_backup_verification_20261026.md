# ワークスペースバックアップの導入時検証（2026-10-26）

> 履歴資料。旧 `workspace_backup.md` の実装・検証記録を分離したものです。現行の操作と保証範囲は[バックアップガイド](../workspace_backup.md)、形式は[現行設計](../../design/components/workspace-backup.md)を参照してください。記録された環境や承認は、新しい実環境操作を許可するものではありません。

以下はIssue #63導入時の旧版での記録であり、v0.8.0の対象family・検査範囲・互換性を示すものではない。

Issue #63の実装として`packages/cli/src/backup-archive.ts`(コンテナ形式)・`backup-create.ts`・`backup-restore.ts`・`backup-passphrase.ts`を追加し、4コマンドをCLIに登録した。

- 自動試験: `bun test` 813 pass / 0 fail(バックアップ追加試験13件を含む。多チャンク境界、誤パスフレーズ、バイト改変・truncation・trailer破損、`..`/絶対パス/重複パス/digest不一致の細工アーカイブ、復元中失敗の破棄、`--include-audio`内外、symlink拒否、scan_errors、CLI外枠)。`npm run check`成功。
- 実データ確認: `.local-test-data`の実workspaceコピー(現行形式に`storage_layout`を補完した旧保持環境 `sq16r-6ec01dc6`（2026-10-29廃棄）のコピー、395エントリ)と実MP3 3件(約128MB)で作成・検証・preview・復元・`doctor --local`を通し、復元先との全tree差分なし・管理キー同一・`.gitignore`再生成を確認した(既定0.4秒/音源込み138MB 0.96秒/復元1.2秒)。旧schema 1 workspaceと`castloop.toml`なしのRSS取り込みディレクトリは拒否されることも確認した。同workspaceの`sqlite-controls`記録は旧形式のため`scan_errors`に記録され、復元前後で`doctor --local`の結果は同一だった。
- 未検証: TTYプロンプト(エコー抑制)は対話試験を行っていない。Cloudflareへの通信・実資源変更は本機能の対象外で行っていない。
