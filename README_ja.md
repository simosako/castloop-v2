# castloop

[![Latest release](https://img.shields.io/github/v/release/simosako/castloop-v2)](https://github.com/simosako/castloop-v2/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README_ja.md)

castloopは、自分のCloudflareアカウントでPodcastを配信するためのツールです。コマンドラインから番組やエピソードを管理し、RSSフィードと番組サイトの公開や、日時を指定した予約公開ができます。

> **初期ベータ版:** コマンドやデータ形式は互換性のない変更が行われる場合があります。インストールや更新の前に[リリースノート](https://github.com/simosako/castloop-v2/releases/latest)を確認してください。

## なぜcastloopを作ったのか

Podcastホスティングサービスのおかげで、誰でも気軽に配信を始められるようになりました。一方で、サービスの操作方法やプランによっては、思い通りに管理できないことがあります。たとえば、音声のアップロードを自動化したい、エピソードを指定日時に公開したい、保存容量を気にせず過去のエピソードを残しておきたい、といった場合です。

castloopは、Podcastの管理を自分でコントロールしたいという思いから生まれました。CLIはスクリプトなどに組み込むことができ、付属のSkillを使えばAIエージェントにも番組の管理を依頼できます。変更内容を確認してから公開することも、公開を予約することもできます。コンテンツは自分のCloudflareアカウントに保存されるため、Cloudflareの利用条件と料金に応じて容量を増やせます。

castloopは、Cloudflareの無料枠をできるだけ活用できるように設計されています。たとえば、R2のStandardストレージには月あたり10 GB-monthの無料枠があります。実際の費用は保存容量やリクエスト数、利用する他のCloudflareサービスによって異なります。最新の情報は[R2の料金](https://developers.cloudflare.com/r2/pricing/)と[Workersの料金](https://developers.cloudflare.com/workers/platform/pricing/)を参照してください。なお、MP3ファイルのサイズは1ファイルあたり300,000,000バイトまでです。

## 主な機能

- 手元のTOMLファイルを編集し、CLIから複数のPodcastを管理する
- 音声付きエピソード、RSSフィード、組み込みの番組サイトを公開する
- 変更内容を公開前に確認し、番組やエピソードの公開日時を予約する
- 公開内容の履歴を確認し、過去の内容に戻す
- 既存のPodcastをRSSフィードから取り込む
- 独自ドメインを使い、エピソードの配信統計を確認する
- AIエージェントによるPodcast管理に役立つSkillを書き出す

## はじめに

1. [最新のリリース](https://github.com/simosako/castloop-v2/releases/latest)からお使いの環境に合ったCLIをダウンロードし、[インストールガイド](docs/installation_ja.md)に従って設定します。
2. Cloudflareの認証情報を設定し、アカウントにサービスを作成します。
3. 番組とエピソードを作成してTOMLファイルを編集し、カバー画像とMP3を用意します。
4. 内容をプレビューして公開し、番組サイトとRSSフィードを確認します。

設定方法とコマンドの詳細は[はじめての公開](docs/getting_started_ja.md)で説明しています。たとえば、サービスを作成した後、次のコマンドで番組と最初のエピソードの編集ファイルを作成できます。

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
castloop create-episode first --workspace /path/to/workspace --show my-show
```

作成されたファイルを編集し、ガイドに沿ってプレビューと公開を行います。コマンドの一覧や使い方は `castloop --help` または `castloop help COMMAND` で確認できます。

## ドキュメント

- [利用ガイド](docs/README_ja.md)：公開、予約、移行、バックアップ、日常の管理
- [AIエージェントによる管理](docs/agent_usage_ja.md)：Skillの書き出しとエージェントへの依頼
- [設計文書](design/README.md)：アーキテクチャと実装の詳細
- [貢献ガイド](CONTRIBUTING.md)：開発環境の準備とコントリビューションの案内
- [変更履歴](CHANGELOG.md)と[リリース](https://github.com/simosako/castloop-v2/releases)：変更内容とバージョンごとの情報

## ライセンス

castloopは[MITライセンス](LICENSE)で提供されています。サードパーティのライセンスについては [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
