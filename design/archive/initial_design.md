# castloop v2 全体設計（再編前の要約）

> 履歴資料。現行設計は[開発者向け設計索引](../README.md)と[全体アーキテクチャ](../architecture.md)を参照する。本文は再編前の要約として保持し、現在の実環境操作の許可には使わない。

最終更新: 2026-10-30（フェーズ1〜4 簡素化完了版、内部queue/content形式 `14/13`）

- 関連設計: [全体設計の見直し](architecture_simplification_review_20261028.md)、[フェーズ1](phase1_atomic_publication_and_ondemand_delivery_plan.md)、[フェーズ2](phase2_direct_media_and_cli_simplification_plan.md)、[フェーズ3](phase3_deploy_and_runtime_control_simplification_plan.md)、[フェーズ4](phase4_code_and_test_cleanup_plan.md)、[Show単位のDO分離](do_show_separation_options.md)
- 利用ガイド: [README](../../README.md)、[SQLite開発・運用ガイド](../../docs/sqlite_sequential_development.md)、[番組サイト](../../docs/show_website.md)、[予約公開・管理設定](../../docs/admin_configuration.md)、[独自ドメイン](../../docs/sqlite_custom_domains.md)、[配信統計](../../docs/delivery_statistics.md)、[バックアップ](../../docs/workspace_backup.md)
- 旧版設計の保存先: [v0.7.6以前の非同期ジョブ・R2スナップショット設計](initial_design_v076.md)、[v0.5.2以前のQueue方式設計](initial_design_v052.md)

---

## 1. アーキテクチャの概要と責務分担

`castloop` は、管理者自身の Cloudflare アカウント上に配備するサーバーレスの Podcast ホスティング基盤である。1つのサービスにつき **1個の非公開 R2 バケット** と **1個の Cloudflare Worker（SQLite-backed Durable Objects を内包）** を使用し、単一のスタンドアロン CLI バイナリから管理する。Cloudflare Queues や D1 は使用しない。

```text
CLI: ローカルTOML・素材の検証 → 初回・変更された音源・画像のみ R2 (audio/<sha256>.mp3, covers/<sha256>.jpg|png) へ直接PUT
  → POST /admin/sqlite-publication/publish でメタデータと素材参照を Show DO へ送信
Show DO: 入力と現在状態・世代を検証 → 必要なCDNキャッシュパージを実行
  → 単一SQLiteトランザクションで公開内容・リビジョン履歴・短縮URL・世代番号を一括コミット
公開配信: Gateway が Show DO に公開可否と現在世代を照会
  → 音源・カバー画像は SqliteCachedAssets 経由で R2 から配信
  → RSSフィード (feed.xml) と内蔵WebサイトHTMLは Show DO の SQLite からオンデマンド生成してキャッシュ配信
制御DO: Show の登録・一覧管理、およびサービス全体の独自ドメイン接続状態の管理のみを担当
```

### データの正本（Source of Truth）

| 保存場所 | 保持するデータ | 役割と不変条件 |
| --- | --- | --- |
| **ローカルワークスペース** | `castloop.toml`, `castloop-admin.toml`, `<show>/show.toml`, `<show>/episode-*.toml`, メディア原本, `.castloop/` | 管理者の編集元。`.castloop/` には管理者キー（`secrets.json`）と最小限のローカル管理ジャーナル（`init`, `create-show`, `domain`, `rss-import`）を保持する |
| **非公開 R2 バケット** | `public/podcasts/<showId>/audio/<sha256>.mp3`<br>`public/podcasts/<showId>/covers/<sha256>.jpg\|png`<br>`system/service.toml` | コンテンツハッシュ（SHA-256）をキーとする不変メディアオブジェクトとサービス設定のみを保持する。ステージング領域（`staging/`）や RSS/HTML の事前生成スナップショットは置かない |
| **Show DO SQLite**<br>(`show/<service_id>/<show_id>`) | 公開済み Show/Episode メタデータ、リビジョン履歴、短縮URL対応表、予約公開（Schedule）、日別・通算の配信統計 | 各番組（Show）の独立した正本。公開・更新・ライフサイクル切替はすべて単一トランザクションで原子的に確定する |
| **制御 DO SQLite**<br>(`service/<service_id>`) | 登録済み Show 一覧、独自ドメインの現在状態と切替進行状態 | Show の登録と独自ドメイン管理のみを担う。通常の公開や配信のクリティカルパスには入らない |

---

## 2. バージョン境界と互換性ポリシー

- **サービス設定**: `schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`、`storage_layout = "show-v1"` が必須。旧スキーマ（version 1）や `storage_layout` 欠落は、通信やローカル状態作成の前に拒否する。
- **内部データベース形式**: 新規環境専用の `SQLITE_QUEUE_SCHEMA_VERSION = 14`、`SQLITE_CONTENT_SCHEMA_VERSION = 13`。過去のバージョン（v0.5.x〜v0.7.6）からのマイグレーションや既存リソースの採用（Adoption）は行わない。
- **コンテンツ・リクエストスキーマ**: Show/Episode の TOML メタデータや管理 API リクエストの `schema_version = 1` はサービス設定バージョンとは独立しており、そのまま維持する。
- **Worker エントリポイント**: 本番 Worker は `src/sqlite-worker.ts` のみ。Durable Object クラス名（`SqlitePublicationService`）、キャッシュクラス名（`SqliteCachedAssets`, `SiteCachedPages`）、バインディング名、Compatibility Date は維持する。

