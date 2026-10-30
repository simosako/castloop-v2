# CLIのインストール

## 1. ダウンロードする

[GitHub Releases](https://github.com/simosako/castloop-v2/releases/latest)を開き、利用するOSに合ったファイルをダウンロードします。

| OS | ファイル |
| --- | --- |
| Linux x86-64（glibc） | `castloop-linux-x64` |
| macOS Apple Silicon（macOS 11以降） | `castloop-macos-arm64` |
| Windows x64（Windows 10以降） | `castloop-windows-x64.exe` |

## 2. コマンドを使えるようにする

### Linux

ダウンロードしたフォルダで、次のコマンドを実行します。

```sh
chmod +x castloop-linux-x64
mkdir -p "$HOME/.local/bin"
mv castloop-linux-x64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
```

次回からも使えるように、最後の `export` 行をシェルの設定ファイル（Bashでは `~/.bashrc`）にも追加してください。

### macOS

ダウンロードしたフォルダで、次のコマンドを実行します。

```sh
chmod +x castloop-macos-arm64
mkdir -p "$HOME/.local/bin"
mv castloop-macos-arm64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
```

次回からも使えるように、最後の `export` 行を `~/.zprofile` にも追加してください。

配布ファイルは無署名のため、初回起動時にmacOSが実行を止めることがあります。ダウンロード元を確認し、「システム設定」→「プライバシーとセキュリティ」から実行を許可してください。

### Windows

ダウンロードしたフォルダでPowerShellを開き、次のコマンドを実行します。

```powershell
New-Item -ItemType Directory -Force "$HOME\castloop\bin" | Out-Null
Move-Item castloop-windows-x64.exe "$HOME\castloop\bin\castloop.exe"
[Environment]::SetEnvironmentVariable("Path", "$HOME\castloop\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

実行後にターミナルを開き直してください。

初回起動時にSmartScreenの警告が表示された場合は、ダウンロード元を確認し、「詳細情報」→「実行」を選びます。

## 3. 起動を確認する

```sh
castloop --version
castloop --help
```

バージョンとヘルプが表示されたら、[サービスの作成](getting_started.md)へ進みます。

## CLIを更新する

新しいバージョンのファイルをダウンロードし、インストール先の `castloop`（Windowsでは `castloop.exe`）を置き換えます。[リリースノート](https://github.com/simosako/castloop-v2/releases)で利用中のサービスとの互換性を確認してから更新してください。

配信サーバーも更新する場合は、続けて[サービスの保守](maintenance.md)の手順を実行します。
