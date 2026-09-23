# castloop v2 デザインドキュメント

この資料は castloop (v2) のデザインドキュメントである。

## プロジェクト概要

- castloop (v2) は、Podcastをホスティングする機能を提供する
- 管理者が、自分のcloudflareアカウントにサービスをデプロイして利用することを想定する。不特定多数にサービスを公開してIDを作成させるようなものではない。
- 一人の管理者が複数のShow(ポッドキャスト番組)を作ることが可能
- ホスト先は cloudflare (必要であれば他サービスを利用することも検討する)
- cloudflareの無料Tierを活用し、できるだけ安価に実行できる環境を提供する。ただしアクセス数が多い場合など、CloudFlare無料枠で実行できる範囲を超える場合は有償プランに移行して利用することを想定している。（どんな規模でも無料にできることを目標にはしていない）
- Serverlessを活用し、運用の手間がかからない構成にする
- castloop CLIを提供し、このCLIで管理者はEpisodeを更新するなどの管理作業を行う
- GUIよりCLIを充実させ、自動化（AIエージェントから操作を含む）を実行しやすい環境を提供する

## 用語

- 管理者 : castloopを使ってPodcastをホスティングする人（Podcastを運営している人）
- Show : Podcast番組そのもの。管理者はcastloopを使って複数のShowを管理できる
- Episode : 番組の1話。Showの中に複数のEpisodeが存在する。MVPでは管理者がEpisodeを作成・更新できる。Episodeの削除はMVPでは非対応とする

## 作成するツール/サービス

- castloop (CLI) : castloopサービスを操作するCLI。typescriptで記述bunでシングル実行可能ファイルとして構築する
- castloop サービスバックエンド : Cloudflare WorkerでPodcast配信と公開処理（例えばfeed.xmlの更新）を行う

## 確定した構成とデータの正

- 1つのcastloopサービスにつき、1つのprivate R2バケットと1つの公開用Workerを用意する。Showは同じバケット内でshowIdを含むキーにより分離する。バケット名の規則は未決定
- 公開はWorkerのURLを標準とし、独自ドメインは任意とする。R2の公開URLは使わない
- 公開URLの基点 `public_base_url` はサービス設定で管理し、Showごとの `media_base_url` は設けない
- ローカルTOMLを編集元とし、R2には検証済みの公開スナップショットとジョブの状態を置く
- `update-episode`と`update-episode-audio`はR2の下書き領域へそれぞれメタデータと音源をアップロードするだけとし、公開しない。`publish-episode`だけが検証済みの下書きにcommit markerを配置し、R2 Event NotificationからCloudflare Queuesへ通知する。Queue consumerのWorkerが後続処理を行う
- Queue consumerはサービス全体で同時実行を1つに制限し、ジョブを逐次処理する。Cloudflare QueuesはFIFOやexactly-onceを保証しないため、jobIdによる冪等性と同一Episodeの更新順判定を設ける。判定規則の詳細は未決定
- RSS 2.0とApple Podcasts互換をMVP基準とし、入力schemaは下記の最小schema候補を採用する。`published_at` のTOML入力形式だけは検討中
- MP3の妥当性と再生時間はCLIで解析する。WorkerではR2 object size等を再確認する
- 人間可読なslugをIDとして使う。`serviceId`は最大20文字、`showId`は最大32文字、`episodeId`は最大80文字。基本形は`[a-z0-9]+(?:-[a-z0-9]+)*`とし、作成後は変更しない。Show IDは同一サービス内、Episode IDは同一Show内で一意とする

### Cloudflare認証とR2へのアップロード

