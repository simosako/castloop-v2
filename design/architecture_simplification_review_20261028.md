# Issue #62を契機とした全体設計の見直しとシンプル化の提案（2026-10-28）

- 作成日: 2026-10-28
- 調査基準commit: `602bff1`（Issue #65/#70統合版、内部queue/content形式 `11/11`、およびIssue #62の初期設計案を含む状態）
- 関連Issue: [#62](https://github.com/simosako/castloop-v2/issues/62)

## 1. 背景と問題意識

Issue #62では、公開処理（publication job）が途中で停止して `blocked` 状態になった際に、状態診断（`job-diagnose`）・明示継続（`job-continue`）・明示終了（`job-abandon` と終端状態 `abandoned` の新設、内部形式 `12/12` への更新）を行う設計を検討していた。

しかし、そもそもこのシステムの目的は **「Podcastの音声・画像・RSSフィードをホストし、番組のWebページを生成・配信すること」** である。その本来の目的に対し、現在のプログラムは以下のように著しく肥大化している。

- **本番コード規模**: テストを除いた製品TypeScriptコードだけで **約15,900行（約95ファイル）**、テストを含めると **43,000行超**。
- **CLIコマンド数**: **約60コマンド**。その多くが中間状態の確認・再開・照合・掃除のための管理コマンドで占められている。
- **Show Durable Object（DO）内のSQLiteテーブル数**: 1つのShowあたり **約20テーブル**。
- **スキーマ非互換の連鎖**: 機能追加のたびに内部スキーマ番号（`SQLITE_QUEUE_SCHEMA_VERSION` / `SQLITE_CONTENT_SCHEMA_VERSION`）が `1/1` → `11/11`（Issue #62案で `12/12`）へと上がり、その都度「新規環境専用・既存環境は変換しない」として過去の環境を切り捨てる構造になっている。

データ更新の途中で不整合（`blocked`）に陥った後にそれを修復する仕組みを積み重ねるのではなく、**「そもそもデータ更新が成功か失敗（副作用なし）かの二択（アトミック操作）になっていれば、これほど複雑にならないのではないか」** という観点から、プロジェクト全体の作りを見直した。

---

## 2. 複雑さを生んでいる5つの構造的要因

### 2.1 データ更新が「成功か失敗かの二択」になっておらず、途中停止（`blocked`）がShow全体をロックする構造

現在の公開処理（`src/sqlite-publication-executor.ts`, `src/sqlite-publication-alarm.ts`, `src/sqlite-publication-queue.ts`）は以下の手順で動く。

1. CLIが公開要求を `publication_jobs` テーブルに `queued` 状態で登録し、Durable ObjectのAlarm（非同期タイマー実行）を設定する。
2. Alarmが起動してジョブを `running` に変え、`validate()` で **「これから書き込むR2キーや対象プレフィックスが空であること（`requireAbsent` / `requireEmpty`）」** を検査する。
3. `publish()` で複数のR2オブジェクト（音源・カバー画像・リビジョンTOML・Feed XML・分割HTML群、および上書き保存の `show.toml` / `metadata.toml`）を順番に書き込み、最後にキャッシュパージを実行する。
4. すべての外部I/Oが終わった後、`finish()` のSQLiteトランザクションでカタログ（Show / Episodeの現在値テーブル）を更新し、`succeeded` にする。

**この構造が引き起こしている連鎖的な複雑さ:**

- **単純な再試行ができない**: ステップ3の途中で一時的な通信失敗やWorker再起動が起きると、ジョブは `blocked`（`execution_interrupted`, `validation_unavailable`, `execution_failed`）になる。すでに一部のR2オブジェクトが書き込まれているため、そのまま再実行するとステップ2の `requireAbsent` / `requireEmpty` やR2の `If-None-Match: *`（上書き禁止条件）に引っかかって必ず失敗する。
- **1件の `blocked` がすべてを止める**: ジョブが1件でも `blocked` になると、そのShowの後続キューが永久に停止するだけでなく、Showの再開（`show-resume`）やサービス全体のWorkerコード更新（`deploy`）まで拒否される。
- **公開中コンテンツの配信を守るための過剰なガード**: 「ジョブが `running` や `blocked` の最中に、すでに公開済みの番組までHTTP 503（配信停止）になってはならない」という理由から、`publication_jobs` テーブルに **10個もの `read_*` 境界カラム**（`read_feed_generation`, `read_show_version`, `read_episode_id`, `read_request_sha256`, `read_verified`, `read_episode_state`, `read_episode_revision_id`, `read_episode_lifecycle_version`, `read_target_kind`, `read_cover_generation`）と `committedReadBoundary()`（`src/sqlite-publication-content.ts`）が追加された。

**本質的な問題:**
まだコミットしていない新しい音声や画像をR2へ先に配置しても、**SQLite上の「現在公開中のデータを指すポインタ（世代・リビジョン）」を最後の1トランザクションで切り替えるまでは、公開中の配信には本来何の影響も与えない**。
「R2への冪等（べきとう：何度実行しても同じ結果になること）なファイル配置」と「SQLiteの単一トランザクションによる確定」に分ければ、更新は常に **「成功（コミット完了）」か「失敗（ロールバックされ副作用なし・そのまま再実行可能）」の二択** になり、`blocked` 状態も `read_*` カラム10個もIssue #62の復旧機構も不要になる。

---

### 2.2 RSSフィードとWebサイトHTMLを「更新時にAlarmでバッチ生成してR2に世代別保存」している

現在、エピソードや番組を更新するたびに以下の処理が走る（`src/sqlite-site-content.ts`, `src/site-publication.ts`, `src/sqlite-feed-generations.ts`）。

- `publication_feed_generations` テーブルでFeed世代番号を予約し、RSS XMLを生成してR2（`public/podcasts/<showId>/feeds/<generation>.xml`）へ書き込む。
- `publication_site_builds` と `publication_site_sources` に全エピソードの複製を保存し、1回のAlarmにつき最大20ページ（または4MB）ずつHTMLを生成してR2（`public/podcasts/<showId>/sites/<generation>/...`）へ書き込み、残りは `yield()`（`continuation_ready=1`）で次のAlarmへ持ち越す。
- 生成した全ページのパスを `publication_site_candidates` に貯め、2種類のキャッシュ（`SqliteCachedAssets` と `SiteCachedPages`）をパージした後に `publication_site_pages` と `publication_site_state` へコピーする。

**本質的な問題:**
- RSS XMLやWebページ（一覧ページ・個別エピソードページ）を描画するためのメタデータは、**すべてそのShow DOのSQLite内にすでに存在する**。
- しかも現在のGateway（`src/sqlite-gateway.ts`, `src/site-gateway.ts`）は、公開URLへのアクセスが来るたびに毎回Show DOの `delivery()` / `siteDelivery()` を呼び出している。
- 数十〜数百件のエピソードのRSS XMLや、1ページ20件分のHTMLをSQLiteからメモリ上で生成する処理は数ミリ秒で完了する。更新時にわざわざR2へ全ページを書き出し、Alarmで分割バッチ実行・世代管理する必要はなく、**配信リクエスト時にSQLiteから生成してEdgeキャッシュ（Cloudflareのキャッシュ）に乗せる** だけでよい。

---

### 2.3 ローカル編集から公開までの「多段ステージング」と「状態追跡の三重構造」

現在、手元のファイルを編集してから公開するまでに、以下の多段処理と状態管理が行われている（`packages/cli/src/sqlite-draft.ts`, `packages/cli/src/sqlite-upload.ts`, `src/sqlite-operation-records.ts`）。

1. **数KBのTOMLファイルまでR2にアップロードしている**:
   `show.toml` や `episode-*.toml` をR2の `staging/` にPUTし、全量を再ダウンロードしてSHA-256ハッシュを検証し、公開時にDOが再びR2から読み出している。本来はDOへのHTTPリクエスト（JSON）にそのまま載せれば済む小さなテキストデータである。
2. **最大300MBのMP3をR2へPUTした後、全量再ダウンロードし、さらにDO内で `staging/` から `public/` へ再コピーしている**:
   CLIがR2へPUTした直後に最大300MBをローカルへ読み戻してハッシュを検証し（`verifyAcknowledgedR2Object`）、さらに公開Alarm内でDOが `staging/` からストリームで読み出して `public/` キーへもう一度書き直している（`persistAudio`）。
3. **1回のファイルアップロードにつき5往復のRPCと多重ジャーナル**:
   CLIはDOの `operations` テーブル群に対して `register` → `begin_upload` → `report_upload` → `verify_upload` → `attach_asset` の5段階の通信を行い、ローカルの `.castloop/sqlite-uploads/` と `.castloop/sqlite-drafts/` にロックファイル付きで途中状態を書き続けている。

この結果、「ステージングやアップロードの途中で止まった状態」を管理するためだけに、サーバー側の `operations` 系5テーブル（`operations`, `operation_requests`, `operation_assets`, `operation_events`, `operation_record_schema`）と、CLIの `operation-list` / `operation-status` / `operation-resume` / `operation-cancel` / `operation-cleanup-preview` / `operation-cleanup` という多数のコマンドが必要になっている。

---

### 2.4 本番コードで誰からも読まれない遺物ファイルと、データの多重保存

コードベース全体を検索すると、同じメタデータが最大5箇所（ローカルTOML、SQLite現在値テーブル、SQLite履歴テーブル、R2現在値TOML、R2履歴TOML）に重複保存されている。

特に `src/sqlite-publication-executor.ts`（353行目・359行目）で公開のたびにR2へ上書き保存している以下の2ファイル：
- `system/shows/<showId>/show.toml`
- `public/episodes/<showId>/<episodeId>/metadata.toml`

これらは **本番コードのどこからも一切読み取られていない**（旧v0.5.xのR2方式時代の名残であり、テストコードが書き込みの有無を検査しているだけである）。それにもかかわらず、これらの書き込みが失敗・中断するとジョブが `blocked` になる原因になっている。

---

### 2.5 `worker_version_id` の永続化と、デプロイ・再開時の過剰な儀式（Pause / Drain / Window / Probe）

現在、DOのSQLite（`publication_service` テーブルや各ジョブ・予約レコード）に **Cloudflare WorkerのバージョンID（`worker_version_id`）** と **受付ウィンドウID（`admission_window_id`）** を保存し、全リクエストで厳密一致を要求している（`src/sqlite-runtime-update.ts`, `src/sqlite-service-control.ts`, `src/sqlite-service-runtime.ts`）。

そのため、Workerの軽微なコード修正を `castloop deploy` するだけでも以下の手順が必要になっている。

1. 全Showを手動でPauseし、キューが空（drained）になるのを待つ。
2. 制御DOと全Show DOに対して `prepareUpdate`（2相コミットの準備ロック）を実行する。
3. Workerスクリプトをデプロイし、全DOに新しい `worker_version_id` が反映されるのを待つ。
4. 全DOに `activateUpdate` を送り、各DOのAlarmで `publication_runtime_setup`（R2上の `system/service.toml` 読取、キャッシュ状態確認、ダミーのキャッシュパージ `probe-<id>`）を実行する。
5. `releaseUpdate` で保守ロックを解除し、その後さらに管理者が全Showに対して新しいUUID（`NEW_WINDOW_UUID`）を指定して `show-resume` を手動実行する。
6. しかもPauseやWorker更新を行うたびに、登録済みの未来の予約公開（`publication_schedules`）がすべて `needs_approval` 状態に落ち、1件ずつ手動でプレビューと再承認（`schedule-reapprove`）をやり直さなければならない。

また、この多段階の更新・初期化が途中で止まった場合のために、`init-reconcile`, `init-continue-verification`, `update-service-verify`, `update-service-reconcile`, `show-control-status` といった専用の復旧・確認コマンドが多数作られている。

---

## 3. シンプルにしていくための改善案

上記の複雑さを解消し、本来の「PodcastをホストしWebページを配信する」という目的に見合ったシンプルな構造へ整理するための5つの改善案を示す。

---

### 改善案A：【最優先・Issue #62の根本解消】公開処理を「不変オブジェクト準備 → SQLiteの単一トランザクションコミット」にする

「データ更新が途中状態で止まり、修復が必要になる」という構造そのものをなくす。

1. **メディアファイル（MP3・カバー画像）はコンテンツハッシュ（SHA-256）をキーにしてR2へ冪等に配置する**:
   - 例：`public/podcasts/<showId>/audio/<sha256>.mp3`、`public/podcasts/<showId>/covers/<sha256>.jpg`。
   - 同じ内容のファイルであれば同じキーになるため、すでにR2上に同じキー（かつ同じサイズ・SHA-256）が存在すれば再アップロード自体をスキップできる。途中で通信が切れても、再実行すれば同じキーへ書き直すだけで済み、ゴミや衝突による失敗が起きない。
   - SQLite側がコミットされるまでそのキーはどこからも参照されないため、アップロード中や失敗時に公開中の番組配信へ影響することもない。
2. **メタデータ（TOMLの内容）はR2にステージングせず、公開リクエストのJSONとしてDOへ直接送る**:
   - R2上の誰も読んでいない `show.toml` / `metadata.toml` や、SQLiteと重複している `revisions/*.toml`、および `staging/` へのTOMLアップロードを廃止する。
3. **DOでの公開確定を「同期SQLiteトランザクション1回」で即座に完了させる**:
   - DOは公開リクエストを受けたら、指定された音声・カバー画像がR2上に存在すること（`bucket.head()` によるサイズ・SHA-256確認）と入力の整合性をチェックする。
   - 検証が通れば、**その場で `storage.transactionSync()` によりShow / Episode / Revisionテーブルを更新して `200 OK`（成功）を返す**。
   - もし検証失敗や通信エラーが起きればSQLiteトランザクションは一切コミットされないため、状態は更新前のまま保たれる（失敗）。修復作業は何も要らず、そのまま同じコマンドを再実行すればよい。

**この改善案で削減できるもの:**
- `publication_jobs` の非同期Alarm実行、`running` / `blocked` / `continuation_ready` 状態。
- 公開中配信を守るためだけに存在していた `publication_jobs` の `read_*` カラム10個と `committedReadBoundary()`。
- **Issue #62 で追加しようとしていた `job-diagnose` / `job-continue` / `job-abandon` コマンド、`abandoned` 状態、`prepared_at` 列。**

---

### 改善案B：RSSフィードとWebサイトHTMLの「オンデマンド生成＋キャッシュ」化

公開時のHTML分割バッチ生成とR2への世代別スナップショット保存を廃止する。

1. **リクエスト時にSQLiteから直接生成する**:
   - `/podcasts/<showId>/feed.xml` やWebサイト（`/podcasts/<showId>/`, `/podcasts/<showId>/page/<n>/`, `/podcasts/<showId>/<slug>`）へのアクセスが来た際、Show DOのSQLiteにあるコミット済みテーブルからその場でXML / HTMLを描画して返す。
2. **`state_version` を使ったキャッシュ分離**:
   - Showデータの更新トランザクションごとに `state_version` を `+1` する。
   - キャッシュ（`SqliteCachedAssets` / `SiteCachedPages` または標準Cache API）のキー（props）に `state_version` を含めることで、SQLiteがコミットされた瞬間に次のリクエストから自動的に新しいFeed / HTMLが生成・キャッシュされる。
   - 古いキャッシュのパージはベストエフォートで行えばよく、「パージが失敗したから公開ジョブを `blocked` にする」という問題も起きなくなる。

**この改善案で削減できるもの:**
- `publication_site_builds`, `publication_site_sources`, `publication_site_candidates`, `publication_site_pages`, `publication_site_state`, `publication_feed_generations` の **6テーブル**。
- Alarmによる20ページずつの分割バッチ生成（`batch()` / `yield()`）と、R2上の `feeds/<gen>.xml`・`sites/<gen>/*.html`。
- 独自ドメイン設定・解除時の「全ShowのFeed / HTML再生成バッチとAlarm完了待ち」。

---

### 改善案C：CLIワークフローの単一ステップ化（`operations` 5テーブルとローカル `.castloop` ジャーナル群の廃止）

ローカルのTOMLファイルと音声・画像ファイルを編集したら、1コマンドでシンプルに公開・反映できるようにする。

1. **ステージング専用コマンド（`update-*`）と公開コマンド（`publish-*`）の統合**:
   - 事前確認は `preview-show` / `preview-episode`（読み取り専用）で行う。
   - `publish-show` / `publish-episode` を実行すると、CLIが「①ローカルTOMLと素材の検証 → ②R2に未配置の音声・画像があれば直接PUT → ③DOへメタデータとR2キーを送ってアトミックコミット」を一気通貫で行う。
2. **R2アップロード後の300MB全量再ダウンロードとDO内300MB再コピーの廃止**:
   - R2へのPUT時にSHA-256チェックサムとサイズ・ETagを検証すれば、直後に300MBのMP3を丸ごとダウンロードし直したり、DO内で `staging/` から `public/` へ300MBをストリームコピーし直したりする必要はない。
3. **アップロード追跡用の `operations` 5段階RPCとローカルジャーナル群の廃止**:
   - メディア配置がコンテンツハッシュベースの冪等PUTになれば、途中でCLIが強制終了しても、次回 `publish-episode` を実行した際に「すでにアップロード済みのファイルはスキップ、未完了のファイルはPUT」するだけで安全に再開できる。

**この改善案で削減できるもの:**
- DO内の `operations`, `operation_requests`, `operation_assets`, `operation_events`, `operation_record_schema` の **5テーブル**。
- R2内の `staging/` 領域と、DO内の `persistAudio`（R2間コピー）。
- ローカル `.castloop/` 内の `sqlite-drafts`, `sqlite-uploads`, `sqlite-lifecycle`, `sqlite-revisions` 等のジャーナルファイルとプロセスロック機構（`.castloop/` には管理者キーなどの認証情報のみを保持する）。
- `operation-list`, `operation-status`, `operation-resume`, `operation-cancel`, `operation-cleanup-preview`, `operation-cleanup`, `update-show`, `update-episode`, `update-episode-audio`, `job-status`, `progress`, `watch` 等の多数のコマンド。

---

### 改善案D：WorkerデプロイとShow稼働制御の簡素化

日常のコード更新や運用のたびに全Showを停止・再開・再承認する手順をなくす。

1. **`worker_version_id` のDB保存・一致強制の廃止**:
   - DOのSQLiteにデプロイごとの `worker_version_id` を保存してリクエストを縛る仕組みをやめる。
   - `castloop deploy` は純粋にCloudflare APIでWorkerスクリプトを更新するだけの単発操作とし、制御DOと全Show DOにまたがる2相コミット（`prepareUpdate` / `activateUpdate` / `releaseUpdate`）や起動時のダミーパージProbe Alarm（`publication_runtime_setup`）を廃止する。
2. **`admission_window_id` の廃止と稼働状態の整理**:
   - 公開処理が1リクエストの即時トランザクションになれば、「キューをdrainしてからでないと停止・再開・デプロイできない」という制約自体がなくなる。
   - 再開のたびに新しいUUID（`admission_window_id`）を発行する仕組みを廃止し、Showの公開状態（`published` / `unpublished`）またはシンプルな停止フラグだけで制御する。
   - これにより、Workerのデプロイや一時停止のたびに予約公開（`publication_schedules`）が `needs_approval` に変わって手動再承認を要求される問題も解消する。

**この改善案で削減できるもの:**
- `publication_runtime_setup`, `publication_runtime_updates`, `service_show_maintenance`, `service_show_update_targets`, `publication_availability_controls` テーブル。
- `init-reconcile`, `init-continue-verification`, `update-service-verify`, `update-service-reconcile`, `show-admission-pause`, `show-delivery-resume`, `show-control-status` 等のコマンド群。

---

### 改善案E：永続スキーマの安定化（既存環境を切り捨てない構造へ）

改善案A〜Dを適用すると、Show DO内のSQLiteテーブルは以下の **5〜6個の純粋なドメインテーブル** に集約される。

1. **`show_state`**: 番組の現在設定（メタデータJSON、現在のカバー画像ハッシュ、`state_version`、公開状態）
2. **`episodes`**: エピソード一覧（メタデータJSON、現在の音声ハッシュ、公開状態、Webサイト用短縮slug）
3. **`show_revisions` / `episode_revisions`**: 番組とエピソードの過去リビジョン履歴
4. **`schedules`**: 予約公開の予定日時と公開内容（**DOのAlarmはこの予約公開の実行にのみ使用する**）
5. **`delivery_stats`**: エピソード別・日別の配信統計

実行途中の内部都合（`read_*` 境界値、`site_builds`、`runtime_updates`、`operations` 等）がテーブル定義からなくなるため、スキーマを頻繁に変更する必要がなくなる。将来カラム追加が必要になった場合も、通常の `ALTER TABLE ... ADD COLUMN` 等で既存環境を維持したままアップデートできる。

---

## 4. 現状と改善後の全体比較

| 項目 | 現状（`602bff1` 時点） | 改善案（A〜E）適用後 |
| --- | --- | --- |
| **データ更新のモデル** | 非同期AlarmでR2書込・キャッシュパージを順次実行し最後にDB更新。途中失敗で `blocked` になりShow全体が停止 | **成功か失敗（副作用なし）の二択**。R2へ冪等配置後、SQLiteの1トランザクションで即座に確定 |
| **Issue #62（不整合復旧）** | `job-diagnose` / `job-continue` / `job-abandon` と `abandoned` 状態の追加が必要 | **`blocked` 状態自体が存在しないため不要**（失敗時はそのまま再実行するだけ） |
| **MP3のアップロード** | CLI→R2 `staging/` へPUT→300MB再DL検証→5回の操作RPC→DO内で `public/` へ300MB再コピー | CLI→R2 `audio/<sha256>.mp3` へ直接PUT（既存ならスキップ）→DOで `head` 確認のみ |
| **RSS / Webサイト生成** | 公開時にAlarmで20件ずつバッチ生成し、R2へ世代別に全ファイル保存 | 配信リクエスト時にSQLiteから直接生成＋`state_version` 付きキャッシュ |
| **DOのAlarmの用途** | ①初期Probe、②通常公開FIFO、③サイト分割生成、④ドメイン変更Feed生成、⑤Worker更新確認、⑥予約公開 の6用途が競合 | **予約公開（指定時刻が来たらトランザクションを実行）の1用途のみ** |
| **Show DOのテーブル数** | 約20テーブル | **5〜6テーブル**（Show, Episode, Revision, Schedule, Stats のみ） |
| **ローカル `.castloop/`** | 多数のジャーナルディレクトリと `.lock` ファイルで中間状態を追跡 | 管理者キー（secret）等の最小限の認証・設定情報のみ |
| **CLIコマンド数** | 約60コマンド | **約20〜25コマンド**（作成・検証・プレビュー・公開・予約・履歴・統計・バックアップ・診断） |
| **Workerのデプロイ** | 全Show停止・2相コミット・Probe Alarm・手動Resume・予約の再承認が必要 | Workerスクリプトを更新するだけ（無停止・予約も維持） |

---

## 5. 既存コードベースの仕分け（何を残し、何をどう変えるか）

現在のコードベース（全体約27,300行：製品コード約15,900行、テスト約11,400行）を調査した結果、一から別リポジトリで作り直すのではなく、**既存リポジトリ内の良質な機能モジュールを活かしつつ、複雑化した状態管理エンジンだけをクリーンに差し替える方針**を採用する。

### 5.1 そのまま残して活用する資産（全体の約40〜45%）

以下は複雑な中間状態（`blocked` や多段ジャーナル）から独立している純粋なドメイン処理・周辺機能であり、再実装によるバグ混入や手戻りを防ぐためそのまま維持する。

- **TOMLスキーマ検証・共通処理**（`packages/shared/src/index.ts`, `metadata-limits.ts`, `metadata-time.ts`, `time-zone.ts`, `xml.ts`, `sha256.ts` 等）：
  - `show.toml` / `episode.toml` / `service.toml` の厳密なZod検証、文字数・サイズ制限、タイムゾーン処理、XMLエスケープ。
- **RSSフィード生成・Webサイト描画**（`src/feed.ts`, `src/site-renderer.ts`, `src/site-description.ts`, `src/sqlite-site-ids.ts`）：
  - iTunes対応RSS 2.0 XML生成、`htmlparser2` による安全なHTML説明文整形・抜粋生成、16文字の短縮URLハッシュ（衝突時自動延長）生成。
- **配信統計（Issue #71）**（`src/sqlite-delivery-stats.ts`, `packages/cli/src/stats.ts`）：
  - HTTP Rangeリクエストに対応したエピソード別・日別の配信統計記録と集計。
- **暗号化バックアップ・復元（Issue #63）**（`packages/cli/src/backup-*.ts`）：
  - ローカルワークスペースの暗号化アーカイブ作成・検証・復元。
- **外部RSSインポート**（`packages/cli/src/rss-import-*.ts`）：
  - 既存Podcastフィードの解析、メタデータ変換、音源・画像のダウンロード。
- **インフラ・ローカル検査基盤**（`packages/cli/src/sqlite-cloudflare.ts`, `sqlite-domain-cloudflare.ts`, `audio.ts`, `local-input.ts`, `doctor.ts`, `draft-preview.ts`, `src/admin-auth.ts`）：
  - Wrangler不要のCloudflare REST APIクライアント（Workers, R2, Custom Domains）、MP3フレーム解析、ローカルプレビュー、定数時間比較による管理者キー認証、Bun単一バイナリビルド構成。

### 5.2 シンプルな新実装へ差し替え・廃止する部分（全体の約55〜60%）

以下は「非同期バッチ公開・多段ステージング・途中停止（`blocked`）の保護と追跡」のために肥大化した配管（Plumbing）部分であり、段階的に新実装へ置き換えて削除する。

- **Worker側の非同期公開キュー・バッチ生成・操作追跡**:
  - `src/sqlite-publication-queue.ts`, `src/sqlite-publication-executor.ts`, `src/sqlite-publication-alarm.ts`, `src/sqlite-publication-content.ts`, `src/sqlite-site-content.ts`, `src/sqlite-feed-generations.ts`, `src/sqlite-operation-records.ts`, `src/sqlite-service-control.ts`, `src/sqlite-service-runtime.ts` 等。
- **CLI側の多段ステージング・アップロード追跡・ローカルジャーナル群**:
  - `packages/cli/src/sqlite-draft.ts`, `sqlite-upload.ts`, `sqlite-draft-journal.ts`, `local-journal-*.ts`, `process-journal-lock.ts`, `sqlite-operation-commands.ts` 等。
- **旧中間状態（`read_*` 境界列、`staging/`、`blocked`、5段階upload RPC）を前提としたテスト群**:
  - 既存の巨大テスト（`src/sqlite-publication-executor.test.ts` 等）を少しずつパッチ修正すると古い前提の維持に追われるため、新エンジンに対応するシンプルなテストへ置き換える。

---

## 6. 段階的な進め方の基本方針

既存の20テーブルや非同期キューのコードを少しずつ削る（パッチ当てする）のではなく、**「①の周辺資産は残したまま、中心の『公開・配信エンジン（Show DOとCLIの接続部）』をシンプルな設計でモジュールごと差し替える」** 方式で進める。

1. **フェーズ1（Show DOコア公開・配信モデルの刷新：改善案A＋B＋Eの基礎）**:
   - Show DOにおける公開処理を「同期トランザクションによる即時コミット（成功か失敗の二択）」に置き換え、`blocked` 状態・非同期公開キュー・`read_*` 境界カラムを廃止する。
   - あわせてRSSフィードとWebサイトHTMLをSQLiteからのオンデマンド生成＋`state_version` キャッシュに切り替え、`publication_site_*` / `publication_feed_generations` テーブルと分割バッチAlarmを廃止する。
2. **フェーズ2（CLIアップロードとローカル状態の簡素化：改善案C）**:
   - メディアのコンテンツハッシュ直接配置に統一し、R2 `staging/` コピー、`operations` 系5テーブル、ローカル `.castloop/` のドラフト・アップロードジャーナル群、および `operation-*` / `update-*` コマンド群を整理・廃止する。
3. **フェーズ3（デプロイ・稼働制御の簡素化とスキーマ確定：改善案D＋Eの仕上げ）**:
   - `worker_version_id` 拘束、2相コミット更新、起動時Probe Alarm、`admission_window_id` を整理し、シンプルなテーブル構成（改善案E）へ仕上げる。
   - 不要になった旧コード・旧テスト・旧設計記述を整理し、ドキュメントを更新する。
