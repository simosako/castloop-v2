# castloop v2 デザインドキュメント

更新日: 2026-10-17。現在の公開版はv0.5.0。具体的な操作・導入手順は[README](../README.md)、関連文書は[設計文書の案内](README.md)を参照する。

v0.5.0は新しいSQLite方式を明示指定で提供する。既存Queue方式のdefaultとworkspace routingを維持し、サービス間・schema間の変換はしない。

- v0.2.0: M6の新規初期化、通常更新、Show／Episodeの非公開化・復元・削除を公開。
- v0.2.1: Show／Episode一覧を追加。
- v0.3.0: 1サービスにつき1つの独自ドメインを追加・照会・削除できる。
- v0.4.0: RSSから新規Showへの一度限りの移行、Episodeカタログ、公開受付とQueue検証の分離、停止診断と限定的なWorker更新続行を追加。
- v0.5.0: SQLite DO/FIFO/Alarmによる逐次公開、正式CLI・fresh init・一覧・非公開化/復元・RSS・code-only互換更新を追加。既存Queue方式にも直接commit送信を経た非同期管理（案C）と配信判定事前生成を統合。

配布・実機検証の対象はLinux x86-64。v0.1.xのデータ変換・既存資源の採用は行わない。M0〜M5の経緯は後半のマイルストーンと各実装ログに残す。

## SQLite方式の構成（schema_version=2）

- `init --publication-protocol sqlite-sequential-v1`で新規作成する。flag省略時は従来どおりQueue方式で、既存TOMLのschema/protocolを編集して変換しない。
- 1サービスにつき1 private R2 bucket・1 public Worker・1 SQLite-backed DO。Cloudflare Queues/DLQ/D1は使わない。
- CLIは一意のR2 keyへ素材をuploadし、全量hash・size・ETag/versionを確認してから、凍結公開要求をDOへ明示送信する。uploadだけでは公開しない。
- DOが受付window・runtime・target/baseを検証し、SQLite FIFOへ積む。Alarmが一件ずつ保存・feed生成・purgeを行い、SQLで完了する。R2はpayload/snapshot保存先で、ロックや進捗DBにはしない。
- `queued`は受付、`succeeded`はそのjobの保存/purge/完了記録であり、global quiescenceや回復権限の証明ではない。未知IOはblockedのまま保全し、POST/PUTを再送しない。
- 公開gatewayはDOの最新の小さい配信判定を確認し、同versionのcache ownerでfeed/mediaを配信する。immutable media/historyを維持し、GET/HEAD/Range/304とpause中503を扱う。
- fresh initとcode-only互換更新はnative Alarm/R2/cache/purgeを確認してpausedで終える。resumeは新しいwindow UUID。同config/schema/namespace以外の更新・変換は拒否する。
- 一覧20件pagination、Show/Episodeの非公開化・保存snapshotの復元、ローカルRSSの新Showへの逐次公開に対応する。物理削除・独自ドメイン・既存移行・retry/releaseは未対応。
- 最新36件規模試験は公開36件＋更新10回が完了し、通常HTTP最大3/5ms、probe CPU 60/60だった。DOは通常HTTPの10msではなく既定30秒のCPU上限で評価する。未試験負荷・300MB新経路・purge rate-limit retry・Issue #13恒久解消は保証しない。

操作と制限は[SQLiteガイド](../docs/sqlite_sequential_development.md)、設計契約は[実装計画](sqlite_sequential_publication_implementation_plan.md)、測定は[2026-10-17の記録](sqlite_size36_measurement_20261017.md)を参照する。

## 以下の章の適用範囲

以下は従来の**Queue/R2方式（schema_version=1）**の詳細・履歴であり、SQLite方式の操作契約として使わない。
旧公開HTTP受付の説明はv0.4.0までの履歴で、v0.5.0の新しいstaging/publicationは[案C](async_management_implementation.md)のQueue管理を使う。
現在のQueue操作と更新要件は[Queue方式ガイド](../docs/queue_service.md)を優先する。特に削除・domain・同じpause IDでのresume・owner/retry契約をSQLiteへ適用しない。

## プロジェクト概要