---

## 3. 公開・更新・ライフサイクルの仕組み

### 3.1 直接メディア配置と同期アトミック公開

1. **明示的な公開**: `create-show` や `create-episode`、`preview-*` だけでは公開されない。`publish-show` / `publish-episode` を実行したときだけ公開される。
2. **直接メディア配置（`sqlite-media-upload.ts`）**:
   - MP3 は最大 **300,000,000 bytes（300MB）**、JPEG/PNG カバー画像は最大 **5,000,000 bytes（5MB）**。
   - 通常の`publish-show`／`publish-episode`では素材のSHA-256を1回、MP3解析を1回行い、サイズ・形式も検証する。SHA-256は保存先キーと同一素材の再利用判定に使う。PUT前後の再ハッシュやPUT後の再解析は行わず、実行中は入力ファイルを編集しない。
   - 公開済みリビジョンと SHA-256・サイズが同一のメディアは R2 への通信を行わずそのまま再利用する。新規または変更されたメディアのみ、R2 のコンテンツハッシュキーへ単一 PUT で配置する。
   - アップロード済みの公開音源やカバー画像は、デプロイや更新失敗時を含め削除しない。
3. **同期公開リクエスト（`POST /admin/sqlite-publication/publish`）**:
   - Show DO はリクエストの `service_id`、`service_config_sha256`、`expected_show_state_version`、および Episode の `base_revision_id` / `expected_episode_lifecycle_version` を照合する。ベースリビジョンが進んでいる場合（古いローカル入力）は `409 Conflict` で拒否する。
   - 送信された内容が現在の公開済み状態と完全に同一であれば、履歴追加やキャッシュパージを行わず `result: "unchanged"` と現在の `revision_id` を返す（冪等な no-op）。
   - 変更がある場合は、必要な CDN キャッシュパージ（Feed、カバー画像、該当 Episode、内蔵サイト HTML）を先に完了させた上で、**単一の SQLite トランザクション** でメタデータ・リビジョン履歴・サイト短縮ID・世代番号を更新し、`result: "changed"` と新しい `revision_id` を返す。
   - キャッシュパージや検証が失敗した場合は SQLite トランザクションを実行せずエラーを返すため、`blocked` のような中間停止状態は発生しない。通信中断時は同じコマンドを最初から再実行できる。

### 3.2 公開可否の制御（Lifecycle）と過去リビジョンの復元

- 個別の Pause / Resume コマンドは設けず、公開状態の切り替えはすべて `preview-show-lifecycle` / `preview-episode-lifecycle` と `lifecycle-execute`（`unpublish` / `restore`）で行う。
- `unpublish` は対象を非公開（HTTP `404 Not Found`）にしつつ、R2 上のメディアと SQLite 上のリビジョン履歴を保持する。物理削除は実装しない。
- `list-show-revisions` / `list-episode-revisions`、`preview-*-revision`、`revision-execute` により、過去の保存済みリビジョンをメディアの再アップロードなしで新しいリビジョンとして復元できる。

---

## 4. 公開配信とオンデマンド生成・キャッシュ

公開 URL は承認されたパスのみを許可し、`system/` や `staging/` は一切公開しない。

| パス | 内容 | 配信方式 |
| --- | --- | --- |
| `/podcasts/<showId>/feed.xml` | RSS 2.0 フィード | Show DO の SQLite からオンデマンド生成し、`SqliteCachedAssets` でエッジキャッシュ配信 |
| `/podcasts/<showId>/cover.<jpg\|png>` | Show カバー画像 | Show DO の世代・キー判定後、`SqliteCachedAssets` 経由で R2 から配信 |
| `/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` | Episode 音声 | Show DO の公開可否・`audioRevisionId` 一致判定後、`SqliteCachedAssets` 経由で R2 から Range/HEAD/条件付きリクエスト対応で配信 |
| `/podcasts/<showId>/`<br>`/podcasts/<showId>/page/<n>/`<br>`/podcasts/<showId>/<siteId>/` | 内蔵番組サイト HTML<br>（`site_mode = "builtin"` 時） | Show DO の SQLite から一覧（1ページ20件）または Episode 個別ページ（16文字以上の短縮ハッシュ）をオンデマンド生成し、`SiteCachedPages` でエッジキャッシュ配信 |

