# castloop v2 デザインドキュメント

この資料は castloop (v2) のデザインドキュメントである。

## プロジェクト概要

- castloop (v2) は、Podacstをホスティングする機能を提供する
- 管理者が、自分のcloudflareアカウントにサービスをデプロイして利用することを想定する。不特定多数にサービスを公開してIDを作成させるようなものではない。
- 一人の管理者が複数のShow(ポッドキャスト番組)を作ることが可能
- ホスト先は cloudflare (必要であれば他サービスを利用することも検討する)
- cloudflareの無料Tierを活用し、できるだけ安価に実行できる環境を提供する。ただしアクセス数が多い場合など、CloudFlare無料枠で実行できる範囲を超える場合は有償プランに移行して利用することを想定している。（どんな規模でも無料にできることを目標にはしていない）
- Serverlessを活用し、運用の手間がかからない構成にする
- castloop CLIを提供し、このCLIで管理者はEpisodeを更新するなどの管理作業を行う
- GUIよりCLIを充実させ、自動化（AIエージェントから操作を含む）を実行しやすい環境を提供する

## 用語

- 管理者 : castloopを使ってPodcastをホスティングする人（Podcastを運営している人）
- Show : Podccst番組そのもの。管理者はcastloopを使って複数のShowを管理できる
- Episode : 番組の1話。Showの中に複数のEpisodeが存在する。管理者はShowの中にEpisodeを追加・削除したり、Episodeの内容を更新したりする

## 作成するツール/サービス

- castloop (CLI) : castloopサービスを操作するCLI。typescriptで記述bunでシングル実行可能ファイルとして構築する
- castloop サービスバックエンド : Podcast配信に必要な作業（例えばfeed.xmlの更新）を行うロジック。必要に応じてcloudflare workersで実装する

## 利用シナリオ（概要）

### 初期化

管理者が任意のディレクトで初期化を実行。

```
mkdir <castloop作業ディレクトリ>
cd <castloop作業ディレクトリ>
castloop init .
```

<castloop作業ディレクトリ>は、castloopのベースとなるディレクトリで、この中にCloudFlareと接続のために必要な情報や、show関連ファイルを作成していく。

この時、``.gitignore``が無いなら作成する。これは作業ディレクトリ全体をgitで管理可能にするため。``*.mp3``など、gitの管理外にするパスを含める。もし既存の``.gitignore``がある場合は、そこに管理外ファイルの情報を追記する。githubなどの外部レポジトリに秘匿情報（APIのキーなど）が含まれないように設計する必要がある。

``castloop init``では、castloopが、初期化に必要な情報をユーザーに質問して、それにユーザーが答える形で初期化を進める。

質問内容：
- Cloudflare アカウントID
- R2バケット名 (この中に各種show、episode関連データを入れていく）

質問が終わるとその内容を``castloop-init.toml``として保存。その後cloudflareに接続し、R2バケットの作成など、``castloop-init.toml``にしたがって初期化設定を行う。必要ならここでworkerの作成を行う。

### Show作成

```
castloop create-show <showId>
```

- castloop cliはshowIDが適切な文字列か（showIdに使って良い文字のみで構成されているか）を確認し、showIdの被りがないか（同じshowIdがすでに本アカウントの環境に存在しないか)をcloudflare側にアクセスして確認する
- showIdに使って良い文字や最大長は未決定。基本的にはshowIdがURLの一部に含まれる可能性を考慮してルールを決める。
- 現在、どういったshowIdがあるかといったことを管理するためのデータベースは用意しない。R2バケットをチェックすることで、既存showId一覧を取得する。
- 問題なければ、<showId>フォルダを作成し、その中にshows.tomlファイルをtemplate(show-template.toml)をベースに作成して保存

管理者は ``cd <showId>``でフォルダに移動し、その中でShowの作業を行う。最初はshow.tomlを編集してshowの設定を行う。

注： show-template.toml (draft)は design/ 以下にある

### Episode作成

```
castloop create-episode <episodeId>
```

引数のepisodeIdが決められた文字列だけで構成されているかを確認し、重複したepisodeIdが同一show内に存在しないことを確認し、問題なければ``episode-<episodeId>.toml``が ``episode-templat.toml`` ベースで作成される。（例えば create-episode 001 とした場合、 episode-001.tomlが作成される）

注： episode-template.toml (draft)は design/ 以下にある

episode-<episodeId>.tomlをユーザーが編集

### Episodeの更新 (管理者側)

create-episodeを実行しただけでは、音源がサーバー側にアップロードされていない。
ユーザーが更新した<episodeId>.tomlと音源のMP3ファイルを引数に、以下のようにupdate-episodeを実行する。

```
castloop update-episode <episodeId> <音源.mp3>
```

castloopは音源ファイルとtomlファイルをチェックし、問題があればコマンドのエラーメッセージとして管理者に通知し、そこで終了。

チェック内容： mp3ファイルかどうかのチェック、tomlファイルが想定されたフォーマットになっているかのチェック。また、同一show内でエピソードの更新処理実行中かどうかを確認し、処理中の場合もエラーにする。

チェックOKなら、音源とepisode-<episodeId>.toml がR2の一時ディレクトリにアップロードされる。一時ディレクトリは他と被らないようにcastloop cliが作成する。

ファイルが全て正常に一時ディレクトリ以下にアップロードされたら、castloop側は正常終了する。

### Episodeの更新(サーバー側)

Episodeが更新されたら、サーバー側ではそれを検知し以下の後続処理を実施する。(もしくはcastloop cliがworkerをkickする）

- episode-<episodeId>-supplemental.toml を作成し、そこに duration (音源の長さ（時間））と、length(ファイルサイズ[byte])を記録する。durationは、RSS feedの itunes:duration タグで、lengthは、<enclosure ... length="...">で、RSS feed作成時に利用する。
- 音源.mp3をshow内でユニークなファイル名``<unique>.mp3``に変更する。この時同じエピソードでも別の音源が再度UPDATEされる可能性を考慮し、episodeIdだけに依存しないユニークな名前にする必要がある。
- episode-<episodeId>-supplemental.toml , episode-<episodeId>.toml , <unique>.mp3 をR2の、該当showId用フォルダ以下の、publish/フォルダにコピーし、tempディレクトリとその内容を削除する
- publish/フォルダに保存されたmp3ファイルには、公開用worker経由でインターネットからアクセス可能になる
- RSSの再構築を行う。feed.xmlを全体作り直し、必要なキャッシュパージを行う
- workerの処理開始・完了・エラーはログに記録する

## サービス・ツールの構成

### Episode音源のファイルフォーマット

MP3を想定。MVPでは、
管理者がアップロードしたMP3ファイルをそのままサーブ用private R2 バケットに保存してcloudflare workers経由でサーブする。

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


