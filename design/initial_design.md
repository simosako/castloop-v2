# castloop v2 デザインドキュメント

この資料は castloop (v2) のデザインドキュメントである。

## プロジェクト概要

- castloop (v2) は、Podacstをホスティングする機能を提供する
- ホスト先は cloudflare (必要であれば他サービスを利用することも検討する)
- cloudflareの無料Tierを活用し、できるだけ安価に実行できる環境を提供する
- Serverlessを活用し、運用の手間がかからない構成にする
- castloop CLIを提供し、このCLIで管理者はEpisodeを更新するなどの管理作業を行う

## 作成するツール/サービス

- castloop (CLI) : bunでシングル実行可能ファイルとして構築する
- サービスバックエンド : 必要に応じてcloudflare workerで実装する

## 開発の進め方とマイルストーン

マイルストーン(M)を順に作成していく。最初から完全なプロダクトを作るのではなく、MVPを構築し、そこに機能を追加していく。

### M0 

必要なツールにアクセス可能か？ wranglerでcloudflareにアクセスできるか？ を確認。

### M1

以下を実現するための ``castloop`` CLIとサーバー側処理を実装する

- show 初期化と作成
- episode 登録

### M2

- episodeを元にRSSフィード更新
- 外部からepisode (音源ファイル)にアクセス可能

### M3

- README.md やサンプルファイルなど、利用者が使い始めるのに必要な情報・ファイルを作成

### MVP実装後の構想

- アクセス統計情報の計測と出力(どのepisodeがどれぐらいアクセスされているか）
- 独自ドメインホスティング対応

## 開発環境

- typescript (主要な開発言語)
- bun (javascript runtime) : cloudflare上のランタイムは別途検討
- npm : モジュール管理
- mise : ツール管理
- wrangler (cloudflare cli) : npmにより管理されている


詳細バージョンなどはプロジェクトルートの ``.mise.toml`` や、 ``package-lock.json`` , ``package.json`` で管理。

## format/schema

別ファイルに保存。必要に応じて以下を参照。


