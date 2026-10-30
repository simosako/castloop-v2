# CLIのビルドとリリース

CLIをビルドし、GitHub Releaseで配布する担当者向けの手順です。開発環境は[CONTRIBUTING.md](../../CONTRIBUTING.md)で準備してください。

## 1. ローカルで確認する

次はLinux x64向けのビルド例です。

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

実行ファイルは `dist/` に出力されます。[ビルドスクリプト](../../scripts/build-cli.ts)は、配信用の `src/sqlite-worker.ts` をCLIに埋め込みます。

## 2. バージョンとリリースノートを用意する

1. `package.json` のバージョンを確認します。
2. `docs/release-vX.Y.Z.md` にリリースノートを作成します。新機能、利用条件、更新時の注意、動作確認した範囲を記載してください。
3. 変更した機能の利用ガイドも更新します。

CIは `docs/release-${tag}.md` をリリース本文に使います。例えば `v0.8.1` の本文は [release-v0.8.1.md](../release-v0.8.1.md) です。

## 3. PRのCI結果を確認する

[build-binaries.yml](../../.github/workflows/build-binaries.yml) はmain向けPRでビルドと起動確認を行います。

| 対象 | 実行環境 | 出力ファイル |
| --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `castloop-linux-x64` |
| macOS arm64 | `macos-15` | `castloop-macos-arm64` |
| Windows x64 | `windows-2025` | `castloop-windows-x64.exe` |

CIではNode.js 24とBun 1.4.4を使います。Linuxでは型検査と全ローカルテストを実行し、各OSでバイナリをビルドします。

各OSの起動確認では、バージョン、ヘルプ、チェックサム、入力検証、ローカルプレビュー、Skill出力などを検査します。すべてのbuild・smokeジョブの成功を確認してからマージしてください。

## 4. タグを付けて公開する

公開対象のコミットに、パッケージ版と一致する `vX.Y.Z` タグを付けてpushします。タグのpushを受けると、CIが再度ビルドと起動確認を行い、成功後にGitHub Releaseを作成します。

公開後、リリース本文と次の添付ファイルを確認してください。

- 3種類のOS向けバイナリ
- `SHA256SUMS`
- `LICENSE` と `THIRD_PARTY_NOTICES.md`
- `castloop-skill.tar.gz` と `SKILL_SHA256SUMS`

## CIを保守する

外部Actionの更新は[更新手順](ci_security.md)に従います。実行環境やBun・Node.jsを更新した場合は、3種類のバイナリのビルドと起動確認をやり直してください。