- castloop (v2) は、Podcastをホスティングする機能を提供する
- 管理者が、自分のcloudflareアカウントにサービスをデプロイして利用することを想定する。不特定多数にサービスを公開してIDを作成させるようなものではない。
- 一人の管理者が複数のShow(ポッドキャスト番組)を作ることが可能
- ホスト先はCloudflare Workers・R2・Queues
- Cloudflareの無料枠活用を目指す。ただしv0.4.0の公開HTTP CPUの既存観測15〜34msはFreeの10ms目標未達であり、Freeでの安定稼働を保証しない。課金プランを自動変更しない
- Serverlessを活用し、運用の手間がかからない構成にする
- castloop CLIを提供し、このCLIで管理者はEpisodeを更新するなどの管理作業を行う
- GUIよりCLIを充実させ、自動化（AIエージェントから操作を含む）を実行しやすい環境を提供する

## 用語

- 管理者 : castloopを使ってPodcastをホスティングする人（Podcastを運営している人）
- Show : Podcast番組そのもの。管理者はcastloopを使って複数のShowを管理できる
- Episode : 番組の1話。Showの中に複数のEpisodeが存在する。作成・公開・更新・非公開化・復元・削除に対応する
- 非公開化 (`unpublish`) : 公開配信を止め、データを保持する。`restore`で明示的に復元できる
- 削除 (`delete`) : 対象のpayloadを物理削除する不可逆な操作。IDと必要な小さい運用記録は保持する
- サービス停止 (`service-pause`) : 配信と新規変更を一時停止する。既存処理の終了とは別で、再開には同じpause IDを使う

## 作成するツール/サービス

- castloop (CLI) : castloopサービスを操作するCLI。typescriptで記述bunでシングル実行可能ファイルとして構築する
- castloop サービスバックエンド : Cloudflare WorkerでPodcast配信と公開処理（例えばfeed.xmlの更新）を行う

## 確定した構成とデータの正

- 1サービスにつき、1つのprivate R2 bucket、1つの公開・管理・consumer兼用Worker、1つのmain Queueと1つのDLQを用意する。Showは同じbucket内でshowIdを含むキーにより分離する。bucket名は管理者が指定する
- Worker／main Queue名は`castloop-<serviceId>-<ランダム8桁hex>`、DLQ名は`castloop-<serviceId>-dlq-<同じhex>`として初期化時に生成する。名前の一致だけで既存資源を採用しない
- 公開URLはworkers.devを標準とし、独自ドメインは任意とする。R2の公開URLは使わない
- `public_base_url`はRSSの正規URLの基点、`workers_dev_base_url`は同じWorkerの管理API接続先としてサービス設定で保持する。Showごとの`media_base_url`は設けない。既存M6設定で管理URLが未記録なら、元のworkers.dev公開URLを管理接続先に使う
- ローカルTOMLを編集元とし、R2には検証済みの公開スナップショットとジョブの状態を置く
- `update-show`はShow情報・カバー画像、`update-episode`と`update-episode-audio`はそれぞれEpisodeのメタデータと音源をR2の`staging/`へ置くだけで公開しない。`publish-show`または`publish-episode`だけが凍結した公開要求にcommit markerを配置し、R2 Event Notificationから同じmanaged Cloudflare Queueへ通知する。`queue-validation-v1`のHTTP `202 accepted`は受付完了であり、staging検証・公開成功ではない。Queue consumerが詳細検証してから公開し、`published / released`で完了する。確定的な公開前入力失敗は`failed / validation_failed`としてShow ownerと凍結draftを保持する
- main Queue consumerはbatch size 1・同時実行1・`max_retries: 2`。FIFOやexactly-onceは前提にしない。Show controlのR2 binding CASで、同じShowの登録・staging・publication・lifecycleを排他し、owner／generation／execution tokenを照合する。単なるconsumerの並列制限や時刻で公開順序を決めない
- 公開状態はR2のservice admission・Show control・Episode lifecycleで管理する。入力Show／Episode TOMLから公開状態を変更させない
- RSS 2.0とApple Podcasts互換を基準とし、strictなTOML schemaを使う。`published_at`は引用符付きRFC 3339文字列とし、RSS出力時にRFC 2822へ変換する
- MP3の解析・全量読み戻し検証はCLI、保存済みobjectのidentity・size照合と受付管理はWorker、公開音源のSHA-256付き保存はR2が担当する
- 人間可読なslugをIDとして使う。`serviceId`は最大20文字、`showId`は最大32文字、`episodeId`は最大80文字。基本形は`[a-z0-9]+(?:-[a-z0-9]+)*`とし、作成後は変更しない。Show IDは同一サービス内、Episode IDは同一Show内で一意とする

