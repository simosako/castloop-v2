# CLIのリリース

リリース準備をPRでマージし、`main` のコミットにタグを付けてGitHub Releaseを公開します。CLIには配信用Workerが含まれます。

## 1. リリースを準備する

1. 最新の `main` からリリース準備用ブランチを作成します。
2. 前回のリリース以降の変更を確認し、公開する版番号、利用者に伝える変更点、互換性や更新時の注意を整理します。版番号の判断に迷う場合は依頼者に確認します。
3. 次のファイルを更新し、変更内容とリンクを確認します。

| 対象 | 更新内容 |
| --- | --- |
| `package.json`、`package-lock.json` | 両方のバージョンを新版に揃える。CLIの `--version` は `package.json` の値を使う |
| `docs/release-vX.Y.Z.md` | 新版のリリースノートを作成する。主な変更、利用条件、更新時の注意、実際に確認した範囲を記載する |
| `CHANGELOG.md` | 新版の概要とノートへのリンクを追加し、未リリースの項目を整理する |
| `README.md`、`CONTRIBUTING.md` | 最新版の番号、リリースノートへのリンク、互換性の説明を確認し、必要に応じて更新する |
| `skills/castloop/SKILL.md`、`skills/castloop/references/publish.md`、`packages/cli/src/admin-skill.test.ts` | 版番号や利用条件の記述とテストを確認し、必要に応じて更新する |
| `docs/archive/releases/` | 前版のリリースノートを移動し、`README.md` の一覧を更新する。移動したノート内の相対リンクも確認する |
| その他のガイド・索引 | 変更された機能の説明と、最新版や移動したノートへのリンクを確認し、必要に応じて更新する |

最新版のノートは `docs/` 直下に置きます。CIはタグ名に対応する `docs/release-vX.Y.Z.md` をGitHub Releaseの本文に使うため、リポジトリ上とGitHub Releaseの両方でリンク先を確認してください。

リリースノートには、実施した検証とその範囲を記載します。Cloudflare実環境の試験は対象と操作範囲の明示的な承認を得てから実施し、実施していない検証を完了したとは記載しません。

## 2. PRを作成してマージする

準備した変更をコミットしてpushし、`main` 向けのPRを作成します。[build-binaries.yml](../../.github/workflows/build-binaries.yml) のすべてのbuild・smokeジョブの成功を確認してからマージします。

CIではLinuxで型検査と全ローカルテストを実行し、Linux x64・macOS arm64・Windows x64の各環境でCLIをビルドして起動確認します。バージョン、ヘルプ、チェックサム、入力検証、ローカルプレビュー、Skill出力なども検査します。

ローカルでのフル検査はリリースの必須手順ではありません。変更中に早く結果を確認したい場合や、問題を調査する場合は[ローカルでの確認](#ローカルでの確認)を実行してください。

## 3. タグを付けて公開する

1. マージ後の `main` と公開対象コミットを確認します。公開対象に含まれる変更は、PRのCI成功を確認してください。マージ後に修正が必要になった場合もPRで変更します。
2. 公開対象コミットに、`package.json` のバージョンと一致する `vX.Y.Z` タグを付けてpushします。
3. タグのpushで起動したCIの成功を確認します。CIは再度ビルドと起動確認を行い、成功後にGitHub Releaseを作成します。
4. GitHub Releaseの本文、リンク、次の添付ファイルを確認します。

   - `castloop-linux-x64`、`castloop-macos-arm64`、`castloop-windows-x64.exe`
   - `castloop-skill.tar.gz`
   - `SHA256SUMS`、`SKILL_SHA256SUMS`
   - `LICENSE`、`THIRD_PARTY_NOTICES.md`

## ローカルでの確認

開発環境は[CONTRIBUTING.md](../../CONTRIBUTING.md)で準備してください。次はLinux x64で検査する例です。

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

実行ファイルは `dist/` に出力されます。[ビルドスクリプト](../../scripts/build-cli.ts)は `src/sqlite-worker.ts` をCLIに埋め込みます。

## CIを保守する

外部Actionの更新は[更新手順](ci_security.md)に従います。実行環境やBun・Node.jsを更新した場合は、3種類のバイナリのビルドと起動確認をやり直してください。
