# フェーズ1設計書：公開処理の同期アトミック化とRSS/Webサイトのオンデマンド配信（2026-10-28）

- 作成日: 2026-10-28
- 親文書: [全体設計の見直しとシンプル化の提案（2026-10-28）](architecture_simplification_review_20261028.md)
- 対象範囲: 改善案A（公開処理のアトミック化・`blocked` 廃止）＋改善案B（RSSフィード・WebサイトHTMLのオンデマンド生成化）

---

## 1. フェーズ1の目的とスコープ

フェーズ1の目的は、Show Durable Object（DO）における **「非同期Alarmによる多段階R2書き込みと途中停止（`blocked`）」** を廃止し、**「すべてのデータ更新が1回のリクエスト内で成功（SQLiteコミット完了）か失敗（SQLite未変更・副作用なし）かの二択で完了する構造」** に刷新することである。

### フェーズ1で達成すること
1. **公開処理の同期アトミック化（改善案A）**:
   - 公開リクエスト（`POST /admin/sqlite-publication/jobs`）および予約公開の実行（`schedules.dispatchDue()`）を、非同期キュー＋Alarmではなくその場で同期的に完了させる。
   - `running` / `blocked` / `continuation_ready` 状態、および公開中の配信を守るためだけに存在していた `publication_jobs` の `read_*` 境界カラム10個と `committedReadBoundary()` を廃止する。
   - R2上の誰も読んでいない遺物TOML（`show.toml`, `metadata.toml`, `revisions/*.toml`）の書き込みと、再試行を妨げていた `requireAbsent` / `requireEmpty` 検査を廃止する。
2. **RSSフィードとWebサイトHTMLのオンデマンド生成（改善案B）**:
   - 公開時・ドメイン変更時にR2へ書き出していた `feeds/<generation>.xml` と `sites/<generation>/**/*.html`（20件ずつの分割バッチ生成Alarm）を廃止する。
   - 配信リクエスト時（`SqliteCachedAssets` / `SiteCachedPages` のキャッシュミス時）に、Show DOのSQLiteにコミットされているデータから直接XML / HTMLを描画して返し、Edgeキャッシュに乗せる。
   - サイト生成・Feed世代管理用の6テーブル（`publication_site_builds`, `publication_site_sources`, `publication_site_candidates`, `publication_site_pages`, `publication_site_state`, `publication_feed_generations`）を完全に削除する。

### フェーズ2・3へ送るもの（フェーズ1では既存のインターフェースを維持するもの）
- CLI側のステージング手順（`update-*` → `publish-*`）や `operations` テーブル、ローカル `.castloop/` ジャーナルの削除は **フェーズ2** で行う。フェーズ1では、既存のCLIがそのまま動くよう `POST /admin/sqlite-publication/jobs` が即座に `state: "succeeded"` のステータスを返す形で互換性を保つ。
- `worker_version_id` や2相コミット更新（`prepareUpdate` / `activateUpdate`）の削除は **フェーズ3** で行う。

---

## 2. 公開処理の同期アトミック化（改善案Aの詳細設計）

### 2.1 なぜ従来は `blocked` が発生していたのか

従来の公開処理は、1つのジョブの中で以下のR2書き込みとキャッシュ操作を順番に行っていた。

1. `sites/<gen>/*.html` を20ページずつR2へPUT（複数回のAlarmに分割）
2. `system/shows/<showId>/revisions/<jobId>.toml` をR2へPUT（`If-None-Match: *`）
3. `system/shows/<showId>/show.toml` をR2へPUT
4. `public/podcasts/<showId>/covers/<gen>.<ext>` をR2へPUT（`If-None-Match: *`）
5. `public/podcasts/<showId>/episodes/<ep>/<jobId>.mp3` をR2 `staging/` からコピーPUT（`If-None-Match: *`）
6. `public/episodes/<showId>/<ep>/revisions/<jobId>.toml` をR2へPUT（`If-None-Match: *`）
7. `public/episodes/<showId>/<ep>/metadata.toml` をR2へPUT
8. `public/podcasts/<showId>/feeds/<gen>.xml` をR2へPUT（`If-None-Match: *`）
9. キャッシュパージ（`SqliteCachedAssets` + `SiteCachedPages`）
10. 最後にSQLiteのShow / Episodeテーブルを更新

このうち **1, 2, 3, 6, 7, 8 はすべて不要なR2書き込み** である（HTMLとFeedはSQLiteからオンデマンド生成でき、リビジョン履歴と現在値メタデータはすでにSQLiteのテーブルにSHA-256付きで保存されているため）。