### Cloudflare認証とR2へのアップロード

- 管理者はDashboardでR2・Queuesを利用可能にし、Workers Scripts・Workers R2 Storage・Queuesの読み書き権限を持つaccount-scoped API tokenを取得する。CLIは`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を使い、資源作成・配備・R2 uploadをCloudflare REST APIへ直接送る。Wrangler、Node.js、Bun、`ffprobe`、別のR2 S3 credentialは管理者の実行環境には不要
- API tokenはTOMLやGitへ保存せず、配信Workerへも渡さない。Worker管理API用の別の管理鍵を`.castloop/`に保存し、Workerのsecret bindingと照合する。CLIの管理APIは常にworkers.devへ接続する
- MP3上限は**300,000,000 bytes**。CLIで送信前に上限・MP3・再生時間を検証し、単一REST PUT後に全量を読み戻してsize・SHA-256・ETag／versionを照合する。Workerは認証付きreceiptとR2 HEADを照合し、音源を全量再ハッシュしない。新しい公開音源はR2 bindingへSHA-256を渡してstream保存し、native checksumを確認する。[300 MBの実機受け入れ](archive/m6_standalone_acceptance.md)は合格済みだが、サービス全体のFree適合を証明するものではない
- R2 REST PUTの`If-Match`をR2 binding CASと同一視しない。切断後のPUTが遅れて書き込まないという[未検証の仮定U1](./m6_upload_recovery_options.md)はCloudflareの保証ではない。経過時間やHEAD不在だけでownerを解放しない。300 MBの受け入れはv0.4.0のHTTP CPUがFree上限に収まる証明ではない

## 利用シナリオ（概要）

### 初期化

新しいworkspaceと未使用の資源名で初期化する。対話端末では不足値を質問し、非対話実行では引数・環境変数で指定する。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain
cd /path/to/workspace
castloop service-status
castloop service-resume PAUSE_UUID
```

service ID・account ID・bucket名・workers.devのaccount subdomainから`castloop.toml`を保存し、bucket・Worker・Queue／DLQ・consumer・R2通知を作成する。既存の`.gitignore`に`.castloop/`と`*.mp3`を追記する。秘密と未公開job IDはサービスTOMLへ入れない。

配備したWorker version・cache設定・公開／管理API・Queue probeから稼働を検証し、**pausedで完了**する。設定値だけで完了にしない。再開には`service-status`の`admission.pause_id`を使う。開始済み・応答不明の`init`は再送せず、journalを保持する。[初期化設計](./m6_fresh_initialization.md)参照。

### Show作成

```sh
castloop create-show my-show --site-url https://your-real-site.example/podcast
```

- サービスrootで実行する。Show IDは管理者指定のslug、最大32文字。認証付きWorkerでShow controlに永久`reservation_id`を取得してから、一致する`system/show-reservations/<showId>.json`を作る。登録未完了中の変更を拒否し、進行済み／削除済みShowを作り直さない
- 予約記録は公開済みShow metadataの`system/shows/<showId>/show.toml`と分離する。予約だけではfeed等の公開パスにShowを出さない
- 登録receiptをローカルへ保存した後、`<showId>/show.toml`を作る。必須の`site_url`は管理者の実在サイトを引数または対話で受け取り、公開URLから推測しない。応答不明時は予約要求・lockを保持し、同コマンドで新しい登録を始めない

TOMLと素材は`<showId>/`に置く。Showの作成・staging・公開コマンドはサービスroot、Episodeの作成・staging・公開コマンドはShowディレクトリで実行する。

入力例は[show-template.toml](./show-template.toml)。CLIはテンプレートファイルを読み込むのではなく、schemaに従って初期値を生成する。

### Showの下書き更新と公開

```sh
# Edit my-show/show.toml and provide its cover image.
castloop update-show my-show
castloop publish-show my-show
castloop job-status SHOW_JOB_UUID
```

