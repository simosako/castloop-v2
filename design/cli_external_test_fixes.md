# 外部環境テストで判明したCLIの修正

## 2026-09-30: サブコマンドのヘルプ

外部環境でv0.1.1の`init --help`、`create-show --help`、`create-episode --help`が`Invalid or missing value for --help`になった。

- 原因: 引数解析が全`--`フラグに値を要求し、トップレベル以外の`--help`を特別扱いしていなかった。
- 修正: 全実装済みサブコマンドの`--help`/`-h`、`help COMMAND`を通常引数の解析前に処理する。構文、実行ディレクトリ、公開・stagingの違いを表示する。設定・認証情報なしでも表示可能で、Cloudflareへの接続やworkspace作成は行わない。
- 確認: 全サブコマンドのhelp、引数の後のhelp、短縮形、未知コマンドと通常オプションの値不足をCLI subprocessの自動テストで検証する。
- 結果: `npm run check`、`bun test`（27件）、`git diff --check`に合格。Linux x86-64バイナリを再ビルドし、報告された3コマンドの`--help`が正常終了して説明を表示することを確認した。
- 公開済みv0.1.1バイナリは変更しない。修正版の配布には新しいReleaseが必要。
