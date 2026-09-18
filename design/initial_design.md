# castloop v2 デザインドキュメント

この資料は castloop (v2) のデザインドキュメントである。

## プロジェクト概要

- castloop (v2) は、Podacstをホスティングする機能を提供する
- 利用者（Podcast)管理者が、自分のcloudflareアカウントにサービスをデプロイして利用することを想定する。不特定多数にサービスを公開してIDを作成させるようなものではない。
- 一人の利用者が複数のShow(ポッドキャスト番組)を作ることが可能
- ホスト先は cloudflare (必要であれば他サービスを利用することも検討する)
- cloudflareの無料Tierを活用し、できるだけ安価に実行できる環境を提供する。ただしアクセス数が多い場合など、CloudFlare無料枠で実行できる範囲を超える場合は有償プランに移行して利用することを想定している。（どんな規模でも無料にできることを目標にはしていない）
- Serverlessを活用し、運用の手間がかからない構成にする
- castloop CLIを提供し、このCLIで管理者はEpisodeを更新するなどの管理作業を行う
- GUIよりCLIを充実させ、自動化（AIエージェントから操作を含む）を実行しやすい環境を提供する

## 作成するツール/サービス

- castloop (CLI) : typescriptで記述bunでシングル実行可能ファイルとして構築する
- サービスバックエンド : 必要に応じてcloudflare workersで実装する

## 利用シナリオ（概要）

### 初期化

ユーザーが任意のディレクトリで初期化を実施

```
cd <任意のディレクトリ>
castloop init .
```

ここが、castloopのベースとなるディレクトリで、この中にCloudFlareと接続のために必要な情報や、showのディレクトリが作成される。

### Show作成

```
castloop create-show <showId>
```

これにより、
- castloop cliはshowIdの被りがないか（同じshowIdがすでに本アカウントの環境に存在しないか)をcloudflare側にアクセスして確認）
- 問題なければshowIdのディレクトリを作成
- showid/ディレクトリ以下に show.tomlファイルをtemplate(show-template.toml)から作成して保存

ユーザーは cd <showId>し、その中のshow.tomlを自身で編集してshowの設定を行う。

注： show-template.toml (draft)は design/ 以下にある

## サービス・ツールの構成

### Episode音源のファイルフォーマット

MP3を想定。MVPでは、ユーザーがアップロードしたMP3ファイルをそのままサーブ用private R2 バケットに保存してcloudflare workers経由でサーブする。

### ファイル配布とキャッシュ
feed.xmlや、Episodeの音源ファイル(mp3を想定)をダウンロード可能にする必要があるが、これらはprivateのR2バケットに置き、worker経由でアクセスし、workers caching を効かせるようにする。つまりworkerのconfigで以下を有効にし、

```
[cache]
  enabled = true
```

レスポンスには``Response:  Cache-Control: public, max-age=...``などを適切に設定することでキャッシュを効かせる。

音源のキャッシュは十分に長い時間を設定する。

```
Content-Type: audio/mpeg
Cache-Control: public, max-age=31536000, immutable
Cloudflare-CDN-Cache-Control: public, max-age=31536000
```

Episodeの音源ファイルが更新される場合は、R2上の音源を上書きするのではなく、あたらしいオブジェクト（キー）で新音源を保存し、配信URLを更新、RSSの <enclosure url> を新URLへ変更する（エピソードGUIDは変更しない）。

RSS feed (feed.xml)は、以下のようなキャッシュ設定にする。

- Podcastクライアント側：5分
- Workers Caching側：1時間
- エピソード公開・変更時：feed-<showId> を 即purge

```
Content-Type: application/rss+xml; charset=utf-8
Cache-Control: public, max-age=300
Cloudflare-CDN-Cache-Control: public, max-age=3600
Cache-Tag: feed-<showId>
```

これらのキャッシュ時間は設定ファイルで上書き設定できるようにする。


## 開発の進め方とマイルストーン

最初から完全なプロダクトを作るのではなく、まずはMVPを構築し、そこに機能を追加していく。MVPは以下のマイルストーン(M)を順に作成していく。

### M0 

環境確認のマイルストーン：必要なツールにアクセス可能か？ wranglerでcloudflareにアクセスできるか？ を確認。

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

- 予告配信(これはMVPに入れても良いかもしれない）
- アクセス統計情報の計測と出力(どのepisodeがどれぐらいアクセスされているか）
- 独自ドメインホスティング対応
- MP3ビットレート変更や音源フォーマット変換
- Episodeの削除機能
- エピソード音源更新時の古いバージョンの削除

## 開発環境

- typescript (主要な開発言語)
- bun (javascript runtime) : cloudflare上のランタイムは別途検討
- npm : モジュール管理
- mise : ツール管理
- wrangler (cloudflare cli) : npmにより管理されている


詳細バージョンなどはプロジェクトルートの ``.mise.toml`` や、 ``package-lock.json`` , ``package.json`` で管理。

## format/schema

別ファイルに保存。必要に応じて以下を参照。