- `create-show`はIDを予約し、ローカルの`show.toml`を作成する。予約だけでは公開しない
- `update-show`はローカルのShow情報と`image_path`が指すカバー画像を検証し、同じ未公開jobIdの`staging/shows/<showId>/<jobId>/`にアップロードする。公開中のShow、feed、画像は変更しない。管理者がその後ローカルTOML・画像を変更した場合、古い下書きの公開は拒否して再度`update-show`を求める
- `publish-show`は下書きの入力を固定して最後に`commit.json`を置き、Queue経由で公開処理を起動する。初回公開も更新も同じ操作とし、このコマンドを実行するまでは外部に反映しない。Show情報の公開snapshot、固定キー`public/podcasts/<showId>/cover.<ext>`の画像上書き、feed更新、画像とfeedのcache tag purgeを行う。purgeに失敗した場合は公開完了とせず再試行する
- Showのstaging・publication・lifecycleは受付枠を共有する。未完了ownerがある間は次の変更を開始できない。JPEG／PNGを受け付けるが、公開済みShowの画像拡張子変更は非対応。内容の変更は同じ公開keyを上書きしてpurgeする

### Episode作成

```sh
cd my-show
castloop create-episode first
```

登録済みShowのディレクトリで実行する。slugを検証し、既存の同名ローカルファイルを上書きせず`episode-<episodeId>.toml`を作る。GUIDを生成し、`published_at`に実行時の秒・offset付きRFC 3339文字列を記入する。管理者は初回公開前に編集できる。

この操作はローカル下書き作成だけで、サーバー上のID予約・upload・公開はしない。サーバーのEpisode controlはstaging時に、Show ownerを照合して孤立データがないことを確認した上で初期化する。入力例は[episode-template.toml](./episode-template.toml)。

### Episodeの下書き更新と公開 (管理者側)

新規Episodeを公開する場合の流れは以下とする。

```sh
# Run from my-show after its publication has completed.
# Edit episode-first.toml and provide audio.mp3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first audio.mp3
cd ..
castloop job-status EPISODE_JOB_UUID
```

- `create-episode`はローカルのTOMLを作る。公開済みデータは変更しない
- `update-episode`はローカルの`episode-<episodeId>.toml`を検証し、R2の下書き領域へメタデータだけをアップロードする。公開済みデータやRSSは変更しない
- `update-episode-audio`はCLIでMP3の妥当性・再生時間・byte lengthを確認し、音源だけを下書き領域へアップロードする。音源の検証結果も下書きに紐付ける。公開済みデータやRSSは変更しない
- CLIは`.castloop/drafts/<serviceId>/episode-<showId>--<episodeId>.json`で未公開job IDを保持し、メタデータと音源を同じdraftへ紐付ける。各uploadの要求・receiptは別journalへ保存し、ローカルlockとサーバーのowner／generationを検証する
- `publish-episode`は入力を固定して`commit.json`を最後に配置し、job IDを返す。音源をstageした場合は変更のない元MP3の引数が必須。metadata-only更新では引数を省略し、公開済み音源を再利用する
- `publish-episode`前にローカルTOMLを変更した場合は、下書きのメタデータとの差異を検出し、`update-episode`の再実行を求める。誤って古いTOMLを公開しない
- 新規公開には下書きのメタデータと音源の両方が必要。既存Episodeの音源だけの更新では、ローカルTOMLが前回公開時と同じであることを確認したうえで公開済みメタデータを再利用できる。メタデータだけの更新では、前回公開済み音源を再利用し、新たなMP3オブジェクトを作らない。公開URLの基点が同じならenclosure URLも維持する
- commit配置後の下書きはimmutableとし、次の更新は新しいjob IDに行う。完了確認はサービスrootの`job-status JOB_UUID`を使い、`server_status.status.state = published`かつ`server_status.ownership = released`を待つ。受付receiptだけでは公開完了ではない

初回公開も再更新も、音源アップロードだけでは公開しない。音源だけの再更新も`publish-episode`を明示的に実行する。

### Episodeの更新(サーバー側)

