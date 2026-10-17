# v0.5.0 レビュー後の重複整理

2026-10-17、`refactor/v050-review-cleanup`。dead code整理後の現行ファイルを再確認し、共通処理だけを抽出した。Cloudflareの配備・操作・実機測定は行わない。

## 対応範囲

| 指摘 | 対応 |
| --- | --- |
| SHA-256とhex変換 | Worker/sharedは`packages/shared/src/sha256.ts`、CLIの同期処理は`packages/cli/src/sha256.ts`へ集約。設定・要求のschema parseとJSON直列化の位置・順序は各ドメイン関数に残す。 |
| HMAC-SHA256 | `packages/shared/src/hmac.ts`へ鍵import・署名・Web Crypto検証を集約。protocol/domain prefix、JSONのフィールド順序、サイズ上限、空鍵のエラーは維持。 |
| 管理JSON応答 | `src/admin-reply.ts`へ集約。`no-store`、status、HEADでbodyを返さない経路の明示的charsetを維持。 |
| HTTPストリーム読み取り | `packages/cli/src/bounded-http-read.ts`でバイト上限・連結・reader解放・Retry-After解析を共有。R2管理GET、SQLite管理GET、試験観測GETから利用。 |
| fsync・排他作成 | draft作成と管理者鍵保存に既存の`writeSyncedLocalFile`、`createLocalJournalRecord`、`syncLocalJournalDirectory`を再利用。`wx`、0600、親directoryのfsyncを維持し、directoryは既存の`O_DIRECTORY \| O_NOFOLLOW`付き実装へ統一。 |
| `.gitignore`保護 | SQLite初期化の実装を`workspace-protection.ts`へ移し、Queue方式の初期化でも利用。既存ファイルを上書きせず、末尾の保護ルール・symlink拒否・サイズ上限・fsyncを共通化。 |
| 一覧整形 | `catalog-table.ts`でTSV列とcell escapeを共有。方式ごとに異なる警告・空ページ表示・cursor案内文は維持。 |
| ローカルジャーナル | 現存7種類のwrapperで`validated-local-journal.ts`を利用。ロック確認→次状態parse→既存状態load/identity検証→個別遷移検証→保存の順序を共通化。個別の遷移条件は変更しない。 |
| JournalFamily | family配列を唯一の定義とし、型と実行時検証の両方から利用。flat directoryの条件は別に維持。 |
| その他 | 内部関数に渡していた未使用の引数を除去。外部CLIの引数・認証契約は変更しない。 |

## 意図的に統一しない部分

- CLIの同期ジャーナル検証をWeb Cryptoのasync APIへ置換しない。既存のロック・チェックポイント間に新しい`await`を挿入しない。
- MP3・アップロード検証・RSS入力の逐次hashは`createHash`を維持する。巨大ファイルや複数入力の連結を単一バッファへ変更しない。
- テスト内の独立したhash/HMAC実装は比較用のoracleとして残す。同じ実装を期待値にも使って互換性の不具合を隠さない。
- HTTPの再試行回数、backoff、期限、GET先allowlist、許可status、Content-Length/圧縮の扱い、診断コードは方式ごとに維持する。共有するのは読み取りprimitiveだけで、更新要求の自動再送・fallbackは追加しない。
- R2管理readerは終端後にもcancelを試みる従来契約を維持する。SQLite/観測readerは読み取り終了・read失敗後にはcancelを重ねない。未完了の読み取りはcancel完了を待ち、失敗したら元の診断へ変換して停止する。
- ジャーナルの同一phase内の受付確認、retry/release、配備receipt/checkpointは同一ルールではないため、汎用状態機械にまとめない。schema、凍結対象、未知IOの再送禁止、retained lockの扱いは維持する。
- `migration-admin.ts`のbody reader、旧`src/index.ts`の公開パス解析、CLIの単純re-exportなどは前段で削除済み。今回のために復活させない。

## 挙動差分

Queue方式の`.gitignore`処理は、SQLite方式と同じ保護へ強化した。以前の「ルールがどこかにあれば追記しない」方式とは異なり、後続の否定ルールに負けないよう保護ルールを末尾に置く。symlinkや上限超過は秘密情報の作成・リモート初期化の前に拒否する。

## 検証

既存の安全性・失敗経路テストは削除せず、共通primitiveに対する既知hash値、独立HMACとのbyte互換、UTF-8/部分view、TSV escape、上限超過時cancelとlock解放、Retry-After、HEAD、ジャーナル検証順序、`.gitignore`保護の回帰テストを追加した。

- `bun test`: 1,230件成功、失敗0、135ファイル。
- `npm run check`: 成功。
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: 成功。設定ファイル・新しい検査ツールは追加していない。
- `git diff --check`: 成功。
- `bun scripts/build-cli.ts linux-x64`: CLI単体実行ファイルと両Worker bundleのbuild成功。実行ファイルの`--version`は`0.5.0`。

以上はローカル検証であり、実Cloudflareでの性能・CPU・配信受け入れが成立したことは意味しない。
