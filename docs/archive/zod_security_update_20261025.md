# Zodセキュリティ更新（Issue #78）

> 本書は2026-10-25時点の依存更新と検証の記録である。以下の「現在の開発版」は当時の内部形式6/7を指し、v0.8.0（14/13）の配備手順ではない。現在の互換性と配備条件は[README](../../README.md)・[SQLiteガイド](../getting_started.md)を参照する。過去の`npm audit`結果は現在の依存全体の安全性を保証しない。

## 対応内容

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) / CVE-2023-54404への依存更新。修正版は4.6.6以上で、`package.json`の下限を`^4.6.6`、`package-lock.json`の解決版を**4.6.7**へ更新した。無関係な依存は更新していない。

castloop固有の攻撃成立や被害を確認した報告ではない。アプリの入力制限、認証、診断のallowlist、保存形式、Workerのclass名・binding・compatibility dateは変更しない。

## ローカル検証

2026-10-25、Linux x86-64 / Bun 1.4.4で実施。

| コマンド | 結果 |
| --- | --- |
| `npm ci --ignore-scripts` | 成功 |
| `npm ls zod` | `zod@4.6.7`のみ |
| `npm audit --json` | 対象勧告を含め脆弱性0件 |
| `npm run check` | 成功 |
| `bun test` | 674 pass / 0 fail、78 files |
| `npm run build:cli -- linux-x64` | 単体CLIと`src/sqlite-worker.ts`の同梱bundleを再ビルド成功 |
| `CASTLOOP_TEST_TMP=/tmp/opencode node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64` | 空PATH・ソース/runtime依存なしの既存smoke成功 |

smokeはschema・雛形・入力/素材検証・日時preview・local doctor・Show preview・Skill export・秘密を出さないエラーを確認する。Cloudflare実機、他OSの実行、native性能や攻撃成立の検証は行っていない。

## 配布・既存環境への反映条件

- 既存の配布済みCLIや配備済みWorkerは、mainへのマージや`npm ci`だけでは更新されない。修正版を含むCLIの再ビルド・配布・インストールが必要。
- Worker側への反映には、修正版依存で再ビルドした同梱Workerの別途配備が必要。CLIのインストールだけではWorkerは更新されない。本作業ではreleaseや実Cloudflareの変更を行わない。
- この依存差分自体は保存形式を変更しないが、現在の開発版WorkerはIssue #68の内部queue/content schema **6/7**を前提とする。v0.7.2等の**5/6**環境やその他の非対応環境へ、セキュリティ更新の回避策として現在のWorkerを配備しない。旧形式の移行・採用・fallbackは提供しない。
- 実環境へ反映する場合は、対象・範囲の明示承認、保存形式・runtime/config/target/baseの互換性確認を別途行い、正式な更新・検証続行手順を使う。凍結journalや結果不明のIOを別binaryで再送しない。配備はResumeや公開の承認ではない。
