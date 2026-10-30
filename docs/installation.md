# CLIのインストール

[GitHub Releases](https://github.com/simosako/castloop-v2/releases/latest)から、利用するOSのバイナリと `SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md` を取得します。配布CLIは単一の実行ファイルで、管理端末にBun・Node.js・Wrangler・ffprobe・別のR2資格情報は不要です。

## 配布物

| 対象 | artifact名 | 想定環境 |
| --- | --- | --- |
| Linux x86-64 | `castloop-linux-x64` | glibcベースの64bit Linux |
| macOS Apple Silicon (arm64) | `castloop-macos-arm64` | macOS 11以降 |
| Windows x64 | `castloop-windows-x64.exe` | 64bit版Windows 10以降 |
| 管理者Skill | `castloop-skill.tar.gz` | OS非依存（静的ファイル） |
| 検証用チェックサム | `SHA256SUMS` / `SKILL_SHA256SUMS` | 3バイナリ / Skill tar |

`SHA256SUMS` は3バイナリのSHA-256一覧です。`LICENSE` と `THIRD_PARTY_NOTICES.md` は実行ファイルとともに保持してください。macOS Intel、Windows ARM、Linux ARMは配布対象外です。Skillの利用は[エージェントガイド](agent_usage.md)を参照してください。

## 対応環境と検証範囲

各配布バイナリは、対応するOS・アーキテクチャのCIでビルドし、起動・チェックサム・版・ヘルプ、オフライン入力検証・ローカルプレビュー・Skill出力等を確認します。これは全機能の実Cloudflare動作を保証するものではありません。

- 型検査と模擬Cloudflareを使う結合試験を含む全ローカルテストは、Linuxの参照環境で実行します。
- macOS・Windowsでは、公開処理の結合試験、強制終了後のRSS再実行、日本語パス・空白・symlink/junctionを組み合わせた回帰、実ネットワークのTLS/DNS・RSS取得、実Cloudflare管理操作全般は未確認です。
- ファイル保護の実効性はOSで異なります。例えば `O_NOFOLLOW` の検査は、WindowsではOS非対応により効かない可能性があります。

## 署名とOSの警告

配布バイナリは**いずれも無署名**である（macOS codesign/notarizationなし、Windows Authenticode署名なし）。証明書の購入や警告の恒久的な無効化は前提にしない。

- **macOS Gatekeeper**: ブラウザ等でdownloadした実行ファイルはquarantine属性が付き、初回起動がブロックされる。checksum確認の上で、Finderの右クリック→「開く」、または`xattr -d com.apple.quarantine castloop-macos-arm64`で属性を消して起動するかは利用者の判断に委ねる。
- **Windows SmartScreen**: 未署名の`.exe`は「WindowsによってPCが保護されました」が表示されることがある。checksum確認の上で「実行」を選択するかは利用者の判断に委ねる。

## OS別の導入手順

チェックサムが一致しない場合は実行しないでください。以下では、バイナリと `SHA256SUMS` を同じディレクトリへ保存したものとします。

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
xattr -d com.apple.quarantine castloop-macos-arm64   # Only if blocked by Gatekeeper after verification.
mkdir -p "$HOME/.local/bin"
install -m 0755 castloop-macos-arm64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
# For zsh, add export PATH="$HOME/.local/bin:$PATH" to ~/.zprofile.
castloop --version
```

### Windows（x64）

```powershell
Get-FileHash castloop-windows-x64.exe -Algorithm SHA256   # Compare with SHA256SUMS.
New-Item -ItemType Directory -Force "$HOME\castloop\bin" | Out-Null
Copy-Item castloop-windows-x64.exe "$HOME\castloop\bin\castloop.exe"
# Add to the user PATH; open a new terminal afterward.
[Environment]::SetEnvironmentVariable("Path", "$HOME\castloop\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
castloop --version
```

- 対話出力はUTF-8を想定する。古いコンソールで文字化けする場合は`chcp 65001`を実行するかWindows Terminalを使う。
- ワークスペース・音源はWindows形式の絶対パス（例：`C:\Users\you\workspace\samplepodcast`）で指定します。空白等を含むパスは引用符で囲んでください。日本語パスを含む回帰は未確認です。

## 起動後とCLIの更新

`castloop --version` と `castloop --help` を確認し、[サービス作成](getting_started.md)へ進みます。Windowsでインストール直後にコマンドが見つからない場合は、新しいターミナルを開いてPATHを反映してください。

CLIの更新も、対応バイナリを取得してチェックサムを確認する手順です。公開済みサービスと[互換条件](README.md#対象と用語)が合う版を選んでください。インストールだけでは既存Workerは更新されず、[Workerコードの更新](maintenance.md)は別操作です。

ソースビルド・CI・runnerの保守は[開発資料](development/releasing.md)に分離しています。