R2 Event Notificationは`staging/` prefix・`commit.json` suffixのobject-createを同じmain Queueへ通知する。個別payloadのuploadでは起動しない。consumerはpath・凍結要求・現在のowner／generationを検証し、publicationとlifecycleを振り分ける。同じjobの再配送は既存progressから処理し、新しい公開jobへ置き換えない。

- CLIが求めたdurationとR2が保持する音源のbyte length等を確認し、公開用metadataに記録する。durationはRSSのitunes:duration、lengthはenclosureのlengthへ使う
- 新音源がある場合だけ、音源をrevisionIdを含む新しいオブジェクトキーで保存し、上書きしない。音源未変更なら既存の公開済み音源を参照する。EpisodeのGUIDは更新前後で維持する
- revision metadataを履歴として保存し、Episodeのcurrent metadataだけを更新する。古いrevisionはMVPでは保持する
- 公開音源の保存後も、service・Show・Episodeの公開状態に従ってWorkerが配信を許可する。`public/`内にobjectがあるだけでは公開しない
- RSSの再構築を行う。feed.xmlを全体作り直し、必要なキャッシュパージを行う
- request・status・progressをR2へ永続化し、cache purge成功まで公開完了にしない。一時的なconsumer失敗はQueueで有限回再試行し、尽きたメッセージはDLQへ送る。恒久的失敗はallowlistの理由を記録する。DLQ配送だけでR2 statusが更新されるわけではない。管理者の`retry-job`は同じ確認済みcommitと実行終了証拠を使い、active／unknown executionを拒否する
- staging音源の一般cleanupコマンドや自動期限は設けていない。通常更新では公開音源・revision履歴を保持し、明示lifecycle deleteだけがpayloadを削除する。D1や自作R2 queueは使わない

### RSSからの移行

`import-rss SHOW_ID RSS_URL --dry-run`でRSSを検査し、`--output DIRECTORY`で素材とTOMLをローカルへ取得する。内容確認後、サービスrootの`publish-rss-import DIRECTORY`で新規Showへ順番に公開する。外部GUID・公開日時を維持し、既存Showへの追加・定期同期・旧ホストの削除はしない。

各jobの待機は最大300回で、開始から5分後は新しい状態照会を始めない。進行中のHTTP要求には別timeoutがある。受付済みpending jobのcursorを保持し、同じコマンドの続行はそのjobの確認から行う。未知mutationを再送しない。[利用案内](../docs/rss_migration.md)参照。

未変更Episodeはprivateカタログを再利用する。初回構築は全件を読み、構築済みカタログの欠落・破損・世代不一致は自動再構築しない。GUID／音源／revisionを保持し、旧Workerへのdowngradeは行わない。

### 一覧・非公開化・復元・削除

- サービスrootで`list-shows`／`list-episodes SHOW_ID`を使う。1要求で最大20件のcontrolを走査し、続きは`--cursor`で取得する。削除済みIDは`--include-deleted`で表示する。ローカルだけのEpisode TOMLは一覧に含めない
- 非公開化／復元／削除は`preview-show-lifecycle`または`preview-episode-lifecycle`でJSONを保存し、対象・action・request hashを確認して`lifecycle-execute`へ渡す。deleteには`confirm-delete-retain-records`が必要
- Episode非公開化はfeedから対象を除き、全revision音源を404にする。Show非公開化はfeed・画像・全Episodeを404にし、子の個別状態は保持する。restoreはGUID・revision・音源を変えずに復元する。非公開中の内容を変更するには先にrestoreする
- deleteは全対象revision・音源・画像・metadata・下書きpayloadを物理削除し、削除中／削除済みの配信は410にする。IDは再利用不可。ローカル元ファイルと必要な小さい予約・tombstone・凍結要求・marker・status／progressは保持する
- lifecycleの完了確認は`operation-status lifecycle JOB_UUID`で`completed`／`released`を待つ。未完了uploadやpublicationを強制中断しない

### 通常更新と独自ドメイン

