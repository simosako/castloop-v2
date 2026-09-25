# castloop v2 デザインドキュメント

この資料は castloop (v2) のデザインドキュメントである。

M0〜M4.5の完了時点ではWranglerを使用していた。MVP公開前に追加したM5で、管理者の実行環境と配布ビルドからWrangler依存を取り除く。過去の検証結果・当時の採用判断は履歴として残し、今後の実装・MVP受け入れ条件は[「M5: Wrangler不要の管理CLI」](#m5-wrangler不要の管理cli)を優先する。

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
- `update-show`はShow情報・カバー画像、`update-episode`と`update-episode-audio`はそれぞれEpisodeのメタデータと音源をR2の`staging/`へ置くだけで公開しない。`publish-show`または`publish-episode`だけが検証済みの下書きにcommit markerを配置し、R2 Event Notificationから同じmanaged Cloudflare Queueへ通知する。Queue consumerのWorkerが後続処理を行う
- Queue consumerはサービス全体で同時実行を1つに制限し、ジョブを逐次処理する。Cloudflare QueuesはFIFOやexactly-onceを保証しない。同一Show内のShow/Episode公開ジョブは未完了のものを1件までとし、次の公開受付を保留または拒否する。原子的な受付予約、障害後の回復、重複配送の冪等性を設ける。順序制御の実装詳細は未決定
- RSS 2.0とApple Podcasts互換をMVP基準とし、入力schemaは下記の最小schema候補を採用する。`published_at`は引用符付きRFC 3339文字列とし、RSS出力時にRFC 2822へ変換する
- MP3の妥当性と再生時間はCLIで解析する。WorkerではR2 object size等を再確認する
- 人間可読なslugをIDとして使う。`serviceId`は最大20文字、`showId`は最大32文字、`episodeId`は最大80文字。基本形は`[a-z0-9]+(?:-[a-z0-9]+)*`とし、作成後は変更しない。Show IDは同一サービス内、Episode IDは同一Show内で一意とする

### Cloudflare認証とR2へのアップロード

- 管理者はCloudflare Dashboardでアカウント・R2の利用準備を行い、必要な権限を持つCloudflare API tokenとアカウントIDを取得する。MVPの管理CLIは環境変数からこれらを読み、WranglerのOAuth認証や別のR2 S3 access keyを必須にしない。tokenをサービスTOMLやGit、公開Workerへ保存・転送しない
- M0〜M4.5ではWrangler subprocessでリソース作成・Worker deploy・R2 uploadを実装・検証した。M5でこれをバイナリ内のAPIクライアントへ移行する。Show ID予約と同一Showの公開受付は引き続き認証付きWorkerの原子的なR2 binding操作を使う
- MVPのMP3入力上限は**300 MB（300,000,000 bytes）**を維持する。Cloudflare REST APIのR2 object uploadには文書上の300 MB上限があるため、M5の最初に上限ちょうどの実upload・内容照合を確認する。満たせない場合は上限を黙って下げたり、追加のS3 credentialを暗黙に要求したりせず、方式を再検討する

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
- サービスID（管理者指定のslug）
- Cloudflare アカウントID
- R2バケット名 (管理者指定。この単一バケット内に各Show、Episode関連データを格納する）
- workers.devのアカウントsubdomain（M1ではWorkerの公開URLを生成。独自ドメインへの変更は後続段階で対応）

質問が終わるとその内容を作業ディレクトリ直下の`castloop.toml`として保存。その後Cloudflareに接続し、R2バケット、公開用Worker、公開ジョブ用Queue、R2 Event Notificationの準備を行う。認証情報と未公開jobIdはTOMLに保存しない。Queueの作成・更新方法と初期化の詳細は別途決める。

### Show作成

```
castloop create-show <showId>
```

- CLIはShow IDのslugを検証し、認証付きWorkerのR2条件付きPUTで`system/show-reservations/<showId>.json`を原子的に作成する。既存IDは競合エラーにする。同じローカル予約IDによる再送は成功扱いとする
- Show IDは人間可読slugの`[a-z0-9]+(?:-[a-z0-9]+)*`、最大32文字とし、M1では管理者が指定する。自動生成は必須としない
- 予約記録は公開済みShow metadataの`system/shows/<showId>/show.toml`と分離する。予約だけではfeed等の公開パスにShowを出さない
- <showId>フォルダと`show.toml`を作る。CLIはShowのWebサイトURLを管理者から入力（対話時の質問または非対話時の引数）として受け取り、必須の`site_url`を初期値として記入する。公開URLから実在するWebサイトURLを推測しない。通信失敗時はローカル下書きと予約IDを残して同コマンドで再送する

管理者は ``cd <showId>``でフォルダに移動し、その中でShowの作業を行う。最初はshow.tomlを編集してshowの設定を行う。

注： show-template.toml (draft)は design/ 以下にある

### Showの下書き更新と公開

```text
castloop create-show <showId>
# 管理者がshow.tomlとカバー画像を編集
castloop update-show <showId>
castloop publish-show <showId>
```

- `create-show`はIDを予約し、ローカルの`show.toml`を作成する。予約だけでは公開しない
- `update-show`はローカルのShow情報と`image_path`が指すカバー画像を検証し、同じ未公開jobIdの`staging/shows/<showId>/<jobId>/`にアップロードする。公開中のShow、feed、画像は変更しない。管理者がその後ローカルTOML・画像を変更した場合、古い下書きの公開は拒否して再度`update-show`を求める
- `publish-show`は下書きの入力を固定して最後に`commit.json`を置き、Queue経由で公開処理を起動する。初回公開も更新も同じ操作とし、このコマンドを実行するまでは外部に反映しない。Show情報の公開snapshot、固定キー`public/podcasts/<showId>/cover.<ext>`の画像上書き、feed更新、画像とfeedのcache tag purgeを行う。purgeに失敗した場合は公開完了とせず再試行する
- ShowとそのEpisodeの公開ジョブは同一Showの受付枠を共有する。先のジョブが未完了なら次の`publish-show`/`publish-episode`は受付しない。管理者はstaging操作を続けられる。予約・失敗時の再開と固定キーの画像拡張子変更時の扱いは別途決める

### Episode作成

```
castloop create-episode <episodeId>
```

引数のepisodeIdが決められた文字列だけで構成されているかを確認し、重複したepisodeIdが同一show内に存在しないことを確認し、問題なければ``episode-<episodeId>.toml``が ``episode-template.toml`` ベースで作成される。（例えば create-episode 001 とした場合、 episode-001.tomlが作成される）この際、後の音源更新でも変わらないGUIDを発行し、`published_at`へ作成時の現在日時を秒・offset付きのRFC 3339文字列として初期記入する。管理者は公開前に値を確認・編集できる。

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
- CLIはgit管理外のローカル状態ファイルでEpisodeごとの未公開jobIdを保持し、`update-episode`と`update-episode-audio`を同じjobに紐付ける。保存場所・別端末との競合処理・回復方法は別途決める
- `publish-episode`は必要な入力が揃っていることを確認し、下書きの内容を固定したうえで最後に`commit.json`を配置する。ここで初めて公開ジョブが受け付けられる。CLIはjobIdを返し、実際の公開完了・失敗は別途確認できるようにする。状態確認・回復のコマンドは未決定
- `publish-episode`前にローカルTOMLを変更した場合は、下書きのメタデータとの差異を検出し、`update-episode`の再実行を求める。誤って古いTOMLを公開しない
- 新規公開には下書きのメタデータと音源の両方が必要。既存Episodeの音源だけの更新では、ローカルTOMLが前回公開時と同じであることを確認したうえで公開済みメタデータを再利用できる。メタデータだけの更新では、前回公開済み音源を再利用できる。音源の再利用時は新たなMP3オブジェクトやenclosure URLを発行しない
- `publish-episode`実行後の下書きはimmutableとし、次の更新は新しいjobIdの下書きに行う。公開失敗時の再試行・回復方法は別途決める

初回公開も再更新も、音源アップロードだけでは公開しない。音源だけの再更新も`publish-episode`を明示的に実行する。

### Episodeの更新(サーバー側)

R2 Event Notificationは`staging/.../commit.json`の作成だけを同じmanaged Cloudflare Queueへ通知する。Show/Episodeの個別アップロードでは起動しない。単一並列のQueue consumerがShowの公開処理と以下のEpisode後続処理を行う。Queueは順序と重複なしの配送を保証しないため、同じjobIdの再実行に対して冪等とし、同一Showの公開受付は未完了1件に制限する。受付予約の原子性・途中停止からの回復・古い処理による予約の誤解放を防ぐ具体的な方式はM0で検証する。

- CLIが求めたdurationとR2が保持する音源のbyte length等を確認し、公開用metadataに記録する。durationはRSSのitunes:duration、lengthはenclosureのlengthへ使う
- 新音源がある場合だけ、音源をrevisionIdを含む新しいオブジェクトキーで保存し、上書きしない。音源未変更なら既存の公開済み音源を参照する。EpisodeのGUIDは更新前後で維持する
- revision metadataを履歴として保存し、Episodeのcurrent metadataだけを更新する。古いrevisionはMVPでは保持する
- 公開領域に保存されたMP3には、公開用Worker経由でインターネットからアクセス可能になる
- RSSの再構築を行う。feed.xmlを全体作り直し、必要なキャッシュパージを行う
- Workerの処理開始・完了・エラーをログに記録し、ジョブ状態をR2の`system/jobs/<jobId>/status.toml`に永続化する。CLIから公開完了・失敗理由を確認できるようにする。対象のcache purgeが成功するまで公開完了とはしない。一時的な失敗は同じjobIdをCloudflare Queuesで有限回数自動再試行し、尽きたメッセージは1つのDLQに隔離して管理者が状態を確認し明示的に回復する。恒久的な失敗は理由を記録し無用な再試行をしない。Queue/DLQだけに長期の履歴を依存せず、R2のjob statusと凍結snapshotを保持する。状態遷移、retry回数、statusとDLQの照合、公開受付予約の安全な解放、下書きの保持期間と途中書き込みからの回復規則は別途詳細化する。MVPではD1等のDBや自作のR2 queueを導入しない

### R2オブジェクトキー（採用済み）

```text
system/service.toml
system/shows/<showId>/show.toml
system/jobs/<jobId>/status.toml

staging/shows/<showId>/<jobId>/show.toml
staging/shows/<showId>/<jobId>/cover.<ext>
staging/shows/<showId>/<jobId>/commit.json

staging/episodes/<showId>/<episodeId>/<jobId>/episode.toml
staging/episodes/<showId>/<episodeId>/<jobId>/audio.mp3
staging/episodes/<showId>/<episodeId>/<jobId>/commit.json

public/podcasts/<showId>/feed.xml
public/podcasts/<showId>/cover.<ext>
public/podcasts/<showId>/episodes/<episodeId>/<revisionId>.mp3
public/episodes/<showId>/<episodeId>/metadata.toml
public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml
```

公開Workerは許可された公開URLだけをこれらのpublic keyへ対応付ける。`system/`と`staging/`は配信しない。Show情報とカバー画像は明示的な`publish-show`までは公開しない。公開URL pathとShowのID予約記録・公開snapshotの区別は検討中。R2 Event Notificationは`staging/` prefix・`commit.json` suffixのobject-createだけを対象にし、consumerがShow/Episodeそれぞれのpathとjob内容を検証する。
Episode下書きの`episode.toml`と`audio.mp3`は変更があったものだけ配置し、既存公開版を再利用する場合は`commit.json`に参照元を固定する。音源の検証結果は音源オブジェクトのメタデータ等に保持する（具体的な形式は未決定）。ShowとEpisodeの`commit.json`はそれぞれの`publish-*`以外のコマンドから書き込まない。

## サービス・ツールの構成

### Episode音源のファイルフォーマット

MP3を想定。MVPでは、
管理者がアップロードしたMP3ファイルをそのままprivate R2バケットに保存してCloudflare Worker経由で配信する。CLIでMP3と再生時間を解析し、WorkerではR2上のbyte length等を再確認する。

### ファイル配布とキャッシュ
feed.xmlや、Episodeの音源ファイル(mp3を想定)をprivate R2に置き、公開Worker経由で配信する。MVPではWorkers Cachingを採用する。現行の`wrangler.jsonc`では以下を有効にしている。M5のAPI deployでも同等のキャッシュ動作を検証する。

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
- ShowまたはEpisodeの公開・変更時：feed-<showId> をpurge。固定キーで上書きするカバー画像もcache tagでpurge

```
Content-Type: application/rss+xml; charset=utf-8
Cache-Control: public, max-age=300
Cloudflare-CDN-Cache-Control: public, max-age=3600
Cache-Tag: feed-<showId>
```

これらのキャッシュ時間はサービス設定ファイルで上書き設定できるようにする。`workers.dev`のURLを標準とし、独自ドメインは任意。公開URLはサービス設定の`public_base_url`を基点として生成する。R2の公開URLは使用しない。Range/HEADとfeed・画像のcache tagによるpurgeをM0で検証し、purge失敗時は公開を完了扱いにせず冪等に再試行する。固定URLの画像については利用者側のcacheをtag purgeで消せないため、画像のクライアント向けcache期間を別途定める。Rangeへの応答はWorkers Cachingが完全な`200` responseから切り出す方式を基本とする。

## MVPの入力メタデータとRSS

RSS 2.0およびApple Podcastsの配信要件をMVPの基準とする。ローカルの`show.toml`と`episode-<episodeId>.toml`を編集元とし、検証後にR2へ公開する。次の項目をMVPの最小schemaとする。

| Show入力項目 | 用途 |
| --- | --- |
| `schema_version`, `show_id`, `title`, `description`, `language`, `author` | Showの識別と基本情報 |
| `owner_name`, `owner_email`, `categories`, `explicit` | Podcastディレクトリ向け情報 |
| `site_url`, `image_path` | RSS channelのlinkとカバー画像。`site_url`は必須で、`create-show`が管理者の入力から初期記入する |
| `copyright`, `show_type` | 任意項目。`show_type` は `episodic` または `serial` |

| Episode入力項目 | 用途 |
| --- | --- |
| `schema_version`, `episode_id`, `guid`, `title`, `description` | 話の識別と説明。GUIDは作成時に生成して不変とする |
| `published_at` | 引用符付きRFC 3339文字列。`create-episode`が現在日時を初期記入する。RSS出力はRFC 2822 |
| `explicit`, `episode_type`, `season_number`, `episode_number` | `explicit`はShow設定を継承可能。後二者は任意 |

公開時の生成項目は`revision_id`、`enclosure_url`、`content_type`（`audio/mpeg`）、`length_bytes`、`duration_seconds`、`sha256`、`published_at`、`updated_at`とする。TOMLの入力値と生成値の配置、enumや任意項目の省略方法はschema詳細で定める。

日時について、TOMLの`published_at`は秒とoffsetを含む引用符付きRFC 3339文字列に限定する。`episode-template.toml`の固定の値は例示であり、実際の`create-episode`は実行時の現在日時に置き換える。RSSの`pubDate`にはRFC 2822形式で出力する。未来日時を拒否するか、公開後の手動修正を認めるかは検討中。


## 開発の進め方とマイルストーン

M0〜M4.5で機能を端から端まで動かすvertical sliceを実装・検証した。MVP公開条件を追加したため、M5を完了してからMVPとして配布する。

### M0: アーキテクチャ検証

検証の実行順・合格条件は[`m0_verification_plan.md`](./m0_verification_plan.md)にまとめる。

- VPSでは環境変数のAPI tokenを使い、Wranglerによる必要なCloudflareリソースの作成・アクセスを確認する。対話的なOAuthログインはブラウザのあるクライアントPCで実際に利用するときに確認する
- private R2からWorker経由でGET/HEAD/Range配信できることを確認する
- Workers Cachingのcache hit、feedのtag purge、音源配信時のRange処理を確認する
- MVP上限300 MB（300,000,000 bytes）のファイルをWranglerでupload・downloadでき、内容が一致することを確認する。超過時の拒否はCLIのファイルサイズ判定で実装し、M0での超過ファイルのupload試験は行わない
- CLIでMP3のdurationを正確に取得できるか実測する
- `staging/`のShow/Episode commit markerだけをR2 Event Notification → managed Queue → 単一並列consumerへ届けることを確認する。重複・順不同、同一Showの原子的な公開受付と障害回復に必要な操作を検証する。Queueの自動retryとDLQ、恒久的失敗を無駄にretryしない処理を確認する

### M1: ローカルモデルと初期化

- 作業ディレクトリとCloudflareリソースの初期化、secretを含まないサービス設定
- `create-show` / `create-episode` によるローカルTOMLの生成、Show IDの予約
- strictなShow/Episode TOML schemaとslugの検証
- 確定した設定ファイル名、日時・`site_url`の初期記入、設計とWorker/CLIの配置・module方式の整合を確認する

### M2: 1 Episodeのend-to-end公開

- `update-show`で情報・画像をstagingし、`publish-show`で公開する。画像更新では固定キーを上書きし画像とfeedのcache tagをpurgeする
- `update-episode` と `update-episode-audio` で個別に下書きをR2へアップロードし、`publish-episode`で初めて公開ジョブを開始する
- Queue処理、R2 job status、RSS生成、音源配信、cache purge、一時的失敗のretry・DLQへの隔離と失敗理由の確認を通して1 Episodeを公開する
- purgeに失敗したjobを完了扱いにせず、再試行して配信状態へ収束させる
- CLIから公開ジョブの受付と、公開完了/失敗を区別して確認できる

### M3: 複数Episode・更新運用

- メタデータのみの更新と音源のみの更新をそれぞれ`publish-episode`で公開できる
- 音源revision更新時にGUIDを維持し、古いrevision履歴を保持する
- 重複・順不同ジョブ、同時更新、staging領域のcleanupを扱う
- RSS validatorおよびApple Podcastsの配信要件で成果物を検証する

実装上は`base_revision_id`を公開commitに記録し、未変更のmetadataまたは音源はそのimmutable revisionを参照する。再配送時に現行revisionが同jobへ進んでいる場合も同じbaseから再構築する。完了したEpisode jobのstaging音源だけを明示的な`cleanup-job`で削除できる。実測と検証範囲は`design/m3_implementation_log.md`に記録する。

### M4: 配布と利用文書

- Bunのsingle executableを作成し、インストールと更新手順を整える
- README、サンプルファイル、トラブルシュートを提供する

単一実行ファイルへCLIと公開Worker bundleを同梱する。Cloudflare管理・R2 uploadには別途Wrangler CLI（Node.js/npm）を使用する。M4完了時点の音源解析は`ffprobe`に依存していた。実測は`design/m4_implementation_log.md`に記録する。

MVP公開前の追加マイルストーンM4.5で、CLIのMP3解析に純JSライブラリを採用し、配布先の`ffprobe`依存をなくした。Workerでの解析・従来の`ffprobe`へのフォールバックを含む判断と検証結果は[`pre_mvp_mp3_analysis_proposal.md`](./pre_mvp_mp3_analysis_proposal.md)に記録する。

### M5: Wrangler不要の管理CLI

**MVP公開前の追加計画。ゴール:** 管理者は対象OS向けの配布済み`castloop`バイナリとCloudflareアカウントID/API tokenを用意すれば、新規サービス作成から通常のShow/Episode公開・更新・状態確認・回復・Worker更新まで操作できる。実行先にNode.js/npm、Bun、Wrangler、`ffprobe`、ソースコード、R2 S3 access key/secret keyを要求しない。DashboardでのAPI token取得、R2の利用有効化、アカウント設定は事前準備として許容する。既存のR2・Queue・Worker構成、ローカルTOML、公開ジョブの順序と回復規則、300,000,000 bytesの上限は維持する。Worker bundleの作成もWranglerに依存しないビルド工程へ移し、配布物に同梱する。

1. **M5.0 API経路の実証（実装方式の確定ゲート）:** Cloudflare API tokenだけで、R2 bucket、Queue/DLQ、R2 Event Notification、Workerのscript・R2/Queue binding・consumer・secret・公開URLを作成/更新できることを専用リソースで確認する。特に300,000,000 bytesのMP3をR2 REST object uploadで転送し、取得したサイズ・SHA-256と通知発火を照合する。APIの文書上限「300 MB」の境界、upload時のメタデータ/Content-Type、通信中断と再送、Worker deploy時のsecretや既存設定の保持、Workers Freeでの動作を検証する。必要権限とAPI契約を記録する。単一tokenで成立しない操作があれば実装前に代替案と管理者に必要な準備を再提案する。
2. **M5.1 リソース管理・deployの移行:** `init`と`deploy`からWrangler subprocessを取り除き、バイナリ内の認証付きCloudflare APIクライアントでリソース作成、Worker bundleの配置、binding・Queue consumer/DLQ・通知rule・secretの設定を行う。既存workspaceと作成済みサービスの設定/データを保持し、失敗後は同一workspaceで再開可能にする。既存の任意設定・secretを意図せず消さない更新手順、認証エラーと一時的な障害の区別を確認する。
3. **M5.2 R2 staging/commitの移行:** `init`の`system/service.toml`書き込み、Show/Episodeの`update-*`と`publish-*`で行うR2 uploadをバイナリ内のAPIクライアントへ移す。MP3はストリーミングで転送し、上限超過を送信前に拒否する。送信後のサイズ・ハッシュ、同一jobの再試行と入力照合を確認し、`commit.json`がすべてのstaging入力の後にのみ書かれる契約を守る。`create-show`の予約、`job-status`、`retry-job`、`cleanup-job`等の既存Worker管理APIは引き続き利用する。
4. **M5.3 ビルド・配布物の移行:** Worker bundleをWranglerなしで生成し、Cloudflare Workers向けの成果物と実際のdeploy APIの互換性を検証する。GitHub ActionsからWranglerのインストール/呼び出しを除き、対象OS別のバイナリとchecksumを作る。CLI・Workerのバージョン、ライセンス表記、導入/更新/復旧手順を配布物とREADMEに反映する。過去のWranglerを使った検証ログは書き換えない。
5. **M5.4 受け入れ・公開判定:** Wrangler/Node.js/npm/Bun/`ffprobe`のない管理者環境で、配布済みバイナリと環境変数のAPI tokenだけを使用し、新規`init`→Show初回公開/更新→Episode初回公開/メタデータのみ・音源のみの更新→`job-status`/失敗jobの`retry-job`/`cleanup-job`→`deploy`を確認する。feed、カバー、MP3の取得・内容一致、300,000,000 bytesの転送、通知→Queue→公開完了/失敗回復、既存サービスの移行後の操作を実機で検証する。少なくとも現在のLinux x86-64をMVP受け入れ対象とし、macOS/Windowsを配布対象と表示する場合は各OSで必要な管理操作まで検証する。`--version`/`--help`だけでは公開フローの合格としない。

**実施状況（2026-09-25）:** Linux x86-64向けv0.1.0を[公開](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0)し、M5.0とLinuxのM5.1〜M5.4受け入れを実測した。詳細は[`m5_implementation_log.md`](./m5_implementation_log.md)と[`mvp_release_readiness_log.md`](./mvp_release_readiness_log.md)を参照。公開後の監査では、`init`のリソース作成がCloudflare側で成功して応答だけ失われたケースの再調整、および恒久的`failed` jobで`reserved`受付を安全に明け渡す運用コマンドが未実装と確認した。通常の公開フローが合格したことと、これら例外回復が揃ったことは区別する。

M5.0の参考API: [R2 REST object upload（文書上限300 MB）](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)、[Worker module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)、[R2 Event Notifications](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/event_notifications/)。これらの存在は現在のcastloopでの実行成功を意味しないため、M5.0の実測を合格条件とする。

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
- wrangler (cloudflare cli) : M0〜M4.5ではnpmで管理。M5でビルド・管理者の実行環境の両方から依存を取り除く


詳細バージョンなどはプロジェクトルートの ``.mise.toml`` や、 ``package-lock.json`` , ``package.json`` で管理。

## format/schema

別ファイルに保存。必要に応じて以下を参照。
