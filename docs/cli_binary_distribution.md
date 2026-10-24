# CLIバイナリ配布（Linux / macOS Apple Silicon / Windows x64）

Issue #73により、releaseには従来のLinux x86-64に加えて、macOS（Apple Silicon/arm64）とWindows（x64）のバイナリを追加配布する。本書は配布物の内容、ビルドと検証の仕組み、OS別の導入手順、検証済み範囲と**未確認範囲**を記録する。文書の内容と`.github/workflows/build-binaries.yml`が不一致の場合は、workflowを正として本書を修正する。

## 1. 配布物

| 対象 | artifact名 | 想定環境 |
| --- | --- | --- |
| Linux x86-64 | `castloop-linux-x64` | glibcベースの64bit Linux |
| macOS Apple Silicon (arm64) | `castloop-macos-arm64` | macOS 11以降 |
| Windows x64 | `castloop-windows-x64.exe` | 64bit版Windows 10以降 |
| 管理者Skill | `castloop-skill.tar.gz` | OS非依存（静的ファイル） |
| 検証用チェックサム | `SHA256SUMS` / `SKILL_SHA256SUMS` | 3バイナリ / Skill tar |

`SHA256SUMS`は3つのバイナリを1行ずつ`sha256sum --check`形式で列挙する。`LICENSE`と`THIRD_PARTY_NOTICES.md`もreleaseに添付し、実行ファイルと共に保持する。macOS Intel（x64）・Windows ARM・Linux ARMは配布しない。`scripts/build-cli.ts`の`macos-x64`ターゲットはsource build用に残るが、正式配布・検証の対象外である。

## 2. ビルドと検証の仕組み

`.github/workflows/build-binaries.yml`（PR・`v*` tag push・手動起動）:

1. **build**（matrix）: `ubuntu-24.04` / `macos-15`（Apple Silicon） / `windows-2025`（x64）のGitHub-hosted runnerで、それぞれ**同一OS・同一architecture上でnative build**する。Bun 1.4.4で`npm run build:cli -- <target>`を実行し、`src/sqlite-worker.ts`のみを埋め込む。ビルドした実行ファイルのSHA-256を`scripts/release-sha256.mjs`で計算し、`<binary>.sha256`としてartifactに含める。Skill tarはLinux jobで1回だけ作成する。`npm run check`と`bun test`（模擬Cloudflareを使う公開・upload回復・排他・不正設定拒否の回帰を含む）はLinux参照環境で実行する。
2. **smoke**（matrix）: 各OSのrunnerでartifactをダウンロードし、checksum再計算との照合、`--version`が`package.json`と一致、全コマンドの`--help`、`describe`/`schema`/`template`/`validate`/`doctor`/`preview-show`/`skill export`を含む空PATH standalone smoke（`scripts/smoke-agent-cli.mjs`）、`schema_version = 1`拒否、削除済みコマンド拒否をnative実行する。cross compileの成功を動作保証としない。
3. **release**（`v*` tag pushのみ）: 3プラットフォームのartifactとSkill artifactを統合し、`<binary>.sha256`を連結して`SHA256SUMS`を生成、`sha256sum --check`で全バイナリとSkill tarを検証してから`gh release create`で公開する。tag名と`package.json`のversionの一致はbuild jobで確認済みである。

## 3. 検証済み範囲と未確認範囲

**各OSで検証（CI runner上）:** checksum整合、version/tag一致、help・usage一式、埋め込みschema/template/validate、offline doctor、preview-show、Skill export、不正設定（schema version 1・未知コマンド・不足引数）の拒否、空PATH・ソース不在での単体動作。

**Linux参照環境のみ:** `npm run check`、`bun test`一式（`bun:sqlite`のprocess排他、journal lock、模擬Cloudflare originを使う公開・upload回復・復旧上限、RSS取込みの回帰を含む）。