- `deploy`は初期化済みM6サービスのデータ形式を変えない更新。既存pause IDを保持し、service invocationsと全Show ownerの終了を確認して配備・稼働検証する。完了後もpausedで、明示resumeが必要。旧形式変換・自動rollback・無停止更新は行わない
- `domain add HOSTNAME`／`domain list`／`domain remove`で1つのhostnameを管理する。同じaccountのactive/full Zone、Workers Scripts Write・Zone Read・DNS Read権限が必要。既存DNS・他Worker接続を上書きしない
- add/removeはpause・処理終了確認後、active feedの再生成、cache purge、R2／ローカル設定同期と到達検証を行い、pausedで完了する。domain操作自体ではWorkerを再配備しない。通常deployは一致する接続を保持する
- 正規URLの切替でも音源・revision・GUID・公開日時・ShowのサイトURLは維持する。workers.devでも同じ内容をredirectなしで配信し、管理APIはworkers.devに固定する。Podcast directoryの登録URL変更は管理者が行う。[独自ドメイン利用案内](../docs/custom_domains.md)参照

### 状態照会と復旧の限界

`.castloop/`の管理鍵・凍結要求・receipt・lockとR2のownerを保持する。`local-operation-status`はローカルだけ、`operation-status`は認証付きサーバー状態も照会する。現在の対象は`target-show`／`target-episode`で確認する。読み取り時の競合は読み取りだけを再照会し、変更要求を再送しない。

