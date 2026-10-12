# RSS既存取り込み続行 — 300秒試験build

- 管理者承認によりa19efb4から試験専用別worktreeを作り、CLI公開待機のみ300秒/300照会に延長。テストの待機回数期待値2か所も合わせる。標準buildは保持。
- 型check/全965自動試験成功を確認後、正式CLIをbuild。Workerソースの変更・再deployなし。
- base commit + source-diff-final.stdout + binary SHA-256で試験用変更を識別。標準a19efb4 CLIの合格結果とは区別。
- workspace/.castloopの私有backupを作成するだけで、削除・復元・cursor編集なし。全入力hash不変と21件目のpublished/releasedを確認して元publish-rss-importを一度続行する。
- エラー時停止。時間経過によるowner強制解放/未知変更再送なし。旧環境変更なし。
- 完了後、独立XML照合で全36件のRSS情報/GUID/日時/URLを確認。1.1.1.1直接DNS/TLS有効でカバーと代表2音源GET/hash/HEAD/Range、同じworkers.dev feed、feed304、私有パス404を確認。
- 全36音源の追加GET/R2全件snapshot/ライフサイクル回帰は今回先行させない。代表確認は全音源独立検証の代用と主張しない。購読者移行・旧ホスト廃止は対象外。
- 証跡: evidence/rss-import-retest-a19efb4-timeout300/。push/Issue closeは別依頼時。