残るR2操作は **4（カバー画像の配置）** と **5（音声MP3の配置）** のみである。

### 2.2 新しい公開処理の3ステップ（成功か失敗かの二択）

公開処理（`publish`, `restore_revision`, `unpublish`, `restore`）を以下の3ステップで構成し、1回の実行で完了させる。

#### ステップ1：事前検証とメディアの冪等（べきとう）なR2配置（SQLite未変更）
- **対象・世代の検証**:
  - サービス設定（`service_id`, `service_config_sha256`）、Showの稼働状態（`ready()`）、および楽観的ロック条件（`expected_show_state_version`, `expected_episode_lifecycle_version`, `base_revision_id`）を検証する。
- **メタデータと描画の検証**:
  - 入力メタデータ（`ShowMetadata` または `EpisodeDraft`）のスキーマ・文字数上限・GUID重複・エピソード数と容量上限（`assertPublicationInventoryBudget`）を検証する。
  - 短縮URL（`site_id`）の候補を計算し、更新後の状態で `renderFeed` およびWebサイト描画（`siteStyles`, `formatSiteDescription`）がエラーなく成立することをメモリ上で確認する。
- **メディア（カバー画像・音声MP3）の冪等な配置と確認**:
  - まだSQLiteのポインタ（`cover_generation` や `audio_revision_id`）は切り替わっていないため、この段階でR2へメディアを書き込んでも公開中の配信には一切影響しない。
  - **`requireAbsent` / `requireEmpty` の廃止と冪等化**:
    - 書き込み先の不変R2キー（`public/podcasts/<showId>/covers/<generation>.<ext>` または `public/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3`）に対してまず `bucket.head(key)` を行う。
    - すでに同じキーが存在し、かつ `size` と `sha256` が今回配置すべきメディアと完全一致していれば（前回の試行が通信切断等で中断した後の再実行）、再書き込みをスキップして検証成功とする。
    - 存在しない場合は `bucket.put(key, ...)` で書き込み、`size` と `sha256` を検証する。

#### ステップ2：キャッシュパージ（SQLite未変更）
- `SqliteCachedAssets.invalidate` および（内蔵サイト有効時は）`SiteCachedPages.invalidate` を実行する。
- まだSQLiteを更新する前にパージを行うため、万一パージがレート制限や一時障害で失敗した場合は、そのままエラーを返して終了できる。
- その場合でも **SQLiteは1ミリも変更されていない** ため、番組は更新前の正常な状態のまま維持され、パージされたキャッシュもアクセス時に更新前のSQLite状態から自動的に再生成される。

#### ステップ3：単一の同期SQLiteトランザクション（`storage.transactionSync`）による即時コミット
- ステップ1・2が成功したら、単一の `storage.transactionSync(() => { ... })` 内で以下を一括更新する。
  1. エピソード公開時は `publication_episode_site_ids` に短縮URL（`site_id`）を確定登録する。
  2. `publication_shows`（`state_version`, `feed_generation`, `lifecycle`）、`publication_show_content`、`publication_show_revisions`（または `publication_episodes`, `publication_episode_content`, `publication_episode_revisions`, `publication_media`）を更新する。
  3. 同一 `request_id` の重複送信に対する冪等応答およびCLI互換のため、`publication_jobs` に完了レコード（`state = 'succeeded'`）を記録する。
- トランザクション完了後、即座に `state: "succeeded"` のレスポンスを返す。

### 2.3 エラー時の振る舞い（`blocked` が存在しない理由）
- **入力不正（スキーマ違反、GUID重複、ベース世代不一致など）**:
  - SQLiteのコンテンツテーブルは変更せず、エラー（または `state: "failed"`）を返す。後続の別操作をブロックしない。
- **一時的な外部I/O失敗（R2の一時エラー、キャッシュパージ失敗、Worker再起動）**:
  - ステップ3（SQLiteトランザクション）に到達する前に失敗するため、SQLiteの状態は一切変化しない。
  - ジョブが `running` や `blocked` として残ることがないため、Showがロックされることはなく、そのまま同じコマンドを再実行すれば完了する。

---

## 3. RSSフィードとWebサイトHTMLのオンデマンド生成（改善案Bの詳細設計）

### 3.1 RSSフィード（`/podcasts/<showId>/feed.xml`）の配信とキャッシュ

1. **Gatewayでの判定（`serveSqliteGateway` → `show.delivery()`）**:
   - リクエストが来ると、Show DOの `delivery("/podcasts/<showId>/feed.xml")` が同期SQLite読み取りでShowの公開状態を確認する。
   - 非公開（`draft` / `unpublished`）なら `404`、削除済み（`deleted`）なら `410`、サービス停止中なら `503` を返す。
   - 公開中（`published`）なら、`cache_props: { showGeneration: show.state_version, feedGeneration: show.feed_generation }` を返す。