- 対話的な管理作業にはCloudflare標準の`wrangler login`による認証を、自動化には環境変数のCloudflare API tokenを第一候補とする。認証情報はcastloopのTOMLやGit管理対象には保存しない
- CLIからWranglerを呼び出すかCloudflare APIを利用するかは実装前に比較する。標準の認証を利用するための実装量や運用上の負担が大きい場合は別方式を検討する
- MP3アップロード経路は未決定。Wranglerの`r2 object put`には現行の単一オブジェクト315 MB上限があるため、M0で想定音源サイズと照合する。上限を超える場合はmultipart uploadなどを検討する。この判断と認証方式を混同しない

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
- R2バケット名 (この単一バケット内に各Show、Episode関連データを格納する）
- 独自ドメインを使うかどうか（任意。Workerの公開URLが確定したら`public_base_url`としてサービス設定に保存）

質問が終わるとその内容を``castloop-init.toml``として保存。その後Cloudflareに接続し、R2バケット、公開用Worker、公開ジョブ用Queue、R2 Event Notificationの準備を行う。認証情報はTOMLに保存しない。設定ファイル名、Queueの作成・更新方法と初期化の詳細は別途決める。

### Show作成

```
castloop create-show <showId>
```

- castloop cliはshowIDが適切な文字列か（showIdに使って良い文字のみで構成されているか）を確認し、showIdの被りがないか（同じshowIdがすでに本サービスに存在しないか)をCloudflare側にアクセスして確認する
- showIdに使って良い文字や最大長は未決定。基本的にはshowIdがURLの一部に含まれる可能性を考慮してルールを決める。
- 現在、どういったshowIdがあるかといったことを管理するためのデータベースは用意しない。R2バケットをチェックすることで、既存showId一覧を取得する。
- 問題なければ、<showId>フォルダを作成し、その中にshow.tomlファイルをtemplate(show-template.toml)をベースに作成して保存。リモート側のID予約方法は別途決める

管理者は ``cd <showId>``でフォルダに移動し、その中でShowの作業を行う。最初はshow.tomlを編集してshowの設定を行う。

注： show-template.toml (draft)は design/ 以下にある

### Episode作成

```
castloop create-episode <episodeId>
```

引数のepisodeIdが決められた文字列だけで構成されているかを確認し、重複したepisodeIdが同一show内に存在しないことを確認し、問題なければ``episode-<episodeId>.toml``が ``episode-template.toml`` ベースで作成される。（例えば create-episode 001 とした場合、 episode-001.tomlが作成される）この際、後の音源更新でも変わらないGUIDを発行する。

注： episode-template.toml (draft)は design/ 以下にある

episode-<episodeId>.tomlをユーザーが編集

### Episodeの下書き更新と公開 (管理者側)

新規Episodeを公開する場合の流れは以下とする。

```text
castloop create-episode <episodeId>
# 管理者がepisode-<episodeId>.tomlを編集
castloop update-episode <episodeId>
castloop update-episode-audio <episodeId> <音源.mp3>
castloop publish-episode <episodeId>
```

- `create-episode`はローカルのTOMLを作る。公開済みデータは変更しない
- `update-episode`はローカルの`episode-<episodeId>.toml`を検証し、R2の下書き領域へメタデータだけをアップロードする。公開済みデータやRSSは変更しない
- `update-episode-audio`はCLIでMP3の妥当性・再生時間・byte lengthを確認し、音源だけを下書き領域へアップロードする。音源の検証結果も下書きに紐付ける。公開済みデータやRSSは変更しない
- `publish-episode`は必要な入力が揃っていることを確認し、下書きの内容を固定したうえで最後に`commit.json`を配置する。ここで初めて公開ジョブが受け付けられる。CLIはjobIdを返し、実際の公開完了・失敗は別途確認できるようにする。状態確認・回復のコマンドは未決定
- `publish-episode`前にローカルTOMLを変更した場合は、下書きのメタデータとの差異を検出し、`update-episode`の再実行を求める。誤って古いTOMLを公開しない
- 新規公開には下書きのメタデータと音源の両方が必要。既存Episodeの音源だけの更新では、ローカルTOMLが前回公開時と同じであることを確認したうえで公開済みメタデータを再利用できる。メタデータだけの更新では、前回公開済み音源を再利用できる。音源の再利用時は新たなMP3オブジェクトやenclosure URLを発行しない
- `publish-episode`実行後の下書きはimmutableとし、次の更新は新しいjobIdの下書きに行う。公開失敗時の再試行・回復方法は別途決める

初回公開も再更新も、音源アップロードだけでは公開しない。音源だけの再更新も`publish-episode`を明示的に実行する。

