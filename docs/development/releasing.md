# CLIのビルドとリリース

ビルド環境は[CONTRIBUTING.md](../../CONTRIBUTING.md)、利用者の導入手順は[インストールガイド](../installation.md)を参照してください。本書はビルドと配布を保守する担当者向けです。

## ローカルビルド

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

[ビルドスクリプト](../../scripts/build-cli.ts)は `src/sqlite-worker.ts` をCLIに埋め込み、単一実行ファイルを作ります。これらはローカル検査であり、Cloudflareへ配備しません。`macos-x64` もソースビルド用に受け付けますが、正式配布・CI検証の対象ではありません。

## CIの構成

[build-binaries.yml](../../.github/workflows/build-binaries.yml) は、main向けPR、`v*` タグのpush、手動起動で実行します。

| 対象 | runner | 出力 |
| --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `castloop-linux-x64` |
| macOS arm64 | `macos-15` | `castloop-macos-arm64` |
| Windows x64 | `windows-2025` | `castloop-windows-x64.exe` |

1. **build**：各OS・アーキテクチャでネイティブビルドします。Node.js 24とBun 1.4.4を使用し、Linuxでは型検査と全ローカルテストも実行します。タグと `package.json` の版の一致をLinuxで確認します。
2. **smoke**：各OSで成果物のチェックサム・版・全コマンドのヘルプ、非対応設定とコマンドの拒否を確認します。`smoke-agent-cli.mjs` はソースや外部コマンドを持たない空PATHの環境から、スキーマ・入力検証・ローカルプレビュー・Skill出力等を実行します。
3. **release**：`v*` タグpushの場合だけ、buildとsmoke成功後にチェックサムを再検証し、GitHub Releaseへ添付します。PRと手動起動では公開しません。

配布には3バイナリ、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`castloop-skill.tar.gz`、`SKILL_SHA256SUMS` を含めます。SkillはLinuxのbuildで一度だけ作ります。バイナリごとの `.sha256` はartifactに保持し、releaseで連結します。バイナリは無署名です。

## リリース文書と更新時の確認

CIは `docs/release-${tag}.md` をリリース本文として直接読みます。現行版の [release-v0.8.0.md](../release-v0.8.0.md) と今後公開する版のノートはこの位置に置き、ファイル名・タグ・パッケージ版を一致させます。公開済み旧版ノートは [archive/releases/](../archive/releases/README.md) に整理します。旧タグ時点のcheckoutには当時の配置が残ります。

- 動作・対応環境・互換条件・検証範囲を確認し、利用ガイドとリリースノートを更新します。ローカル試験だけで実機性能や全Free適合を主張しません。
- スモークの一時作業先は実パスへ解決します。書き込み先のリンク拒否検査を、試験を通す目的で緩めないでください。
- runner imageの廃止時はラベルを更新し、アーキテクチャを維持します。`macos-15` をIntel用imageへ替えないでください。
- Action更新は[SHA固定の更新手順](ci_security.md)に従います。runner・Bun・Nodeの更新とは区別してレビューします。
- リリース作成はCloudflare配備や既存サービスの更新を行いません。それらは対象と互換性を確認する別操作です。

各OSのスモーク成功と、実Cloudflareでの管理操作や全ファイルシステム条件の保証は別です。配布物の検証範囲と未確認事項は[インストールガイド](../installation.md#対応環境と検証範囲)を参照してください。
