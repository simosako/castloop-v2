# run4 ビルド・自動検証

- 対象commit: `da6b6ea8309a87508dc7e7d0b4b70d84bba040d8`
- worktree: `build/castloop-v2-run4`（detached HEAD、検証前後ともclean）
- Bun 1.4.3 / Node v26.7.0 / npm 11.19.0
- `npm ci`: 成功、audit 0 vulnerabilities
- `npm run check`: 成功
- `bun test`: 937 pass / 0 fail、101 files、14404 assertions、44.12秒
- `npm run build:cli -- linux-x64`: 成功
- 配置先: `bin/castloop-linux-x64-da6b6ea`（既存binaryを上書きしない）
- build元と配置先のcmp/SHA-256一致: `d65ebe33be503fa25a93ac7d07dfd4f2561e21e6430ab4f4688ba33eb5ac5b8c`
- `--version`: 0.2.1。`help domain`: 成功

自動検証・build・help実行時にはCloudflare account/token環境変数を除外。
run1〜3、Cloudflareリソース、OS DNS設定は変更していない。
これはローカル自動検証の結果であり、修正版の実機domain remove完了を証明するものではない。
次は計画第2段階（API読み取りによる新規識別子の空き確認）から。
