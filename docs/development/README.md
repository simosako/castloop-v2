# 開発・リリース担当者向け資料

castloop本体の開発や配布を担当する人向けの資料です。Podcastの管理手順は[利用ガイド](../README.md)から確認できます。

## 開発を始める

1. [CONTRIBUTING.md](../../CONTRIBUTING.md)で環境を準備し、テストを実行します。
2. [設計文書](../../design/README.md)で変更する機能の構成を確認します。
3. [テスト設計](../../design/testing.md)に沿って、変更内容を検証します。

## 配布を更新する

- [CLIのビルドとリリース](releasing.md)
- [リリースCIで使うActionの更新](ci_security.md)

Cloudflareの実環境で試験する場合は、対象と操作範囲の承認を受け、[非公開試験の保護条件](../../design/security.md#非公開の実機試験)を確認してから実行してください。