### Episodeの更新(サーバー側)

R2 Event Notificationは`publish-episode`によるcommit.jsonの作成だけをCloudflare Queueへ通知する。単一並列のQueue consumerが以下の後続処理を行う。Queueは順序と重複なしの配送を保証しないため、同じjobIdの再実行に対して冪等とし、古い更新が新しい更新を上書きしないようにする。更新順は音源やTOMLのアップロード時刻ではなく、公開の確定順を基準にする。確定順の記録方法と、複数端末からの同時公開時の扱いは別途決める。

- CLIが求めたdurationとR2が保持する音源のbyte length等を確認し、公開用metadataに記録する。durationはRSSのitunes:duration、lengthはenclosureのlengthへ使う
- 新音源がある場合だけ、音源をrevisionIdを含む新しいオブジェクトキーで保存し、上書きしない。音源未変更なら既存の公開済み音源を参照する。EpisodeのGUIDは更新前後で維持する
- revision metadataを履歴として保存し、Episodeのcurrent metadataだけを更新する。古いrevisionはMVPでは保持する
- 公開領域に保存されたMP3には、公開用Worker経由でインターネットからアクセス可能になる
- RSSの再構築を行う。feed.xmlを全体作り直し、必要なキャッシュパージを行う
- Workerの処理開始・完了・エラーをログに記録し、ジョブ状態をR2の`system/jobs/<jobId>/status.toml`に永続化する。CLIから公開完了・失敗理由を確認できるようにする。状態遷移、再試行・失敗ジョブの保持と、一連のR2書き込み途中の回復規則は今後詳細化する。MVPではD1等のDBを導入しない

### R2オブジェクトキー（採用済み）

```text
system/service.toml
system/shows/<showId>/show.toml
system/jobs/<jobId>/status.toml

temp/episodes/<showId>/<episodeId>/<jobId>/episode.toml
temp/episodes/<showId>/<episodeId>/<jobId>/audio.mp3
temp/episodes/<showId>/<episodeId>/<jobId>/commit.json

public/podcasts/<showId>/feed.xml
public/podcasts/<showId>/cover.<ext>
public/podcasts/<showId>/episodes/<episodeId>/<revisionId>.mp3
public/episodes/<showId>/<episodeId>/metadata.toml
public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml
```

公開Workerは許可された公開URLだけをこれらのpublic keyへ対応付ける。system/とtemp/は配信しない。Show metadataとカバー画像を反映する操作、公開URL pathの詳細は今後決める。
下書きの`episode.toml`と`audio.mp3`は変更があったものだけ配置し、既存公開版を再利用する場合は`commit.json`に参照元を固定する。音源の検証結果は音源オブジェクトのメタデータ等に保持する（具体的な形式は未決定）。`commit.json`は`publish-episode`以外のコマンドから書き込まない。

## サービス・ツールの構成

### Episode音源のファイルフォーマット

MP3を想定。MVPでは、
管理者がアップロードしたMP3ファイルをそのままprivate R2バケットに保存してCloudflare Worker経由で配信する。CLIでMP3と再生時間を解析し、WorkerではR2上のbyte length等を再確認する。

### ファイル配布とキャッシュ
feed.xmlや、Episodeの音源ファイル(mp3を想定)をprivate R2に置き、公開Worker経由で配信する。MVPではWorkers Cachingを採用する。`wrangler.jsonc` では以下を有効にする。

```jsonc
{
  "cache": {
    "enabled": true
  }
}
```

レスポンスには``Cache-Control: public, max-age=...``などを適切に設定することでキャッシュを効かせる。

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

これらのキャッシュ時間はサービス設定ファイルで上書き設定できるようにする。`workers.dev`のURLを標準とし、独自ドメインは任意。公開URLはサービス設定の`public_base_url`を基点として生成する。R2の公開URLは使用しない。Range/HEADとcache tagによるpurgeをM0で検証し、purge失敗時の再試行方法は実装前に決める。Rangeへの応答はWorkers Cachingが完全な`200` responseから切り出す方式を基本とする。

## MVPの入力メタデータとRSS

