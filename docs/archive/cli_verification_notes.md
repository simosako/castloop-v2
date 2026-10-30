# CLI・CIの導入時確認記録

> 履歴資料。利用ガイドに混在していた過去の確認記録を分離しています。現行の導入は[インストール](../installation.md)、CI保守は[開発資料](../development/README.md)を参照してください。以下は現行版の全機能の検証結果でも、新たな実環境操作の承認でもありません。

## バイナリ配布時のmacOS確認

旧 `cli_binary_distribution.md` に記録されていた内容です。

native検証で判明した挙動: macOS runnerの初回smokeで、`os.tmpdir()`配下（`/var`→`/private/var`という祖先symlink経由のpath）への`skill export`が`unsafe_destination`で拒否されることを確認した。これはsymlink化されたpath構成要素への書込みを拒否する**設計どおりの安全検査**であり、実際の利用では実パスのworkspace配下へexportするため影響はない。smoke側は実パスへ解決した作業ディレクトリを使って検証する。

## エージェント機能導入時の確認

旧 `agent_usage.md` に記録されていた内容です。

v0.7.2導入時のローカル確認では、`bun test`は579 pass / 0 fail（70 files）、型検査・CLI build・standalone smokeが成功した。これは当時の記録であり、現行版のテスト件数や全機能の検証結果ではない。現在の配布・OS別の検証範囲は[CLIのインストール](../installation.md)を参照する。

## Action固定時の確認

旧 `ci_security.md` に記録されていた内容です。

2026-10-22の固定先は公式repositoryのgit ref/tagを読取確認し、既存major系列を維持したもの。Action全依存の完全監査やGitHub-hosted build成功をローカル検証の代用で主張しない。Bun/Node、runner image、外部downloadやnpm依存まで、この固定だけで不変になるわけではない。
