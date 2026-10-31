# Install the CLI

## 1. Download the CLI

Open [GitHub Releases](https://github.com/simosako/castloop-v2/releases/latest) and download the file for your operating system.

| Operating system | File |
| --- | --- |
| Linux x86-64 (glibc) | `castloop-linux-x64` |
| macOS Apple Silicon (macOS 11 or later) | `castloop-macos-arm64` |
| Windows x64 (Windows 10 or later) | `castloop-windows-x64.exe` |

## 2. Set up the command

### Linux

Run these commands in the folder containing the downloaded file:

```sh
chmod +x castloop-linux-x64
mkdir -p "$HOME/.local/bin"
mv castloop-linux-x64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
```

To make the command available in future sessions, add the last `export` line to your shell configuration file (for Bash, `~/.bashrc`).

### macOS

Run these commands in the folder containing the downloaded file:

```sh
chmod +x castloop-macos-arm64
mkdir -p "$HOME/.local/bin"
mv castloop-macos-arm64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
```

To make the command available in future sessions, also add the last `export` line to `~/.zprofile`.

The binary is unsigned, so macOS may block it on first launch. Check where you downloaded it from, then allow it to run in System Settings → Privacy & Security.

### Windows

Open PowerShell in the folder containing the downloaded file and run:

```powershell
New-Item -ItemType Directory -Force "$HOME\castloop\bin" | Out-Null
Move-Item castloop-windows-x64.exe "$HOME\castloop\bin\castloop.exe"
[Environment]::SetEnvironmentVariable("Path", "$HOME\castloop\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

Close and reopen the terminal afterward.

If SmartScreen displays a warning on first launch, check where you downloaded the file from, then select “More info” → “Run anyway”.

## 3. Check the installation

```sh
castloop --version
castloop --help
```

Once the version and help are displayed, continue to [creating a service](getting_started.md).

## Update the CLI

Download the new version and replace the installed `castloop` executable (`castloop.exe` on Windows). Check the [release notes](https://github.com/simosako/castloop-v2/releases) for compatibility with your service before updating.

To update the delivery server as well, follow the [service maintenance](maintenance.md) guide.