RSS 2.0およびApple Podcastsの配信要件をMVPの基準とする。ローカルの`show.toml`と`episode-<episodeId>.toml`を編集元とし、検証後にR2へ公開する。次の項目をMVPの最小schemaとする。

| Show入力項目 | 用途 |
| --- | --- |
| `schema_version`, `show_id`, `title`, `description`, `language`, `author` | Showの識別と基本情報 |
| `owner_name`, `owner_email`, `categories`, `explicit` | Podcastディレクトリ向け情報 |
| `site_url`, `image_path` | RSS channelのlinkとカバー画像。`site_url`を省略する場合の代替URLは未決定 |
| `copyright`, `show_type` | 任意項目。`show_type` は `episodic` または `serial` |

| Episode入力項目 | 用途 |
| --- | --- |
| `schema_version`, `episode_id`, `guid`, `title`, `description` | 話の識別と説明。GUIDは作成時に生成して不変とする |
| `published_at` | 公開日時。入力形式は検討中。RSS出力はRFC 2822 |
| `explicit`, `episode_type`, `season_number`, `episode_number` | `explicit`はShow設定を継承可能。後二者は任意 |

公開時の生成項目は`revision_id`、`enclosure_url`、`content_type`（`audio/mpeg`）、`length_bytes`、`duration_seconds`、`sha256`、`published_at`、`updated_at`とする。TOMLの入力値と生成値の配置、enumや任意項目の省略方法はschema詳細で定める。

日時について、RSSの`pubDate`はRFC 2822形式が必要だが、TOMLの入力にはRFC 3339日時または引用符付きRFC 2822文字列のいずれも使用できる。入力形式が確定するまでは`episode-template.toml`のRFC 3339表記を暫定とする。


## 開発の進め方とマイルストーン

MVPは機能を端から端まで動かすvertical sliceとしてM0〜M4を順に進める。

### M0: アーキテクチャ検証

- Wranglerの対話的ログインと自動化用API token、必要なCloudflareリソースの作成・アクセスを確認する
- private R2からWorker経由でGET/HEAD/Range配信できることを確認する
- Workers Cachingのcache hit、feedのtag purge、音源配信時のRange処理を確認する
- 想定する最大MP3のアップロードを実測し、Wranglerの単一オブジェクト上限で足りるか検証する。必要ならmultipart等の方式を比較する
- CLIでMP3のdurationを正確に取得できるか実測する
- R2 Event Notification → Queue → 単一並列consumerを確認し、重複配送・順不同に対する冪等処理を検証する

### M1: ローカルモデルと初期化

- 作業ディレクトリとCloudflareリソースの初期化、secretを含まないサービス設定
- `create-show` / `create-episode` によるローカルTOMLの生成、Show IDの予約
- strictなShow/Episode TOML schemaとslugの検証

### M2: 1 Episodeのend-to-end公開

- Show metadataとカバー画像を公開用に反映する
- `update-episode` と `update-episode-audio` で個別に下書きをR2へアップロードし、`publish-episode`で初めて公開ジョブを開始する
- Queue処理、R2 job status、RSS生成、音源配信、cache purge、失敗の検出・回復を通して1 Episodeを公開する
- CLIから公開ジョブの受付と、公開完了/失敗を区別して確認できる

### M3: 複数Episode・更新運用

- メタデータのみの更新と音源のみの更新をそれぞれ`publish-episode`で公開できる
- 音源revision更新時にGUIDを維持し、古いrevision履歴を保持する
- 重複・順不同ジョブ、同時更新、temp領域のcleanupを扱う
- RSS validatorおよびApple Podcastsの配信要件で成果物を検証する

### M4: 配布と利用文書

- Bunのsingle executableを作成し、インストールと更新手順を整える
- README、サンプルファイル、トラブルシュートを提供する

### MVP実装後の構想

- 予告配信(これはMVPに入れても良いかもしれない）
- アクセス統計情報の計測と出力(どのepisodeがどれぐらいアクセスされているか）
- 独自ドメインの設定支援・移行支援（MVPでも既存の独自ドメインを任意で利用できる）
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