2. **キャッシュ層の実行（`SqliteCachedAssets.fetch`）**:
   - キャッシュヒット時は、Edgeキャッシュから即座にレスポンスが返る。
   - キャッシュミス時：
     - `asset.kind === "cover"` または `"audio"` の場合は、従来通り `env.CASTLOOP_BUCKET`（R2）からバイナリを配信する。
     - `asset.kind === "feed"` の場合は、R2ではなく **Show DOの `renderFeed(props)` RPCメソッド** を呼び出す。
3. **Show DOでのオンデマンドXML生成（`show.renderFeed(props)`）**:
   - Show DOは `storage.transactionSync` で現在の `state_version` と `feed_generation` が `props` と一致していることを確認する。
   - `publication_show_content`、`publication_episode_content`（公開中エピソード一覧）、`publication_episode_site_ids` からデータを読み出し、`src/feed.ts` の `renderFeed()` でRSS 2.0 XML文字列を生成する。
   - 生成したXMLバイト列のSHA-256から強いETag（`"<sha256>"`）を計算し、最新リビジョンの `updated_at` を `Last-Modified` としてレスポンスを組み立てる（条件付きリクエスト `304` / `412` や `HEAD` にも対応）。

### 3.2 WebサイトHTML（`/podcasts/<showId>/`, `/page/<n>/`, `/<siteId>`）の配信とキャッシュ

1. **Gatewayでの判定（`serveSiteGateway` → `show.siteDelivery(page)`）**:
   - リクエストが来ると、Show DOの `siteDelivery(page)` がSQLiteの現在値テーブルを直接参照して判定する（旧 `publication_site_state` や `publication_site_pages` テーブルは参照しない）。
   - Showが公開中かつ `metadata.site_mode === "builtin"` であることを確認する（外部サイトモードなら `404`）。
   - 一覧ページ（`kind === "listing"`）の場合：公開中エピソード件数から総ページ数 `Math.max(1, Math.ceil(count / SITE_PAGE_SIZE))` を算出し、範囲外なら `404`、範囲内なら `{ status: 200, props: { generation: show.feed_generation, showGeneration: show.state_version } }` を返す。
   - 個別エピソードページ（`kind === "episode"`）の場合：`publication_episode_site_ids` から `episode_id` を引き、`publication_episodes` の状態を確認する（未存在・非公開なら `404`、削除済みなら `410`）。公開中なら `{ status: 200, props: { generation: show.feed_generation, showGeneration: show.state_version, episodeGeneration: episode.lifecycle_version } }` を返す。
2. **キャッシュ層の実行（`SiteCachedPages.fetch`）**:
   - キャッシュヒット時は、Edgeキャッシュから即座にHTMLが返る。
   - キャッシュミス時は、R2ではなく **Show DOの `renderSitePage(page, props)` RPCメソッド** を呼び出す。
3. **Show DOでのオンデマンドHTML生成（`show.renderSitePage(page, props)`）**:
   - Show DOは現在の世代が `props` と一致していることを確認した上で、対象ページの描画に必要なデータだけをSQLiteから取得する。
   - 一覧ページなら `renderSiteListing()`、個別エピソードページなら `renderSiteEpisode()`（`src/site-renderer.ts`）を呼び出してHTML文字列を生成する。
   - `siteCssHash(metadata.site_css)` からCSPヘッダ（`Content-Security-Policy`）を生成し、HTMLのSHA-256をETagとして `200` / `304` レスポンスを返す。

### 3.3 独自ドメイン変更（`SqliteDomainRuntime`）の簡素化
- 従来は独自ドメインの追加・解除時に、Show DOのAlarmで全HTMLページのバッチ再生成とR2への `feeds/<gen>.xml` 書き込みを行っていた。
- オンデマンド生成化により、HTMLやFeedのURLは常に最新の `config.public_base_url` から動的に描画されるため、ドメイン変更時のサイトバッチ生成とR2 Feed書き込みを廃止し、カバー画像の確認・キャッシュパージ・`feed_generation` の更新のみで即座に完了させる。

---

## 4. SQLiteスキーマとテーブル構成の整理（フェーズ1）

### 4.1 フェーズ1で完全に廃止するテーブル（6テーブル）
- `publication_site_builds`
- `publication_site_sources`
- `publication_site_candidates`
- `publication_site_pages`
- `publication_site_state`
- `publication_feed_generations`