**macOS・Windowsで未確認（本配布時点）:** 模擬Cloudflareを使う結合試験、同一workspaceへの同時実行と強制終了時のlock解放、日本語・空白を含むpathやsymlink/junctionを絡めた回帰、実機・実ネットワークでのTLS/DNS経路とRSS download、実Cloudflareでの管理操作全般。これらを実施する場合は、対象と範囲を別途承認の上で行い、結果を文書化すること。`O_NOFOLLOW`等のfile検査はWindowsではOS非対応のためno-opになる可能性があり、実効性はOSごとに異なる。

native検証で判明した挙動: macOS runnerの初回smokeで、`os.tmpdir()`配下（`/var`→`/private/var`という祖先symlink経由のpath）への`skill export`が`unsafe_destination`で拒否されることを確認した。これはsymlink化されたpath構成要素への書込みを拒否する**設計どおりの安全検査**であり、実際の利用では実パスのworkspace配下へexportするため影響はない。smoke側は実パスへ解決した作業ディレクトリを使って検証する。

## 4. 署名・notarizationとOSの警告

配布バイナリは**いずれも無署名**である（macOS codesign/notarizationなし、Windows Authenticode署名なし）。証明書の購入や警告の恒久的な無効化は前提にしない。

- **macOS Gatekeeper**: ブラウザ等でdownloadした実行ファイルはquarantine属性が付き、初回起動がブロックされる。checksum確認の上で、Finderの右クリック→「開く」、または`xattr -d com.apple.quarantine castloop-macos-arm64`で属性を消して起動するかは利用者の判断に委ねる。
- **Windows SmartScreen**: 未署名の`.exe`は「WindowsによってPCが保護されました」が表示されることがある。checksum確認の上で「実行」を選択するかは利用者の判断に委ねる。

## 5. OS別の導入手順

共通事項: `CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を環境変数で与える。workspaceは`--workspace`での明示指定を推奨し、Show/Episode定義のカバー画像・MP3のpathはそのOSの絶対pathで書く（MP3は300,000,000 bytes以下）。管理者マシンにBun/Node.js/Wrangler/ffprobe等は不要である。

### Linux x86-64

```sh
grep 'castloop-linux-x64$' SHA256SUMS | sha256sum -c -
chmod +x castloop-linux-x64
mkdir -p "$HOME/.local/bin"
install -m 0755 castloop-linux-x64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
castloop --version
```

### macOS（Apple Silicon）

```sh
grep 'castloop-macos-arm64$' SHA256SUMS | shasum -a 256 -c -
chmod +x castloop-macos-arm64
xattr -d com.apple.quarantine castloop-macos-arm64   # Gatekeeperで停止された場合のみ
mkdir -p "$HOME/.local/bin"
install -m 0755 castloop-macos-arm64 "$HOME/.local/bin/castloop"
# zsh: ~/.zprofile に export PATH="$HOME/.local/bin:$PATH" を追加
castloop --version
```

### Windows（x64）

```powershell
Get-FileHash castloop-windows-x64.exe -Algorithm SHA256   # SHA256SUMSの値と照合
New-Item -ItemType Directory -Force "$HOME\castloop\bin" | Out-Null
Copy-Item castloop-windows-x64.exe "$HOME\castloop\bin\castloop.exe"
# ユーザーPATHに追加（以降の新規ターミナルで有効）
[Environment]::SetEnvironmentVariable("Path", "$HOME\castloop\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
castloop --version
```

- 対話出力はUTF-8を想定する。古いコンソールで文字化けする場合は`chcp 65001`を実行するかWindows Terminalを使う。
- workspace・音源pathはWindows形式の絶対path（例: `C:\Users\you\workspace\samplepodcast`）で指定する。日本語・空白を含むpathは引用符で囲む。ただし日本語pathを絡めた回帰試験は未実施である（§3）。

## 6. runnerイメージの維持

matrixのrunnerラベル（`ubuntu-24.04` / `macos-15` / `windows-2025`）はGitHub-hosted imageの廃止に伴い更新が必要になる。更新時は[docs/ci_security.md](ci_security.md)の手順に従い、ActionのSHA固定の更新と区別してレビューする。`macos-15`はApple Silicon（arm64）イメージであり、Intel（`macos-15-intel`等）に切り替えない。
