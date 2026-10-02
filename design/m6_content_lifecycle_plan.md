# M6: Episode・Showの公開停止と削除

作成日: 2026-09-30

状態: R2制御record方式を決定（2026-09-30）、基礎実装に着手。公開停止・削除・再開のCLIと配信ゲートの接続は未実装。

基準版: [v0.1.2](https://github.com/simosako/castloop-v2/releases/tag/v0.1.2)。この版には公開停止・削除・再開のコマンドはない。

### 決定事項と現在の実装範囲

管理者のレビューにより、方式Bの**R2制御recordを公開状態の正とする方式**を決定し、実装開始の指示を受けた。入力Show/Episode TOMLへ公開・削除フラグは追加しない。方式Aとの比較は採否の記録として保持する。

最初の実装ではstrictな状態/request schema、同じShow keyでのCAS受付、凍結request、processing開始時のowner照合、R2を毎回読む公開可否判定を追加した。2026-09-30に専用環境でcache/REST deploy・内部purge・generation key・GET/HEAD/Range構成を実証した。旧recordの移行や既存CLI/consumer/公開入口への接続はまだ行わず、破壊的操作を先行公開しない。Free制限・upload収束・削除/復旧等のゲートは引き続き未通過であり、構成実証をM6全体の合格と扱わない。具体的な進捗は[実装ログ](./m6_implementation_log.md)へ記録する。

2026-10-01の管理者判断で、M6のuploadは**現行Cloudflare REST APIの単一PUTを維持**する。クライアント切断後にそのPUTが遅れてobjectを作成・更新することはないと仮定する。これは確認済みのCloudflare仕様ではなく、[未解決の懸念U1](./m6_upload_recovery_options.md)として保持する。U1の解消や分割uploadへの変更をM6公開条件にせず、通常のupload排他・照合・中断回復の実装は引き続き必要とする。

2026-10-02の管理者判断で、同一Cloudflareアカウント内の専用試験環境と、公開配信・更新操作の一時停止を許容するメンテナンス移行を採用した。**M6機能一式を完成させて次バージョンとして正式リリース**し、限定先行リリースや無停止移行を必須にしない。無停止移行の検討、費用・停止時間の測定計画はMVP構築後へ回す。機能・安全性の受け入れ条件は維持し、測定値の承認待ちで通常の実装を止めない。詳細は[承認済み方針と残る技術ゲート](./m6_review_queue.md)を参照。

## 1. 目的と開発順序

管理者がEpisode単位、Show単位で配信を停止し、不要なコンテンツを安全に削除できるようにする。次の機能開発を**M6**とし、着手済みの[独自ドメイン対応](./custom_domain_plan.md)は基礎コードと承認済み方針を保持して後続へ回す。独自ドメインの完成をM6の前提にはしない。

- 1サービス / 1 Worker / 1 private R2 bucket / 既存QueueとDLQを維持する。サービスの削除やWorker、bucket、Queue、DNSの撤去は対象外。
- 管理端末はLinux x86-64の単一実行ファイルで操作する。Node.js/npm、Bun、Wrangler、ffprobe、R2 S3 credentialsは要求しない。
- R2状態・ジョブ・進捗を正とし、CLIの終了や別端末への切替でも操作を再開できるようにする。
- 公開停止と不可逆な削除を混同しない。公開停止だけでストレージ使用量が減るとは説明しない。

## 2. 現状の制約

- `src/publication.ts`の`publishedEpisodes`はcurrent metadataを列挙する。停止状態がなく、metadataを残すだけでは次のfeed再生成でEpisodeが復活する。
- `src/index.ts`の`publicAsset`は許可されたpathにR2 objectがあれば配信する。feedからEpisodeを消すだけでは、既知のMP3 URLで再生できる。
- MP3はクライアント・Workers Cache向けに最大1年のimmutable応答で、MP3のpurge tagはない。feedとカバーだけにtagがある。
- Workers CacheはWorker実行前にHITを返す。現行の入口に停止フラグ確認を足すだけでは不十分。
- Showごとの`system/show-publications/<showId>.json`への条件付きPUTで公開受付を排他する。削除を別keyのフラグ確認だけで実装すると、受付やconsumerとのTOCTOU競合が残る。
- CLIのstaging uploadはCloudflare REST APIへ直接PUTする。削除時の列挙・削除とuploadが並行すると、削除後に下書きが残り得る。
- Queueは重複・順不同を前提にする。古いcommit再配送や別端末の古い下書きで停止・削除を取り消してはならない。

## 3. 用語と推奨仕様

### 公開停止（unpublish）

配信を止めるが、R2のmetadata、全revision音源・履歴、下書きを保持する可逆操作とする。明示的な公開再開以外では復帰しない。

| 操作 | feed | カバー | MP3 | 保存済みデータ |
| --- | --- | --- | --- | --- |
| Episode公開停止 | 対象itemを除外。他のEpisodeは継続 | 変更なし | 対象Episodeの**全revision**を停止 | 保持 |
| Show公開停止 | Showのfeed配信を停止 | Showの画像配信を停止 | Show内の**全Episode・全revision**を停止 | 保持 |

Show停止は親の配信ゲートとして働き、子Episodeの状態を一括上書きしない。Showを再開しても、個別に停止したEpisodeや削除したEpisodeを復活させない。

### 削除（delete）

配信を止めた上で、対象のR2コンテンツを物理削除する不可逆操作とする。公開済みだけでなく、未公開の下書きも対象にする。

- Episode: current metadata、全revision metadata、全revision MP3、全staging metadata/audioを削除し、親Showのfeedから除外する。
- Show: Show metadata、feed、カバー、全Episodeのcurrent/revision metadata・MP3、Show/Episodeの全staging payloadを削除する。
- ID、操作ID、状態、時刻などの最小限のtombstone・復旧記録は保持する。**bucket内の全記録消去や法的な完全消去を保証する機能ではない。** コンテンツ本文や音源は監査記録へコピーしない。
- 削除したShow ID、Episode IDは再利用しない。古いURLやQueue messageで別コンテンツが現れる事故を避ける。
- 通常更新でのimmutable音源・履歴保持は継続する。明示的に確認されたdeleteだけをその例外にする。
- ローカルのTOML、カバー、元MP3は自動削除しない。削除後はCLIにremote状態を記録し、誤った再送を拒否する。

### 公開再開（restore）

公開停止した保存済みsnapshotを明示的に再公開する。ローカルの未公開編集は取り込まない。GUID、元の`published_at`、音源path、revisionは変えず、現在の`public_base_url`でfeedを再生成する。削除中・削除済みは再開不可。

## 4. CLI案

以下は**将来のコマンド案**であり、v0.1.2では実行できない。

```text
# Showディレクトリから
castloop unpublish-episode <episodeId> [--yes]
castloop restore-episode <episodeId> [--yes]
castloop delete-episode <episodeId> [--confirm <showId>/<episodeId>] [--dry-run]

# サービスworkspaceから
castloop unpublish-show <showId> [--yes]
castloop restore-show <showId> [--yes]
castloop delete-show <showId> [--confirm <showId>] [--dry-run]

castloop job-status <jobId> --show <showId> [--episode <episodeId>]
castloop retry-job <jobId> --show <showId> [--episode <episodeId>]
```

- unpublish/restoreは対話時に対象・影響を示して確認する。非対話時は`--yes`を要求する。
- deleteは対話時に対象IDの入力を求める。非対話時は一致する`--confirm`が必要。汎用`--yes`だけで全音源削除を許可しない。Show削除では配下Episodeも消えることを明示する。
- `--dry-run`は読み取り専用。対象prefix、Episode数、概算object数/bytes、現在の状態、競合jobを表示し、受付・commit・削除を行わない。確認から実行までに状態が変われば再確認を求める。
- 未完了操作を同じコマンドで再実行した場合は同じjobを照会・再開する。別端末でもremoteのaction・対象・要求hashから一致を確認する。同じ対象の別actionは409相当の競合にする。
- すでに希望状態へ収束済みならno-opを成功として報告する。存在しないIDと削除済みIDは管理APIで区別する。削除済みへのrestore/publishは拒否する。
- コマンド成功はまず「job受付・commit作成」を意味する。**削除完了・停止完了とは表示しない。** job IDを返し、`job-status`で完了とowner解放を確認する。
- 純ローカルの未公開Episodeもdeleteの対象にできるようにする。remote未登録ならShowの受付枠内でIDを登録してtombstoneを作る案とする。ローカルファイルは保持する。このIDの使い捨て規則は承認事項。
- ローカルファイルがなくてもremoteの対象を操作できるよう、lifecycle処理では`show.toml`やEpisode TOMLの存在を必須にしない。workspaceの設定・管理鍵は必要。

`cleanup-job`は従来どおり成功済み公開jobの一時音源だけを扱い、unpublish/deleteの別名にはしない。

## 5. 状態・保存形式

入力Show/Episode TOMLへ`deleted = true`などを足す方式は採用しない。公開状態は管理APIだけが変更するサーバー側の制御情報とする。

### 入力TOMLのフラグ方式との比較

比較するのは**TOMLかJSONかという保存形式ではなく、「編集用metadataに公開意図を含めるか」「公開状態を独立した制御recordで確定するか」**である。今回のR2 key案でもEpisode状態・job情報にはTOMLを使う。Show/Episodeのタイトルや説明などは、従来どおりローカルTOMLを編集元とする。

#### 方式A: 入力TOMLに`publish = false`などを設定

ローカルの`show.toml`や`episode-<episodeId>.toml`に希望する公開状態を記入し、CLIから送ってサーバーに反映する宣言的な方式。**ローカルで編集しただけではR2や公開配信は変わらない。** 反映の契機は別途定める必要がある。

- `update-*`で反映すると、現在の「updateはstagingだけ、公開状態の変更は明示操作」という契約を変える。metadataを下書き保存したつもりで配信が止まる危険がある。
- `publish-*`などの明示操作で反映するならこの契約を保ちやすいが、「publishを実行すると停止する」という名前との不一致が生じる。専用のapply等を設ける場合はその意味も設計する必要がある。
- 希望状態と反映済み状態は一致しない場合がある。停止ジョブの失敗・処理中を、ローカルの`publish = false`だけで完了扱いにはできない。

#### 方式B: 独立したR2制御recordで確定（今回の案）

入力TOMLには公開フラグを置かず、明示的なunpublish/restore/delete要求を管理APIで受け付け、generation・owner・jobの進捗と一緒にサーバー側で状態を確定する。ローカル編集内容の公開と、保存済みコンテンツの配信停止を独立させる。

| 観点 | 方式A: 入力TOMLのフラグ | 方式B: 独立したR2制御record |
| --- | --- | --- |
| 操作の分かりやすさ | metadataと公開意図が1ファイルで分かる。テキスト編集で希望状態を指定できる。ただし「いつ反映されるか」の理解が必要 | 操作名で停止・再開・削除を区別できる。実際の状態はCLI/APIで照会する必要があり、TOMLだけでは分からない |
| Git・レビュー・一括管理 | 公開意図のdiffをmetadataと一緒にレビューでき、宣言的な一括管理に向く | 公開状態の変更は通常のTOML diffに出ない。操作履歴と状態照会が必要。一括操作は別途作る必要がある |
| metadata更新との分離 | 通常のmetadata再送に公開意図も乗る。フラグを含む全snapshotの置換では、意図しない停止・再開への対策が必要 | metadata更新は公開状態を変更しないため、停止だけを行うときに未公開編集を取り込まずに済む |
| 複数端末・古い下書き | 端末Aで停止後、端末Bの古い`publish = true`を送ると復帰要求になり得る。世代照合や明示的再開の判定が必要 | 古いmetadataには状態変更の権限を持たせない。restore要求の世代照合に集約できる。ただし専用recordでも照合なしなら競合する |
| 原子性・排他 | フラグをmetadata keyへ置くだけでは受付keyとの原子性は得られない。共通の受付・世代・状態機械が別途必要 | Show状態と受付を同一keyのCASで更新できる。Episode状態はShowのowner内で更新する。複数key全体がtransactionになるわけではない |
| 状態の表現 | booleanは希望する公開/非公開の2値に向くが、draft・停止・削除中・削除済みや処理進捗は表せない。enumやjob情報を増やすと編集metadataと運用情報が混ざる | lifecycle状態、generation、操作種別、job進捗を独立して表せる。ただしkey・schema・照合処理が増える |
| 削除後の記録 | metadataを物理削除すると同じファイルのフラグも消える。ID再利用防止や旧commit拒否には別のtombstoneが必要 | コンテンツを消しても制御recordを保持できる。物理削除と最小限の拒否・復旧記録を分離しやすい |
| 再開・バックアップ | ファイルで希望状態を持ち運びやすいが、古いバックアップの再送を現在の公開状態への変更として扱うか決める必要がある | サーバーの実状態を維持してローカルmetadataを復元できる。ただしコンテンツだけでなく制御record・jobも復旧設計に含める必要がある |
| キャッシュと直リンク | フラグがあってもfeed除外だけではMP3は止まらない。配信ゲート・全revision遮断・purgeが必要 | 同じ対策が必要。R2 keyを分けただけでキャッシュ問題が解決するわけではない |
| 実装・運用コスト | 希望状態の入力追加は小さい。安全な停止・削除・回復まで含めると受付・job・tombstone等は省略できない | metadataと制御recordの整合、移行、状態照会、毎要求の状態readが増える。その分、運用上の責務を明確に分けられる |

#### M6で方式Bを選ぶ理由と補完策

castloopは既に「編集/staging」と「明示的publication」を分け、複数端末・古い下書き・Queueの再配送を扱う。今回必要なのは公開意図の2値だけでなく、**物理削除の途中状態、不可逆操作の確認、削除後も残る拒否記録**である。そのため、metadataから独立した制御recordを正とする方式Bを選ぶ。

方式Aが安全に実装できないという意味ではない。フラグを「実状態」ではなく「希望状態」とし、共通の受付・世代照合・job・tombstoneを備えれば成立する。ただし、その場合も今回案に相当するサーバー制御が必要になる。

方式Bの弱点は、ローカルTOMLだけで実状態を把握できず、公開意図をGitでレビューする流れにも直接乗らないことである。M6では管理API/CLIの状態照会・dry-run・job履歴で補う。照会結果をローカルに保存する場合も、読み取り専用snapshotとして区別し、編集・再送で制御recordを上書きさせない。

将来、一括管理やGitベースの運用が必要になれば、**宣言的な希望状態を入力し、diffを確認して同じ管理APIへ明示的にapplyする併用方式**を検討できる。通常のmetadata uploadで暗黙に適用せず、deleteの対象ID確認も省略しない。これはM6には追加せず、希望状態と実状態の二重管理が必要になった段階で別途設計する。

### 状態案

| 状態 | 意味 | 許可する操作 |
| --- | --- | --- |
| `draft` | 未公開 | staging、初回publish、delete |
| `active` | 公開可能 | 更新、unpublish、delete |
| `unpublished` | 保存済みだが配信停止 | restore、delete。通常publishによる暗黙復帰は禁止 |
| `deleting` | 配信停止済み・物理削除を実行/再試行中 | 同じdeleteの再開のみ |
| `deleted` | 削除完了、tombstoneのみ | 照会のみ |

Showがactiveで、かつEpisodeがactiveの場合だけ、その音源を公開可能とする。Show停止中の子操作はunpublish/deleteと状態照会を許可し、restore/publishとstaging uploadは拒否する。Show停止中のEpisode停止・削除ではfeedを書かず、Show再開時に残ったactive Episodeだけで再生成する。

### R2 key案

```text
system/show-publications/<showId>.json             # 既存keyをversion付き制御recordへ拡張
system/lifecycle-service.json                      # サービス書込registry・pause・移行owner・readiness
system/lifecycle-migrations/<migrationId>/request.json # 凍結したpause ID・期待service generation
system/episode-lifecycle/<showId>/<episodeId>.toml  # 状態・generation・最終操作ID
system/jobs/<jobId>/request.toml                   # 凍結したaction・対象・期待generation
system/jobs/<draftJobId>/publication.json           # 凍結publication commitとstaging検証操作ID
system/jobs/<uploadOperationId>/upload.json         # 凍結staging対象・draft ID・asset size/hash
system/jobs/<uploadOperationId>/upload-progress.json # client終了確認・検証証拠・完了/取消
system/jobs/<jobId>/status.toml                    # 既存statusを拡張
system/jobs/<jobId>/progress.toml                  # phase・削除進捗・purge結果

staging/lifecycle/shows/<showId>/<jobId>/commit.json
staging/lifecycle/episodes/<showId>/<episodeId>/<jobId>/commit.json
```

- Show制御recordは公開状態、単調増加generation、feed generation、受付owner、操作種別、要求hashを持つ。**公開状態と受付を同じkeyのETag CASで変更**する。新しいShow状態keyを読むだけの受付は不可。
- 新規M6 Showはcontrolの任意`reservation_id`を使ってShow IDを条件付き新規作成で取得し、同IDの予約recordを補完する。途中の登録は共通受付/owner検査で拒否し、advanced/既存/削除済みcontrolを再初期化しない。永久IDは削除後も保持する。旧controlに暗黙追加しない。`m6_show_registration.md`参照。
- Episode状態は同じShowの受付ownerを取得した処理だけが変更する。Showの受付枠を保持している間は他のEpisode/Show変更を許さない。
- 新規Episodeは最初のmetadata/audio stagingで、期待generation=0・既存payload/history/staging不在を確認し、公開中Showのstaging owner取得後にdraft制御を条件付き新規作成する。既存/tombstoneを上書きせず、ready progressやPUT許可より先に初期化する。local `create-episode`はTOMLだけを作る仕様を維持する。`m6_new_episode_staging.md`参照。
- 既存の`reserved`/`processing`/`free`の意味を維持し、staging upload用の排他状態も定義する。`free`になっても公開停止状態やgenerationを捨てない。
- requestに`action`（publish/unpublish/restore/delete）、`kind`（show/episode）、IDs、期待generation、作成時刻を固定する。statusはv2でactionとphaseを扱い、旧v1の公開statusも読めるstrictなversion別Zod schemaにする。
- 既存公開の終端`published`を維持する。lifecycleの終端には`completed`を設け、対象状態と処理結果も表示する。`published`/`completed`かつowner `free`が完了条件。
- JSON制御recordもruntime検証する。新しいTOMLは`@iarna/toml`とstrict Zodで読み、共通stringifyを拡張する。具体的フィールドはM6.0で確定する。

基礎実装のフィールドは`packages/shared/src/lifecycle.ts`に定義する。Show recordはv2、Episode recordとrequestはv1とし、ownerがない状態をfreeとして表す。受付成功時にShow generationを1つ進め、そのgenerationをownerの処理開始tokenとする。requestの`expected_show_generation`は受付前の値、`expected_episode_generation`は対象Episodeの値である。consumer開始時は凍結requestのhash・対象・owner・受付後generationの一致を確認する。旧v1 admissionを暗黙にこの形式へ変換しない。job status v2・progressのstrict schemaと完了解放基礎関数を追加したが、consumerでの進捗更新・移行・既存経路への接続は後続実装とする。

`finishShowOperation`は実行tokenの保持者だけが呼べる。durable terminal status/progressの対象・action・generation・要求hash、purge成功、結果状態（Episodeでは最終job IDも）を照合し、Show owner解放と完了receiptを同じCASで保存する。完了receiptを使った再送は新しいownerを変更しない。`completed`だけを見て新ownerを解放する実装にはしない。staging ownerの終了・中断解放は別の後続処理であり、このconsumer用関数では解放しない。

独立moduleの削除stepは開始時のdeleting/feed/purgeからpayload削除・先頭からのverification・最終purge・deleted確定・完了解放まで実装した（2026-10-01）。Show削除では子制御recordも小さなdeleted tombstoneにするが、既存deletedは保持し、子generationは進めない。親Showの受付generationと永久deleted状態で旧jobとID再利用を拒否する。progressの`final_purge_confirmed`と、Showの`tombstone_cursor`/`tombstoned_episodes`/`tombstones_complete`は必要な小さい進捗証拠として保持する。削除/tombstone件数は診断値であり完了証拠にはしない。本番Queue/配信gate/CLIへはまだ接続していない。

## 6. 原子的受付と既存処理との排他

### 受付・commitの順序

1. CLIは新しいjob IDと要求をローカルへ保存してから、認証付きWorkerに送る。対象のremote状態・期待generationと確認内容を照合する。
2. Workerは凍結requestを同一job IDで冪等に保存する。別内容の再送は拒否する。この時点では公開停止・削除を行わない。
3. Show制御recordへETag付きCASを行い、ownerがfreeで対象状態が許す場合だけreservedを取得する。公開job、他lifecycle、staging uploadが先に取得していたら409で止める。
4. requestとownerを確認して`commit.json`を最後に作成する。既存の`staging/` prefix / `commit.json` suffix通知から同じQueueへ送る。管理APIがmarkerを作り、CLIから任意の対象prefixを渡させない。
5. 応答喪失時は同じjobを照会し、reservedのままmarker未作成なら同じ要求で補う。marker作成済みなら内容一致を確認して受付済みと返す。Queue通知喪失時は凍結markerを使う明示的requeue経路で回復する。
6. consumerはpath・schema・action・owner・generationを検証し、同じ制御keyのCASでprocessingへ移る。古いjobや解放済みownerの配送は公開データを一切変更しない。

### 必須の安全規則

- 既存`publish-show`/`publish-episode`のclaim、consumerの開始・終了も新recordを理解するよう一緒に改修する。対象が停止/削除状態なら、古い下書きのcommitでも通常公開を拒否する。
- 公開jobがreserved/processing/retryingの間は停止・削除を受け付けない。単一並列consumerだけに安全性を依存させない。**processingを強制解放せず、経過時間だけでownerを取り上げない。** 緊急停止が公開jobを割り込む機能は今回対象外。
- 現行CLIのREST直PUTは公開停止とは独立してstorageへ書ける。物理削除との競合を防ぐため、M6対応CLIの`update-*`はupload前に同じShow制御keyで短期のstaging受付を取得し、PUTと照合終了後に解放する。upload操作IDと継続するdraft job IDは分ける。
- upload中断後の再照会・解放は、**クライアント切断後に旧PUTが遅れてobjectを作成・更新しない**という承認済みのM6仮定の下で設計する。通信中断と、まだ継続中のPUT/Worker処理を区別し、owner/generationを照合して終了・再試行・解放する。通信が生きたままのPUTやpublication processingをタイムアウト/HEAD不在だけで強制解放しない。通常の回復・排他テストは行うが、この仮定自体の実機証明をM6.0公開ゲートにしない。
- 2026-09-30の専用実測では、R2 REST object PUTは不一致`If-Match`でも200で上書きした。R2 bindingのCAS保証をこのREST経路へ流用せず、条件付きPUT fenceは使わない。この実測はabort後の保存継続を示すものではなく、単独で分割uploadが必要とする根拠にはしない。
- [単一PUTの維持と未解決懸念U1](./m6_upload_recovery_options.md)に、公開資料では確認できなかった切断後commitのリスク、仮定が誤っていた場合の影響、再検討条件を記録する。M6ではWorker経由の分割upload sessionを採用しない。サポート問い合わせも行わない。
- M6移行時は旧CLIによる書き込みを止める。Cloudflare tokenを持つ旧CLIや手動REST PUTをWorkerだけで禁止できるとは説明しない。保証範囲はM6対応の管理経路と、移行後に収束済みの旧uploadに限る。
- 恒久failed/reservedの旧公開jobで停止・削除も塞がるケースを扱う必要がある。M6.0で限定的な安全abandon手順を設計する。reservedを同じCASで失効させ、旧commitの再配送・再claimを耐久的に拒否できることを条件とする。processing、書き込みが始まったjob、状態不明jobは対象外。安全性が確認できるまではブロックを保持し、手動でrecordを消さない。
- 新v2制御record用の限定abandon基礎関数を実装・実測した。凍結requestを照合し、reservedだけをCASで失効、generationを進め、同じrecordへ直近の取消receiptを残す。応答喪失の再実行はreceiptで確認できる。immutable requestと旧generationはその後も保持し、後続操作がreceiptを置換しても旧jobの再claim/beginを許さない。新consumerが**processing CAS成功前に書かない**ことが前提。旧v1 jobの取消・CLI/API公開・status/progressへの接続は別のゲートであり、旧recordをこの関数で取消しない。
- 後続の独自ドメイン移行も同じ制御recordを使う。M6はShow単位の排他であり、全Showのサービス移行を原子的に止める方式まで解決したとは扱わない。

consumer invocationごとの排他基礎関数を追加した。`acquireShowExecution`はreserved/processing ownerへランダムな`execution_id`を同じShow keyのCASで設定し、同jobの重複配送も1 invocationだけが書けるようにする。`beginShowOperation`単独の冪等なprocessing確認は実行排他の代用にしない。すべての副作用をawaitして書込終了したinvocationだけが`releaseShowExecution`を呼び、job ownerはprocessingのまま保持する。tokenを時間で失効させず、取得応答喪失・runtime強制終了ではブロックを維持する。強制終了後の実行終了確認・安全なtoken回復は未実装であり、本番consumer接続前の残ゲートである。

`consumeLifecycleCommit`は凍結requestとstrict markerを照合し、停止/再開/削除runnerの通常終了・例外終了をawaitしてから実行tokenを返却する（2026-10-01）。削除続行はtoken返却後に同じmarkerのQueue送信をawaitする。送信失敗/応答喪失でもjob owner/progressを保持し、重複配送と`requeueLifecycleOperation`で同jobへ収束できる。取得応答喪失と強制終了のtokenは保持したままであり、この通常終了経路を強制終了回復の証明にはしない。基礎consumerは本番Queueに未接続。

2026-10-01に`publication-admission.ts`を追加した。publish control requestと既存strict commitを`publication.json`へ凍結し、draft job IDをpublication job IDとして共通Show CASを取得する。marker作成前に、参照するstage操作のfinished progress/completed statusとasset hash/size/現行ETag、再利用するbase revision/history/audioを照合する。marker形式は既存v1を維持するが、新経路では凍結manifest/control requestとの一致が必須である。本文/secretは追加記録へ複製しない。これは受付/commit準備の基礎実装であり、既存CLI/管理API/本番publication consumerには未接続。新consumerは同generation/ownerの実行tokenを取得し、入力を再確認してから書き、未知の旧markerを暗黙に承認しない。

同日に`publication-show-runner.ts`/`publication-episode-runner.ts`と共通`publication-consumer.ts`を追加した。Show/Episodeの保存→lifecycle対応feed→generation→cache所有entrypoint内purge→active→published/receiptまで、同じ実行token内でawaitする。新しい音源はimmutable keyへstream保存し、全量checksumを検証する。改訂では既存媒体/履歴を上書きせず、GUID/公開日時を保つ。初回対象はpurge成功後に配信を開ける。再開時の自身のcurrent revisionや自身のactive化は、同じ候補/履歴、または同job/次generationとdurable purge進捗を照合した例外だけを認め、一般のpublish受付を緩めない。本番Queue/API/CLIには未接続で、配信gateの本番確認・移行・実機受け入れを省略しない。

## 7. 配信ゲートとキャッシュ（最重要の検証ゲート）

### 推奨構成

同じWorker内で、**default入口のWorkers Cacheを無効化**し、キャッシュ有効なnamed entrypoint（例: `CachedPublicAssets`）へ公開可能な要求だけを渡す。別Worker・別bucketは増やさない。

```text
公開HTTP要求
  -> default入口（キャッシュ無効）
  -> 許可path・Show状態・必要ならEpisode状態をR2 bindingで確認
  -> 停止/削除/読取失敗ならここで拒否
  -> named entrypointのWorkers Cache（公開可能なコンテンツだけ）
  -> R2のfeed/cover/MP3
```

- 状態は毎要求で読む。isolate内メモリやKVのeventual cacheに停止判定を置かない。状態破損・読取失敗は503/no-storeでfail closedし、既存cached bodyへフォールバックしない。
- 未知/未公開・公開停止は404、削除中/削除済みは410を推奨する。停止応答はGET/HEAD/Range/条件付き要求で一貫させ、HEADはbodyなし。404/410/503は`Cache-Control: no-store`を明示する。
- Episode停止は全revisionのMP3に適用し、Show停止はfeed/cover/全MP3に適用する。管理API、health、system/staging隔離は維持する。別hostやquery、If-None-Match、Rangeで停止を回避させない。
- named entrypointを外部公開routeから直接呼べるようにしない。propsは入口が生成し、公開許可generation・検証済みpath以外で内部呼出を受け付けない。default入口から単にURLで内部pathへ転送する方式は採らない。
- feed/coverのcache keyには現行generationをpropsとして含める。停止・再開・通常公開でgenerationを進め、古いin-flight responseがpurge後に旧cacheを再充填しても新しい要求で使わない。MP3も停止・再開generationを区別する。
- 内部応答に`show-<showId>`、音源には`episode-<showId>/<episodeId>`も付ける。Episode tagはslug間を`/`で区切り、`a-b` Showの`c` Episodeと`a` Showの`b-c` Episodeの衝突を防ぐ。既存feed/cover tagは維持する。purgeは**cache所有entrypoint内**のRPCメソッドから実行する。defaultやQueue handlerでのpurgeだけでは内部cacheを消せない。
- 旧MP3にはtagがないので移行時の旧default cache purgeと、対象path prefixのpurgeも検証する。prefixには末尾`/`を含め、`a`削除で`a-b`を消さない。tag/path purgeの`success`とerrorsを記録する。
- cached full responseからのRange/206、HEAD、416を内部entrypointで維持できるか実機で検証する。gateway化してRangeが失われる場合は、正しいRangeを提供する代案を設計してから進む。

### 利用者側cacheと保証範囲

M6では入口から返すfeed/cover/MP3のクライアント向けheaderを`max-age=0, must-revalidate`を基本とする案に変更し、内部Workers CacheのTTLと分離する。既存のMP3向け`immutable`は外部応答から外す。conditional応答も公開状態確認の後で処理する。

ただし、**既にダウンロードされた音源、v0.1.2以前のheaderで保存された端末cache、外部Podcast directory・proxyのコピーは回収できない。** 停止後のcastloopへの新しい要求を拒否する機能であり、世界中のコピーを消す機能ではない。停止前に判定・開始済みのHTTP転送の強制切断も保証しない。directoryの番組掲載停止は管理者が別途行う。

### REST deployの実証

2026-09-30に[専用実証コード](../experiments/m6/README.md)で、REST multipart module uploadの`cache_options`と`exports`、installed types・Bun bundle、内部loopback・RPC purge・generation props・GET/HEAD/Rangeを確認した。default cache無効/内部cache有効の構成はStandard環境で成立した。外側からのpurgeでは内部cacheを消せず、内部entrypointでのtag/path purgeが必要であることも実測した。検証resourceは削除済みで、運用サービスには配備していない。

公式[Workers Cache料金](https://developers.cloudflare.com/workers/cache/#pricing)では、cache HITとcache付きloopback呼出もrequest課金対象。gatewayが実行されるので、内部HITでもgatewayのCPUとR2状態readは残る。外部1要求とcached inner 1呼出の構成では、2 request相当を基本とした試算が必要であり、「同じWorkerだから追加request料金なし」としない。Freeの100,000 request/日・10ms CPU制限、実請求/CPU、300MB音源・複数coloでの挙動は今回未実証。purgeにもWorkers Cache共通のFree-tier rate limitがある。Wranglerを管理端末の必須ツールに戻さず、別製品も増やさない。

`src/lifecycle-cached-entrypoint.ts`と`src/lifecycle-cache.ts`に本番接続用のclass/transport/handler/purgeを実装した（2026-10-01）。許可pathとgeneration props、秘密header除去、GET stream、HEAD/Range/HTTP条件、cache所有entrypoint内のtag+path purgeを扱う。GET MISSではHEADで選んだETagのbinding条件付きGETを使うため、内部のR2 readはHEAD+GETの2 operationとなる。HEAD/304/412/416はHEADだけでbodyを取得しない。mockとbundle/型検査で確認した段階であり、named entrypointの本番export、default cache無効deploy、移行と実機のcache HIT/MISS回帰はまだ未接続。

## 8. consumerの処理順と再開

### Episode公開停止

1. ownerと対象generationを再確認し、状態をunpublishedへ進める。以後MP3の新しい要求を入口で遮断する。
2. Showがactiveなら、active Episodeだけでfeedを再生成し、feed generationを進める。Show停止中ならfeed公開処理を省く。
3. feedと全revision音源のcacheをpurgeし、結果を保存する。R2 contentは消さない。
4. 完了statusを書き、同じowner/generationでShow受付を解放する。停止中のEpisodeが後続Show更新や別Episode公開でfeedへ戻らないことを確認する。

### Show公開停止

1. 同じ制御recordのCASでunpublishedへ進める。子状態は保持する。
2. Show全体のcacheをpurgeし、完了status・受付解放へ進む。複数Episodeを列挙して全状態を上書きする必要はない。

`src/lifecycle-unpublish.ts`にShow/Episode停止の状態機械を実装した。処理済みstateは最終job/generationで照合し、feed generationは`last_feed_job_id`で冪等に進める。feed書込とpurgeは注入したeffectをawaitし、purge完了後だけfinished progress/terminal statusとCAS解放へ進む。自動テストでは状態/進捗/解放の応答喪失とeffect失敗の再開を確認した。本番effect・Queue・管理API・CLIは未接続であり、mock成功を配信停止の実機合格と扱わない。

### 削除

1. 対象をdeletingへ進めて配信を遮断する。activeからのdeleteも停止を内包する。
2. Episodeなら親Showがactiveの場合にfeedから除外する。先に停止cacheをpurgeし、その後コンテンツ削除へ進む。
3. 対象prefixをページ分割で列挙し、許可されたkeyだけを小さなbatchで削除する。MP3をメモリへ読み込まない。存在しないobjectの削除は再実行成功として扱う。
4. phase・削除済み件数・次の処理範囲をR2へ保存する。大規模Showは複数のconsumer invocationへ分割し、同じjob/ownerを保持して続行messageを送る。
5. cursorだけを削除完了の根拠にしない。変更される一覧の取りこぼしを防ぐため、各対象prefixを先頭から再列挙して削除対象payloadが空であることを検証する。保持を許可したcommit markerは区別する。続行message喪失・DLQ後もR2のprogressから同じjobを再開できるようにする。
6. 削除後もcache purgeを確認し、tombstoneをdeletedとして完成させる。すべての検証とpurge成功後だけcompletedを書いて受付を解放する。

削除対象prefix:

| 対象 | 対象key/prefix |
| --- | --- |
| Episode | `public/podcasts/<showId>/episodes/<episodeId>/`、`public/episodes/<showId>/<episodeId>/`、`staging/episodes/<showId>/<episodeId>/` |
| Show | `system/shows/<showId>/show.toml`、`public/podcasts/<showId>/`、`public/episodes/<showId>/`、`staging/shows/<showId>/`、`staging/episodes/<showId>/` |

Show予約、Show制御record、Episode tombstone、lifecycle request/commit/progress、最小job監査は削除しない。古いpublication commitも復旧/拒否判断に必要な最小記録として残し、stagingの削除ではmetadata・cover・audioを消すがそのmarkerを区別する。2026-10-01に管理者が、小さい必要記録の自動期限削除は行わず、本文/個人情報/secretを複製しない方針を承認した。エラーreasonはallowlistの診断code/定型文に限定し、任意の例外messageを永続記録へ保存しない。期限付きの監査cleanupは後続とし、未完了/回復中jobを時間だけで消さない。

`src/lifecycle-deletion.ts`に、固定scope・許可key分類・list/headだけのページinventoryを追加した。媒体bodyを読み込まず、payload/保持marker/未知key blockerを分離する。`authorizesDeletion=false`であり、一覧結果だけで実削除を許可しない。

`src/lifecycle-delete-batch.ts`の独立した1 step処理は、delete owner/実行token、対象deleting状態と期待generation、durable progressの要求hash/phase/purge成功、呼出側の配信ゲート確認を必須とする。固定scopeのpayloadだけを最大100 keyのarrayで削除し、markerは本文をコピーせずstrict schema/対象/ETag/sizeを確認して保持する。未知key・不正marker・payload変更では削除を止める。progressはCASで保存し、payloadを削除したpageではcursorを進めず再列挙する。全scopeの削除走査後は先頭からverification passを行い、残存payloadがあれば削除へ戻る。終端は`finalizing`であり、まだdeleted/completedやowner解放にはしない。削除件数は応答喪失で過少になることがある診断値で、完了の証拠には使わない。

このbatchの前後処理は`stepLifecycleDelete`で開始時state/feed/purgeから最後のpurge/tombstone/terminal statusまで接続済みであり、`consumeLifecycleCommit`で通常終了後のQueue継続も実装した。本番API/Queue/CLIへは未接続。配信ゲート確認callbackの本番実装、強制終了invocationの安全な回復は残ゲート。mockのgate成功を本番配信の保証と扱わず、旧CLI停止・upload/consumer収束・移行の条件も維持する。

### 公開再開

受付を保持したまま、保存されたShow・active Episode・音源の存在を検証してfeedとcacheを準備する。再開対象自身はfeed構築時にactive候補として扱うが、他の停止/削除Episodeは除外する。purge後に対象をactiveへ進め、新generationで配信を開ける。Show再開は子の状態を維持する。ローカル編集の更新は再開完了後に通常のupdate/publishで行う。

`readLifecycleFeedInputs`でこの入力選択を実装した。current metadataとlifecycle両方から既知Episodeを把握し、欠落をactive扱いせず、restore対象自身だけを候補にする。音源は承認済みimmutable pathとHEADのsize/存在を確認し、metadata-only revisionの再利用pathを維持する。件数とmetadata読取量を制限し、tokenを読取前後に照合する。

`runLifecycleRestore`はこの入力とR2の保存済みShow/service snapshot・cover HEADを検証し、現在のpublic_base_urlでfeedを準備する（2026-10-01）。feed generation→purge→durable visibility/purge証拠→active CAS→finished/terminal status→owner解放を独立moduleとして実装した。配信gate callbackを準備前/purge前/active化前に要求し、purge失敗時は停止を維持する。HEAD確認は媒体checksum再検証ではない。本番feed書込・内部purge・gate callback・Queue/API/CLIへの接続は後続。

### 失敗の扱い

- 認証・対象不一致・stale generationは副作用前に拒否する。無用な自動retryを行わない。
- R2/Queue/purgeの一時失敗は既存の有限retry/DLQを拡張して扱う。最初は`max_retries: 2`、1件batch、consumer concurrency 1を維持する。
- 停止状態書込後・物理削除開始後の失敗を自動rollbackしない。停止を維持し、同じjobのphaseから収束させる。purge失敗でも配信ゲートは閉じたまま、完了報告はしない。
- DLQ到達だけではR2 statusは変わらない。`job-status`/`retry-job`を新actionと続行messageに対応させる。既存のpublication jobの回復を壊さない。
- completedの書込後、owner解放前に落ちた場合は完了済みの副作用をやり直さず解放だけ再試行する。古いjobによる新ownerの解放を禁止する。

## 9. 既存サービスとの互換性・移行

2026-10-01にservice CAS registryを追加した。新Workerの管理書込/Queue/DLQは副作用前にinvocation tokenを同じservice recordへ登録し、すべての書込Promise終了後に返す。pauseで新規管理操作を止め、取得済みinvocationと既存job consumer/限定retryをdrainする。移行ownerは同じCASで空registryだけを取得するため、遅れて入るconsumerとの競合でも同時成立しない。旧Workerがこのregistryに参加するわけではなく、100%切替前の処理と旧CLI REST直PUTには別途終了確認が必要である。取得応答喪失/強制終了のtokenを期限だけで消さない。M6 readinessへの切替、移行apply/API/CLIは後続とする。

- 既存Show/Episode入力schema、GUID、公開日時、音源キー、public URLは変更しない。制御情報・job schemaだけをversion付きで拡張する。
- 移行は管理者が公開/更新/uploadを止め、進行中jobを安全に収束させた状態で実施する。Show予約・公開snapshot・current Episode metadata・下書きを列挙し、従来公開済みをactive、未公開をdraftとして初期化する。既存recordは上書きしない。初期化途中はlifecycle受付を開けず、移行進捗を保存する。
- 2026-10-02に管理者が予定メンテナンス中の配信停止を許容した。部分初期化中などに503/no-storeで配信を閉じる区間を前提とし、可用性のために旧配信で安全ゲートを迂回しない。無停止移行は後続とし、具体的な移行日や停止時間は今回の決定から推定しない。
- 読み取り専用の`planLifecycleMigration`を追加した。list/getだけでsource ETag/sizeと初期状態案を返し、予約欠落、未完了owner/commit、公開metadataと媒体/履歴の不整合、部分的なv2初期化等をblockerにする。既存v2の停止状態・generation・tombstoneは推論でactiveへ戻さない。`inventory_compatible`は構造確認の結果であって受付停止・旧HTTP収束・移行実行の許可ではなく、`requires_quiescence=true`を常に返す。apply/API/CLIはまだ実装していない。
- 不完全な旧公開jobがある場合は移行を保留する。unknown/missingな制御recordを何でもactive扱いする後方互換は不可。移行済みサービスでの状態record欠落はfail closedする。
- 停止判定とcache構成に対応したWorkerへ100%切り替え、旧consumer/uploadの収束を確認してから新コマンドを利用可能にする。旧versionの段階的配信が残ったまま停止/削除を始めない。
- health/管理APIからlifecycle capability・schema version・移行状態を返し、新CLIは対応確認後に操作する。旧CLIは新job statusを読めない場合があるので全管理端末を更新する。
- lifecycle状態作成後にv0.1.2以前のWorkerをdeployすると停止を回避できてしまう。**旧Workerへのdowngradeは禁止する運用条件**とし、安全なrollbackはlifecycle対応version間だけにする。Cloudflare管理token所有者の直接deployまでシステムで阻止できるとはしない。
- 後続の独自ドメイン移行はactive Showのfeedだけを再生成し、停止・削除対象は再公開しない。再開時はその時点の正規URLを使う。

## 10. 実装対象

| ファイル/領域 | 変更予定 |
| --- | --- |
| `packages/shared/src/index.ts` | version別lifecycle/制御/request/status schema、TOML parser/stringifier |
| `packages/cli/src/index.ts`、`help.ts` | コマンド、確認、dry-run、remote再開、upload排他、capability確認 |
| `packages/cli/src/cloudflare-api.ts`、`scripts/build-cli.ts` | cache entrypoint付きREST deploy、bundle確認、既存設定・secret保持 |
| `src/index.ts` | gateway、内部cached entrypoint、認証管理API、Queue/DLQ routing、旧claim改修 |
| `src/publication.ts` | 制御record保存、停止対象を除く共通feed入力、旧jobの拒否、内部entrypoint purge |
| 新しい`src/lifecycle.ts`等 | unpublish/restore/deleteの状態機械、分割削除、耐久progress |
| 各test、README、`docs/` | 競合・障害・互換回帰、配布バイナリの実機手順・運用上の制約 |

## 11. M6の実装段階と公開ゲート

### M6.0: 設計承認・技術実証

- 下記の承認事項を確定する。
- per-entrypoint cacheのREST deploy、内部purge、generation key、GET/HEAD/Rangeとruntime制約内での正しい動作を、同一アカウントの専用Workerで確認する。費用・停止時間の測定計画はMVP構築後へ回し、機能実証と区別する。
- Show制御recordのCASと、旧job/uploadの移行手順、単一PUTの通常の排他・照合・中断回復、安全なreserved abandonの限定条件を検証する。切断後の遅延object作成がないという仮定U1の証明は公開ゲートに含めない。
- delete batch/Queue続行、対象markerと監査記録の保持規則、移行/rollback手順を確定する。

### M6.1: 状態モデル・受付・gateway

- version別schema、既存サービスの初期化、public gate、publication/stagingとの排他、capabilityを実装する。
- active配信の回帰とwarm cache状態でのゲートを検証する。ユーザー向けdeleteはまだ接続しない。

### M6.2: Episode停止・再開・削除

- Episodeの3操作、feedからの除外、全revisionの遮断・削除、progress/retry/DLQを実装する。
- last Episodeの停止/削除後も有効な空feedを返し、他Episodeのmetadata・音源に影響しないことを確認する。

### M6.3: Show停止・再開・削除

- 親ゲート、子状態保持、大規模Showの分割処理、未公開Show/下書きのみの削除を実装する。
- 同じbucketの別Show、サービス設定、Worker/Queue/DNSを壊さないことを確認する。

### M6.4: 回帰・実機受け入れ・文書化

- 以下の受け入れ条件を自動テストと専用Cloudflare環境で確認する。
- 別マシンで対応Linuxバイナリだけから確認・停止・再開・削除・再試行を実行する。
- README/help/smoke guideと復旧手順を完成する。M6機能一式を次バージョンとして正式リリースする。部分実装をM6完了と表示せず、未検証の削除コマンドはReleaseに載せない。次のRelease番号は受け入れ後に決める。限定先行リリースは必須にしない。

## 12. 受け入れ条件

1. Episode停止後、feedから対象itemだけが消え、current/旧revisionすべてのMP3が404になる。他EpisodeはGET/HEAD/Rangeを維持する。
2. Episode再開でGUID・公開日時・音源bytesが同じまま復帰する。ローカルの未公開編集や削除済みEpisodeを取り込まない。
3. Show停止後、feed/cover/全MP3が404となり、別Showと管理APIは正常。Show再開で個別停止Episodeを復活させない。
4. Episode/Show削除後は410、指定prefixに削除対象payloadが残らず、許可されたmarker・tombstone等だけが残る。全revision・staging audioも対象で、ローカル元ファイルは変わらない。
5. 未公開Episode、予約のみ/下書きのみのShow、0 EpisodeのShowでもdeleteできる。存在しない対象、ID再利用、削除後publish/restoreは適切に拒否する。
6. 対象ID確認、非対話のconfirm、dry-run、別workspace/別Show、`a`と`a-b`のprefix境界を検証する。dry-runではR2更新がない。
7. warm cache・旧tagなしMP3・query違い・HEAD/Range/条件付き要求で停止を回避できない。状態読取失敗時もcached bodyを返さない。内部purgeが実際のcache所有entrypointに効く。
8. publication/stagingとの同時受付は一方だけ成功する。6種のlifecycle操作間の競合、古いcommit配送、重複配送、stale generation、旧job再試行で復活・別対象削除を起こさない。
9. marker前、停止状態書込後、feed書込後、purge失敗、各削除batch、続行送信、completed後/解放前で中断して同じjobから再開する。削除済み部分を元に戻さず、他Showを削除しない。
10. 多ページR2一覧を全件処理し、終端の再列挙で欠落がない。DLQ後・CLI状態喪失後もremoteから再開できる。processingのunsafe abandonができない。
11. v0.1.2サービスを移行して新規公開・metadata-only/audio-only改訂・cleanup・retry・deployを回帰確認する。MP3上限300,000,000 bytes、private R2、system/staging非公開を維持する。
12. 削除の不可逆性、残す記録、外部コピーを回収できないこと、directoryの手作業、旧CLI/Workerへのdowngrade禁止が公開文書に明記される。
13. REST単一PUTを維持し、切断後に遅延object作成がないというM6仮定と未解決懸念U1を公開文書に明記する。既存の`If-Match`試験や中断回復テストを、この仮定の実証と表示しない。

## 13. 承認事項と確認待ちの判断

この文書の作成だけで、以下を承認済みとは扱わない。

2026-10-01に管理者が[レビュー待ち一覧](./m6_review_queue.md)へのannotationで公開時の利用条件を承認した。停止404/削除410/空feed 200、外部cache再検証、削除ID再利用禁止、進行中jobへ割り込まない仕様、状態照会/内部cache構成に伴うrequest・CPU・R2 read増を許容する方針を承認済みとする。続けて、小さい必要な管理/操作記録は自動期限削除せず保持し、本文/個人情報/secretを複製せずpayloadを物理削除する方針も承認した。性能/料金の具体値や実機受け入れは別途確認する。

独立して進められる実装を継続し、最終確認待ちと技術残件は[レビュー待ち一覧](./m6_review_queue.md)に分離してまとめる。未接続moduleの自動テスト追加を、公開policyの承認やM6の実機受け入れと扱わない。

1. **承認済み（2026-10-01）**: deleteはpayloadの物理削除、unpublishは保持。必要な小さい管理/操作記録を残す方針と分離する。
2. **承認済み（2026-10-02）**: unpublishと対になるrestoreも含め、M6機能一式を構築して次バージョンとして正式リリースする。通常publishによる暗黙再開ではなく明示restoreを使う。
3. **承認済み（2026-10-01）**: 停止時404、削除中/削除済み410、空Showのfeedは200というHTTP仕様。
4. **承認済み（2026-10-01）**: 削除IDは永久再利用禁止。最小tombstoneと必要な小さい操作記録は自動期限削除せず保持し、本文/個人情報/secretは複製しない。期限付きの監査cleanupは後続。ローカル元ファイルはremote削除の対象外とする設計を維持する。
5. **方針は承認済み（2026-10-01）**: 長期immutableのクライアントcacheを再検証必須へ変えることと、毎要求のR2状態照会・内部呼出の性能/料金増を受け入れること。具体的な費用・停止時間の測定計画は2026-10-02の決定によりMVP構築後へ回す。
6. **承認済み（2026-10-01）**: 進行中publicationやuploadへ割り込まないこと。必要なら緊急遮断を別要件として設計する。
7. **承認済み（2026-10-02）**: 既存と同じCloudflareアカウント内の専用試験環境を使い、運用リソースと試験データを分離する。有料契約変更・無制限支出を承認したものではない。
8. **承認済み（2026-10-02）**: メンテナンス中の公開配信・更新操作の一時停止を許容する前提で構築する。無停止移行はMVP構築後の後続課題とする。

## 14. 一次資料と関連資料

2026-09-30にCloudflare一次資料を確認。文書上の契約とcastloop実機成功は区別する。

- [Workers Cache](https://developers.cloudflare.com/workers/cache/) — Worker実行前のHIT、入口分割、料金。
- [Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/) — per-entrypoint、version別cache、Range、header優先順位。
- [Cache examples](https://developers.cloudflare.com/workers/cache/examples/) — uncached gatewayとcached inner entrypoint、所有entrypoint内のRPC purge。
- [Cache purge](https://developers.cloudflare.com/workers/cache/purge/) — tag/path prefix、entrypoint scope、success確認とrate limits。
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) — bindingのread/write/delete/listは強整合、cacheは別。
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) — at-least-once配送。
- [全体設計](./initial_design.md)、[独自ドメイン計画](./custom_domain_plan.md)、[M3実装ログ](./m3_implementation_log.md)、[M5実装ログ](./m5_implementation_log.md)。
- [M6実装ログ](./m6_implementation_log.md) — 今後の判断・検証・進捗を記録する。