### 4.2 フェーズ1で簡素化するテーブル
- `publication_jobs`:
  - `queued`, `running`, `blocked`, `continuation_ready` を廃止し、完了した結果（`succeeded` / `failed`）の記録のみに限定する。
  - 公開中の配信を守るために存在していた10個の `read_*` カラム（`read_feed_generation`, `read_show_version`, `read_episode_id`, `read_request_sha256`, `read_verified`, `read_episode_state`, `read_episode_revision_id`, `read_episode_lifecycle_version`, `read_target_kind`, `read_cover_generation`）および `delivery_policy` を削除する。

### 4.3 そのまま維持するコアテーブル
- `publication_shows`, `publication_show_content`, `publication_show_revisions`
- `publication_episodes`, `publication_episode_content`, `publication_episode_revisions`, `publication_media`
- `publication_episode_site_ids`（短縮URLハッシュの永続マッピング）
- `publication_schedules`, `publication_schedule_events`（予約公開）
- `delivery_stats_*`（配信統計）

---

## 5. 変更対象ファイルと実装ステップ

### 5.1 廃止・削除するファイル
- `src/sqlite-site-content.ts` および `src/sqlite-site-content.test.ts`（R2サイトバッチ生成テーブル管理）
- `src/site-publication.ts`（公開Executorへのサイトバッチラッパー）
- `src/sqlite-feed-generations.ts` および `src/sqlite-feed-generations.test.ts`（R2 Feed世代予約テーブル）
- `src/sqlite-publication-alarm.ts` および `src/sqlite-publication-alarm.test.ts`（非同期公開ジョブAlarm）

### 5.2 改修するファイル
1. **`src/sqlite-publication-content.ts`**:
   - `publication_site_*` / `publication_feed_generations` / `committedReadBoundary()` / `requireRunning()` への依存を除去。
   - `delivery()` と `siteDelivery()` を、コミット済みの `publication_shows` / `publication_episodes` / `publication_episode_site_ids` からの直接判定に簡素化。
   - オンデマンド描画メソッド（`renderFeed()`, `renderSitePage()`）を追加。
2. **`src/sqlite-publication-executor.ts`**:
   - 非同期3分割（`validate` / `publish` / `commit`）を統合し、同期リクエスト内で「①検証・メディア冪等R2配置 → ②キャッシュパージ → ③単一 `transactionSync` コミット」を実行する関数に刷新。
   - `show.toml`, `metadata.toml`, `revisions/*.toml`, `feeds/*.xml` のR2書き込みと `requireAbsent` / `requireEmpty` を削除。
3. **`src/sqlite-publication-queue.ts` & `src/sqlite-publication-http.ts`**:
   - `running` / `blocked` / `read_*` カラムを廃止し、公開リクエスト受信時にその場でExecutorを実行して `succeeded`（または検証エラー時 `failed`）を返す同期実行モデルに変更。
4. **`src/sqlite-publication-schedules.ts`**:
   - `dispatchDue()` でキューへの `queued` 投入ではなく、同期公開処理を直接実行して完了させる。
5. **`src/lifecycle-cache.ts` & `src/site-cache.ts` & `src/sqlite-worker.ts`**:
   - `SqliteCachedAssets`（`feed.xml` の場合）と `SiteCachedPages` が、R2ではなくShow DOの `renderFeed()` / `renderSitePage()` を呼び出してレスポンスを生成・キャッシュするよう更新。
   - Show DOの `alarm()` から `SqlitePublicationAlarm` の呼び出しを削除し、予約公開とランタイム保守のみにする。
6. **`src/sqlite-domain-runtime.ts`**:
   - ドメイン変更Alarm内のサイトバッチ生成とR2 Feed書き込みを廃止し、カバー確認・キャッシュパージ・世代更新のみに簡素化。

### 5.3 検証計画
- `bun test` と `npm run check` を実行し、以下を重点的に確認する：
  - Show公開・Episode公開・リビジョン復元・非公開化（unpublish）・再公開（restore）が1回のリクエストで即座に `succeeded` になること。
  - R2やキャッシュパージの一時失敗時にSQLiteが一切変更されず、`blocked` 状態にならず、そのまま再実行で成功すること。
  - `/podcasts/<showId>/feed.xml`、`/podcasts/<showId>/`、`/podcasts/<showId>/page/<n>/`、`/podcasts/<showId>/<siteId>` がR2上のHTML/XMLファイルなしでSQLiteから正しくオンデマンド生成・キャッシュ配信されること（ETag / 304 / HEAD / CSP / 404 / 410 含む）。
  - 予約公開（`schedules.dispatchDue()`）が予定時刻のAlarmで即座に公開完了すること。