- Show が未公開または非公開化（`unpublished`）されている場合は `404 Not Found`、個別に非公開化したEpisodeのページ・音声も `404` を返す。独自ドメイン変更の進行中（`publication_ready: false`）は `503 Service Unavailable`（`Cache-Control: no-store`）を返す。内部に残る `deleted` 判定は `410 Gone` だが、現行CLIは物理削除を提供しない。
- 独自ドメイン運用時、管理用オリジン（`workers.dev`）の公開パスへのアクセスは独自ドメインの正規 URL へリダイレクトする（Feed は `301`、メディア・サイト HTML は `307`）。逆に、独自ドメイン上の `/admin/*` パスはすべて `404` で拒否する。
- 生成したFeed/HTMLは本文のETagで条件付き応答を判定し、`Last-Modified`を送らない。音声・画像にはR2の更新時刻も使う。サイト一覧は対象ページの最大20件、個別ページは対象1件の公開内容と短縮IDだけをSQLiteから読み出す。

---

## 5. 周辺機能の設計

### 5.1 Episode・Show の予約公開（Schedule）
- 詳細は [Episode予約公開の設計](episode_scheduled_publication_plan.md) および [管理用設定ガイド](../../docs/admin_configuration.md) を参照。
- メディアを先に R2 へ配置した上で、未来の UTC 日時を指定して Show DO の `publication_schedules` テーブルに予約を登録する。
- Show DO の Alarm は最も早い予約時刻に合わせて設定され、時刻到来時に `dispatchDue()` が通常の公開処理と同一のトランザクションで公開と `dispatched` 状態への遷移を確定する。
- 予約時刻前にベースリビジョンが変更された場合や独自ドメイン変更中だった場合は、自動実行せず `needs_approval` 状態へ移し、管理者の明示的な `schedule-reapprove` を要求する。

### 5.2 配信統計（Delivery Statistics）
- 詳細は [配信統計の設計](episode_delivery_statistics_plan.md) および [利用ガイド](../../docs/delivery_statistics.md) を参照。
- Gateway で音声レスポンス（`200` / `206` / `304` / `HEAD`）が確定した際、`ctx.waitUntil` で非同期に Show DO の日別集計テーブルへ加算する。統計記録の失敗が音声配信を妨げることはない。
- IP アドレス、Cookie、User-Agent 原文などの個人情報は保存せず、既知の Bot 判定（真偽値）とリクエスト種別・転送バイト数のみを集計する。
- 日別明細の保持日数（既定400日、30〜3650日）を超えた行は日次バッチで削除されるが、削除分は通算累計（`lifetime`）テーブルに合算して保持される。`castloop stats-retention <show> <days>` で保持日数を冪等に変更できる。

### 5.3 デプロイ（`deploy`）と独自ドメイン変更（`domain`）
- 詳細は [フェーズ3設計](phase3_deploy_and_runtime_control_simplification_plan.md)、[フェーズ4設計](phase4_code_and_test_cleanup_plan.md)、[独自ドメイン利用ガイド](../../docs/sqlite_custom_domains.md) を参照。
- **通常のコード更新（`castloop deploy`）**: 設定（`castloop.toml`）を変更しない同一サービスの Worker 更新は、事前の Show 停止やローカルジャーナルを必要とせず、現在の Cloudflare 側の設定・ドメイン接続・名前空間を API で確認した上で `system/service.toml` と Worker スクリプトを更新し、`health` を確認する単発の冪等操作として動作する。
- **独自ドメインの追加・削除（`castloop domain add|remove|continue|status|list`）**:
  - 変更前の設定（`previous_config`）と変更後の設定（`target_config`）をローカルジャーナル（6フェーズ: `prepared` → `connected` → `deployed` → `remote_ready` → `local_synced` → `completed`）に保存して進める。
  - 準備（`prepare`）からコミット（`commit`）までの間は公開配信を HTTP 503 でゲートし、全 Show DO で必要なキャッシュパージが完了してから新しい公開 URL での配信を解禁する。
  - DNS/TLS 待機や通信中断で停止した場合は、`castloop domain continue <operation_id>` により API の現在状態を確認して未完了ステップから安全に再開できる。

### 5.4 RSS インポートとワークスペースバックアップ
- **RSS インポート**: [RSS取り込み設計](m7_rss_import_plan.md) および [利用ガイド](../../docs/rss_migration.md) を参照。既存フィードからローカルへメタデータとメディアをダウンロードして検証・プレビューした後、新規 Show として GUID と公開日時を維持したまま順次公開する。
- **ローカル操作**: workspaceまたは取り込みディレクトリごとに、変更するCLIは一度に1プロセスだけ実行する。記録は一時ファイルから原子的に置換し、ロックファイルは使わない。RSS公開記録はversion 3のみ対応し、旧version 2用の処理は保持しない。ローカル配置の完了記録がない場合は、確認済み取り込み元から生成ファイルをすべて作り直す。取り込み元や公開済み内容は削除しない。
- **暗号化バックアップ**: [バックアップ設計](workspace_backup_restore_plan.md) および [利用ガイド](../../docs/workspace_backup.md) を参照。`backup-create` / `backup-verify` / `backup-restore` により、`castloop.toml`、各 Show/Episode の TOML、`.castloop/` 内の管理者キー・ジャーナル、カバー画像（および任意で MP3 原本）をパスフレーズ暗号化された単一アーカイブ（`.clbk`）として保存・検証・復元できる。