`init-reconcile`／`update-service-reconcile`は、保持した要求に一致するpaused完了を照合する。`update-service-verify`は確認済み配備の検証を続行するだけで、結果不明の配備を再送しない。未知IO・残存lockの強制解放や万能な外部復旧は提供しない。詳細は[READMEの復旧制限](../README.md#errors-and-recovery-limits)。

### R2オブジェクトキー（採用済み）

```text
system/service.toml
system/lifecycle-service.json
system/show-publications/<showId>.json
system/show-reservations/<showId>.json
system/episode-lifecycle/<showId>/<episodeId>.toml
system/shows/<showId>/show.toml
system/jobs/<jobId>/request.toml
system/jobs/<jobId>/status.toml
system/jobs/<jobId>/progress.toml
system/jobs/<uploadOperationId>/upload.json
system/jobs/<uploadOperationId>/upload-progress.json
system/jobs/<jobId>/publication.json
system/service-updates/<operationId>/request.json
system/service-url-changes/<operationId>/progress.json

staging/shows/<showId>/<jobId>/show.toml
staging/shows/<showId>/<jobId>/cover.<ext>
staging/shows/<showId>/<jobId>/commit.json

staging/episodes/<showId>/<episodeId>/<jobId>/episode.toml
staging/episodes/<showId>/<episodeId>/<jobId>/audio.mp3
staging/episodes/<showId>/<episodeId>/<jobId>/commit.json

staging/lifecycle/shows/<showId>/<jobId>/commit.json
staging/lifecycle/episodes/<showId>/<episodeId>/<jobId>/commit.json

public/podcasts/<showId>/feed.xml
public/podcasts/<showId>/cover.<ext>
public/podcasts/<showId>/episode-catalog.json
public/podcasts/<showId>/episodes/<episodeId>/<revisionId>.mp3
public/episodes/<showId>/<episodeId>/metadata.toml
public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml
```

主なkeyを列挙しており、probe等の運用keyは省略する。公開URLは`/podcasts/<showId>/feed.xml`、`cover.<ext>`、`episodes/<episodeId>/<revisionId>.mp3`だけを対応するpublic keyへ写像する。`system/`・`staging/`・公開用metadata TOML・Episodeカタログは配信しない。

Episodeの未変更入力は`base_revision_id`へ固定する。uploadの全量読み戻し証拠は`upload-progress.json`、公開音源のSHA-256はR2 native checksumとcustom metadataへ保存する。publicationのmarkerは`publish-*`、lifecycleのmarkerは確認済み`lifecycle-execute`で最後に書く。

## サービス・ツールの構成

### Episode音源のファイルフォーマット

MP3を変換せずprivate R2へ保存し、Worker経由で配信する。CLIの`music-metadata`による解析と全量読み戻し、WorkerのHEAD照合、R2のSHA-256付き保存を使う。音源変換やWorker内の全量再ハッシュは行わない。

### ファイル配布とキャッシュ

同じWorker内のdefault gatewayはキャッシュせず、毎要求service・Show・Episodeの状態を検査する。許可された要求だけをWorkers Caching有効の`CachedPublicAssets`へ渡す。generationを内部cacheの識別に含め、hostの変更に依存しないcache URLを使う。

開発ブランチでは[配信判定の事前生成](public_delivery_projection.md)を採用した。管理側でstrict検証した正本と同じ条件付きPUTに小さいR2 metadataを保存し、通常HTTPでは最新metadataのHEADだけで判定する。既存controlの準備はpause/drain済みの互換更新へ含め、旧移行の全文検証は独立した互換経路として維持する。これはv0.4.0 releaseの変更や実機10ms達成の宣言ではない。

| 層 | キャッシュ方針 |
| --- | --- |
| 外向けの成功response | `Cache-Control: public, max-age=0, must-revalidate`。304でもgatewayを通し、`immutable`を付けない |
| 内部の音源response | `public, max-age=31536000` |
| 内部のfeed／画像response | `public, max-age=300` |
| 非公開・削除・停止・エラーresponse | `no-store`。非公開404、削除中／削除済み410、サービスpaused中503 |

内部cache tagは`show-<showId>`と、assetに応じて`feed-<showId>`・`cover-<showId>`・`episode-<showId>/<episodeId>`を使う。外向けにはcache tagとCDN専用cache headerを除去する。対象purgeが成功するまでjobを完了にしない。

GET／HEAD／単一Range、ETag条件付き304、範囲外416に対応する。cold RangeはR2 range読出し、cache HITではWorkers Cachingを利用する。cache時間のTOML設定による上書きは未提供。既にクライアントが保存した音源そのものを削除することはできない。

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
| `explicit`, `episode_type`, `season_number`, `episode_number` | 任意項目。`explicit`省略時はShow設定を継承。`episode_type`は`full`／`trailer`／`bonus`、番号は正整数 |

公開revisionはEpisode入力項目に`revision_id`・`enclosure_url`・`content_type`（`audio/mpeg`）・`length_bytes`・`duration_seconds`・`sha256`・`updated_at`を加える。`published_at`は入力から保持する。current metadataとimmutable revision履歴は別keyへ保存する。

`published_at`は秒と`Z`またはoffsetを含む引用符付きRFC 3339文字列とし、RSSの`pubDate`はRFC 2822。テンプレートの日付は例示で、CLIは実行時刻を生成する。初回公開後のGUID・`published_at`変更は拒否する。未来日付を指定しても予約配信にはならず、公開には明示`publish-episode`を使う。


## 開発履歴と公開済み機能

以下のM0〜M5は開発時の経緯。M5を経てv0.1.0〜v0.1.2を配布し、M6はv0.2.0、一覧はv0.2.1、独自ドメインはv0.3.0で公開した。過去ログの未提供・資源保持という記述は当時の状態であり、現在の仕様は本書前半と各Release notesを使う。

### M0: アーキテクチャ検証

Wranglerを使い、認証・資源作成・R2配信・Workers Caching・300 MB転送・MP3解析・R2通知→Queueとretry／DLQを検証した。当時の実行順・合格条件は[`m0_verification_plan.md`](archive/m0_verification_plan.md)を参照。

### M1: ローカルモデルと初期化

workspace・サービス設定・Show ID予約・ローカルTOML生成・strict schemaとslug検証を実装した。現在の新規初期化・予約処理はM6 runnerを使う。

### M2: 1 Episodeのend-to-end公開

個別stagingと明示publish、Queue処理・RSS・音源配信・cache purge・R2 status・retry／DLQを接続し、初回公開を検証した。

### M3: 複数Episode・更新運用

複数Episode、metadata-only／audio-only更新、GUID・immutable履歴保持、重複配送と同時更新を検証した。旧CLIの`cleanup-job`は当時の機能で、現在のM6 CLIには提供しない。実測は[`m3_implementation_log.md`](archive/m3_implementation_log.md)に記録する。

### M4: 配布と利用文書

CLIとWorker bundleを単一実行ファイルに同梱し、利用文書を整備した。M4ではWranglerと`ffprobe`に依存していた。M4.5でCLIの純JS MP3解析を採用し、`ffprobe`依存を除いた。実測と判断は[`m4_implementation_log.md`](archive/m4_implementation_log.md)と[`pre_mvp_mp3_analysis_proposal.md`](archive/pre_mvp_mp3_analysis_proposal.md)に残す。

### M5: Wrangler不要の管理CLI

Cloudflare REST APIによる資源管理・deploy・R2転送とBunによるWorker bundle生成へ移行した。M5.0のAPI実証、M5.1〜M5.3の移行、M5.4のLinuxバイナリ受け入れを経て、2026-09-25に[v0.1.0](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0)を公開した。

当時の受け入れ・例外回復の不足は[`m5_implementation_log.md`](archive/m5_implementation_log.md)と[`mvp_release_readiness_log.md`](archive/mvp_release_readiness_log.md)に記録する。現在のM6は初期化・更新journalと完了照合を持つが、未知IOや任意の残留ownerを強制解放するものではない。

### M6: Episode・Showの公開停止と削除

**承認済みMVP範囲を実装・検証し、v0.2.0で公開済み。** 新規初期化・互換更新、六lifecycle操作、状態を検査するgateway、原子的受付・所有者検証、cache purge、300 MB音源、正式Linuxバイナリを受け入れた。必要な運用記録は自動期限を付けず保持し、未知IOの万能な復旧や旧形式変換を公開条件にはしなかった。

[設計](./m6_content_lifecycle_plan.md)・[実装ログ](archive/m6_implementation_log.md)・[実機受け入れ](archive/m6_standalone_acceptance.md)・[v0.2.0 Release notes](../docs/release-v0.2.0.md)を参照。

### 一覧・独自ドメイン

v0.2.1でShow／Episodeの読み取り専用一覧、v0.3.0で独自ドメインの追加・照会・削除と管理URL分離を公開した。機能利用には対応CLIとWorkerの両方が必要で、バイナリの交換だけではWorkerは更新されない。

[一覧の検討](./podcast_management_features_draft.md)・[ドメイン計画](./custom_domain_plan.md)・[v0.2.1](../docs/release-v0.2.1.md)・[v0.3.0](../docs/release-v0.3.0.md)の公開範囲と[run4の実機受け入れ](https://github.com/simosako/castloop-v2/blob/7e57cac5b22435c54d68d0a6edc9a28e2285ff71/design/acceptance/custom-domains/20261011-run4/run4/result.md)を参照。

### 未提供・今後の検討事項

M7として[外部RSSからの移行](./m7_rss_import_plan.md)を開発中。新規Showへローカル取り込み・管理者確認・明示公開の2段階で移し、元GUIDと公開日時を維持する。公開済みv0.3.0には含まれない。[開発版利用案内](../docs/rss_migration.md)参照。

- 予約配信、アクセス統計、音源変換、公開済み旧revisionの選択的削除
- 複数domain・Show別domain、購読先の自動移行・redirect
- 必要になった場合だけの旧形式変換、無停止更新、費用・停止時間測定
- stagingの一般cleanup、任意の未知IO／残留lockからの万能な復旧

これらは現在のMVPの完成条件ではなく、追加開発には別途範囲を決める。

## 開発環境

- TypeScript、Bun 1.4.2、Node.js 24／npm。Cloudflare側のruntimeはWorkers
- `npm ci`、`npm run check`、`bun test`、`npm run build:cli -- linux-x64`で検証・配布物を生成する。正式Worker入口は`src/worker.ts`で、単一バイナリへ同梱する
- `.mise.toml`でツール、`package.json`／`package-lock.json`で依存を管理する。Wrangler設定は過去・試験用に残るが、正式ビルド・管理CLIは呼び出さない
- Linux x86-64の配布物にchecksum・MIT License・第三者ライセンス通知を同梱する。macOS／Windowsのcross-buildは実機未検証で配布対象外

## format/schema

TOMLは`@iarna/toml`でparse／serializeし、Zodのstrict schemaで検証する。keyはsnake_case。実装上の定義は[`packages/shared/src/index.ts`](../packages/shared/src/index.ts)と同ディレクトリのlifecycle・service admission等のschemaに置く。

- 入力例: [Show](./show-template.toml)／[Episode](./episode-template.toml)
- lifecycle・制御record: [M6設計](./m6_content_lifecycle_plan.md)
- 新規初期化／互換更新: [初期化設計](./m6_fresh_initialization.md)／[更新設計](./m6_compatible_updates.md)
