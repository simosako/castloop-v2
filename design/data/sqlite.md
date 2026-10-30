# SQLite表設計

SQLiteはDurable Objectごとに独立しています。本書では、サービスの識別、番組の現在内容、履歴、予約、ドメイン、統計の順に、21種類のアプリケーション用テーブルを説明します。処理の流れは[Show DO](../components/show-do.md)と[制御DO](../components/control-do.md)を参照してください。

## 配置と表一覧

| 表 | 制御DO | Show DO | 用途 |
| --- | --- | --- | --- |
| `publication_queue_schema` | 作成 | 作成 | 公開基盤の形式版 |
| `publication_service` | 使用 | 使用 | サービス・設定の識別 |
| `publication_schedules` | 空の共通表 | 使用 | 予約公開 |
| `publication_schedule_events` | 空の共通表 | 使用 | 予約操作・実行イベント |
| `publication_content_schema` | 作成 | 作成 | コンテンツ形式版 |
| `publication_shows` | 空の共通表 | 使用 | Show公開状態・世代 |
| `publication_show_content` | 空の共通表 | 使用 | 現在のShow内容 |
| `publication_episodes` | 空の共通表 | 使用 | Episode公開状態・現在版 |
| `publication_episode_content` | 空の共通表 | 使用 | 現在のEpisode内容 |
| `publication_media` | 空の共通表 | 使用 | 承認済み音声参照 |
| `publication_show_revisions` | 空の共通表 | 使用 | Show内容の履歴 |
| `publication_episode_revisions` | 空の共通表 | 使用 | Episode内容の履歴 |
| `publication_site_ids` | 空の共通表 | 使用 | Episodeとサイト短縮IDの対応 |
| `publication_domain_changes` | 使用 | 使用 | 各DOのドメイン変更記録 |
| `service_show_registry` | 使用 | 作成しない | サービスのShow登録簿 |
| `service_domain_connection` | 使用 | 作成しない | 最終確定した独自ドメイン接続 |
| `publication_show_binding` | 作成しない | 使用 | DOとShowの固定対応 |
| `publication_delivery_stats_schema` | 作成しない | 作成 | 統計形式版 |
| `publication_delivery_stats_meta` | 作成しない | 使用 | 計測・保持期限情報 |
| `publication_episode_daily_stats` | 作成しない | 使用 | 日別の観測集計 |
| `publication_episode_pruned_totals` | 作成しない | 使用 | 整理済み日別集計の累計 |

制御DOにも共通の初期化処理で内容・予約の表が作られます。実際の番組データは、それぞれのShow DOに保存します。

### 表記

- 型はSQLiteの宣言型 `INTEGER` / `TEXT` で示します。`*_ms` はUnix時刻のミリ秒、`*_date_utc` は `YYYY-MM-DD` です。
- キー以外の列は、NULL許容と記載した列を除き `NOT NULL` です。既定値は記載したものを使います。
- 単独の `TEXT PRIMARY KEY` はDDLで `NOT NULL` を併記していません。複合主キーの列は明示的に `NOT NULL` とし、単独の `INTEGER PRIMARY KEY` はSQLiteの行識別子になります。入力スキーマでもキーを検証します。
- JSONは `TEXT` で保存し、読み書き時に構造・ハッシュ・関連する値を検証します。
- 表間の整合性は、アプリケーションによる対象照合とトランザクションで維持します。DDL上の外部キー制約はありません。

## 識別・形式版

| 表 | カラム | キー・制約 |
| --- | --- | --- |
| `publication_queue_schema` | `id INTEGER`、`version INTEGER` | `id` 主キー、`CHECK(id = 1)`。形式版14 |
| `publication_content_schema` | `id INTEGER`、`version INTEGER` | 同上。形式版13 |
| `publication_delivery_stats_schema` | `id INTEGER`、`version INTEGER` | 同上。形式版1 |
| `publication_service` | `id INTEGER`、`service_id TEXT`、`service_config_sha256 TEXT` | `id` 主キー、`CHECK(id = 1)` |

初期化時に形式版を照合し、不一致なら保存データを維持してエラーにします。

`publication_service` はサービスIDと設定ハッシュを保持します。稼働Worker版はversion metadataから取得します。設定ハッシュはドメイン変更で更新し、コードだけの配備では維持します。

## Show登録とサービス接続

| 表 | カラム | キー・制約 |
| --- | --- | --- |
| `service_show_registry` | `show_id TEXT`、`reservation_id TEXT`、`request_json TEXT`、`state TEXT` | 主キー `show_id`、UNIQUE `reservation_id`、状態は `requested` / `registered` |
| `service_domain_connection` | `id INTEGER`、`connection_json TEXT` | 主キー `id`、`CHECK(id = 1)` |
| `publication_show_binding` | `id INTEGER`、`show_id TEXT`、`reservation_id TEXT`、`registration_json TEXT` | 主キー `id`、`CHECK(id = 1)` |

`reservation_id` は制御DOの登録とShow DOの初期化を結び付けます。同じShow IDに異なる登録IDが指定された場合は競合になります。`service_domain_connection` は独自ドメインの接続中に行を持ち、削除の最終確定時に行を除去します。

## 現在の公開内容

### `publication_shows`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`reservation_id`、`lifecycle` |
| `INTEGER` | `state_version`、`feed_generation` |

主キーは `show_id`、`reservation_id` はUNIQUEです。`lifecycle` のCHECKは `draft` / `published` / `unpublished` / `deleted` です。登録時は `draft` とし、状態版・Feed世代を0で始めます。

### `publication_show_content`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`metadata_json`、`cover_extension`、`cover_sha256` |
| `INTEGER` | `cover_generation`、`cover_length_bytes` |

主キーは `show_id` です。Show本体と1対1で対応し、初回公開時に作成します。カバーのCHECKは、拡張子が `jpg` / `png`、世代が正、サイズが1〜5,000,000バイトです。

### `publication_episodes`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`episode_id`、`lifecycle`、`revision_id` |
| `INTEGER` | `lifecycle_version`（既定0） |

主キーは `(show_id, episode_id)` です。`revision_id` はNULLを許容します。状態のCHECKは `published` / `unpublished` / `deleted` です。現在内容・履歴とのリビジョンの一致はアプリケーションで検査します。

### `publication_episode_content`

カラムは `show_id TEXT`、`episode_id TEXT`、`guid TEXT`、`revision_json TEXT` です。主キーは `(show_id, episode_id)`、`(show_id, guid)` はUNIQUEです。これにより、同じShow内のGUID重複を防ぎます。

`revision_json` は、Episodeメタデータに音声URL・ハッシュ・長さ・リビジョンIDなどを加えた[保存形式](schemas.md)です。

### `publication_media`

カラムは `show_id TEXT`、`episode_id TEXT`、`audio_revision_id TEXT`、`sha256 TEXT`、`length_bytes INTEGER` です。主キーは `(show_id, episode_id, audio_revision_id)` です。

公開音声URLをR2のハッシュ付きキーに対応付けます。同じ音声を使う場合は行を再利用し、音声差し替えでは新しい行を追加します。以前の行も保持するため、旧音声URLを解決できます。

### `publication_site_ids`

カラムは `show_id TEXT`、`episode_id TEXT`、`site_id TEXT` です。主キーは `(show_id, episode_id)`、`(show_id, site_id)` はUNIQUEです。公開内容と同じトランザクションで対応を保存し、個別ページの固定URLに使います。

## リビジョン履歴

履歴は現在内容の切り替えと同じトランザクションで追加します。過去版を採用した場合も新しい行を作り、採用元を `restored_from_revision_id` に記録します。

### `publication_show_revisions`

| 用途 | 型 | カラム |
| --- | --- | --- |
| 識別 | `TEXT` | `show_id`、`revision_id` |
| 版・世代 | `INTEGER` | `revision_sequence`、`state_version`、`cover_generation` |
| メタデータ | `TEXT` | `metadata_json`、`metadata_sha256` |
| カバー | `TEXT` | `cover_extension`、`cover_sha256` |
| カバーサイズ | `INTEGER` | `cover_length_bytes` |
| 採用元・日時 | `TEXT` | `restored_from_revision_id`、`updated_at` |

主キーは `(show_id, revision_sequence)` です。`revision_id` と `(show_id, revision_id)` にUNIQUE制約があります。連番・状態版・カバー世代は正、ハッシュ長は64、拡張子は `jpg` / `png`、カバーサイズは1〜5,000,000バイトのCHECKを持ちます。

### `publication_episode_revisions`

| 用途 | 型 | カラム |
| --- | --- | --- |
| 識別 | `TEXT` | `show_id`、`episode_id`、`revision_id`、`audio_revision_id` |
| 連番 | `INTEGER` | `revision_sequence` |
| 内容 | `TEXT` | `metadata_sha256`、`revision_json` |
| 採用元・日時 | `TEXT` | `restored_from_revision_id`、`updated_at` |

主キーは `(show_id, episode_id, revision_sequence)` です。`revision_id` と `(show_id, episode_id, revision_id)` にUNIQUE制約があります。連番が正、メタデータハッシュ長が64のCHECKを持ちます。

両表とも、NULLを許容するのは `restored_from_revision_id` だけです。`revision_sequence` は、Show履歴ではShowごと、Episode履歴ではShow・Episodeごとの連番です。

## 予約とイベント

### `publication_schedules`

| 用途 | 型 | カラム |
| --- | --- | --- |
| 連番・版 | `INTEGER` | `sequence`、`version` |
| 対象 | `TEXT` | `schedule_id`、`show_id`、`kind`、`episode_id` |
| 状態 | `TEXT` | `state`、`reason_code`、`revision_id` |
| 公開要求 | `TEXT` | `preview_sha256`、`request_sha256`、`request_json` |
| 解決済み時刻 | `TEXT` | `scheduled_at`、`timezone`、`timezone_source`、`resolution_source` |
| 入力時刻と解釈 | `TEXT` | `local_input`、`local_datetime`、`local_offset`、`input_offset` |
| 実行予定・記録日時 | `INTEGER` | `scheduled_at_ms`、`created_at_ms`、`updated_at_ms` |
| 完了・取消日時 | `INTEGER` | `dispatched_at_ms`、`cancelled_at_ms` |

主キーは `sequence INTEGER PRIMARY KEY AUTOINCREMENT`、`schedule_id` はUNIQUEです。NULL許容列は `episode_id`、`reason_code`、`input_offset`、`revision_id`、`dispatched_at_ms`、`cancelled_at_ms` です。

CHECKで次を制約します。

- `kind` は `show` / `episode`、`version > 0`。
- `state` は `scheduled` / `needs_approval` / `dispatched` / `cancelled` / `failed`。
- Show予約では `episode_id IS NULL`、Episode予約では非NULL。
- `dispatched` と実行日時の存在、`cancelled` と取消日時の存在がそれぞれ同値。

`request_json` は、素材参照と更新元を含む直接公開要求です。日時の入力・解決元・オフセットも保存することで、指定したローカル時刻をどのUTC時刻として承認したかを確認できます。

### `publication_schedule_events`

カラムは `sequence INTEGER`、`schedule_id TEXT`、`version INTEGER`、`action TEXT`、`state TEXT`、`reason_code TEXT`、`request_sha256 TEXT`、`recorded_at_ms INTEGER` です。主キーは `sequence INTEGER PRIMARY KEY AUTOINCREMENT`、NULL許容列は `reason_code` です。

`action` のCHECKは `create` / `reschedule` / `cancel` / `reapprove` / `dispatch` / `suspend` / `fail` です。操作時の予約版・状態・要求ハッシュを追記します。予約変更とイベント追加、公開と実行イベント追加は、それぞれ同じトランザクションで行います。

### 明示的インデックス

| 名前 | 定義・用途 |
| --- | --- |
| `publication_one_open_schedule` | UNIQUE `(show_id, kind, COALESCE(episode_id, ''))`、`state IN ('scheduled', 'needs_approval')` の部分インデックス。同じ対象の未完了予約を1件に限定 |
| `publication_schedules_due` | `(state, scheduled_at_ms, sequence)`。実行順で予約を取得 |
| `publication_schedule_events_schedule` | `(schedule_id, sequence)`。予約別のイベント取得 |

## ドメイン変更

`publication_domain_changes` は `operation_id TEXT`、`request_json TEXT`、`request_sha256 TEXT`、`commit_json TEXT`、`state TEXT` を持ちます。主キーは `operation_id`、NULL許容列は `commit_json`、状態のCHECKは `prepared` / `completed` です。

`publication_one_domain_change` は、定数式 `((1))` に対する `state != 'completed'` の部分UNIQUEインデックスです。同じDO内の未完了変更を1件に制限します。

同じ変更要求を制御DOと各Show DOに保存します。要求JSONは変更前後の設定、確定JSONは配備・接続の確認情報を持ちます。各DOは設定と `completed` を同じトランザクションで更新します。DO間の確定順序は[ドメイン変更](../components/control-do.md)を参照してください。

## 配信統計

### `publication_delivery_stats_meta`

| カラム | 型・既定値・CHECK |
| --- | --- |
| `id` | `INTEGER PRIMARY KEY`、1に限定 |
| `measurement_started_at_ms` | `INTEGER`、0以上 |
| `measurement_started_date_utc` | `TEXT`、長さ10 |
| `retained_from_date_utc` | `TEXT`、長さ10 |
| `last_pruned_date_utc` | NULL可の `TEXT`、非NULLなら長さ10 |
| `retention_days` | `INTEGER DEFAULT 400`、30〜3650 |
| `recording_error_count` | `INTEGER DEFAULT 0`、0以上 |
| `last_recording_error_at_ms` | NULL可の `INTEGER`、非NULLなら0以上 |

日付の実在性はアプリケーションで検証します。日別照会では `retained_from_date_utc` を保持範囲の境界とし、整理待ちの行もその境界に従って扱います。

### 日別・整理済み累計

| 表 | キーカラム | 主キー |
| --- | --- | --- |
| `publication_episode_daily_stats` | `episode_id TEXT`、`date_utc TEXT`、`audio_revision_id TEXT` | `(episode_id, date_utc, audio_revision_id)` |
| `publication_episode_pruned_totals` | `episode_id TEXT`、`audio_revision_id TEXT` | `(episode_id, audio_revision_id)` |

両表は `WITHOUT ROWID` です。日別表の `date_utc` は長さ10のCHECKを持ちます。共通のカウンタはすべて `INTEGER NOT NULL DEFAULT 0 CHECK(値 >= 0)` です。

| カウンタ | 観測内容 |
| --- | --- |
| `get_200_requests` | 通常の音声GET |
| `get_206_requests` | Rangeによる音声GET |
| `initial_downloads` | 本編取得開始 |
| `response_bytes` | 通常GETの応答バイト数 |
| `probe_range_requests` | 微小Range確認 |
| `head_requests` | 成功HEAD |
| `not_modified_requests` | 本文なし304 |
| `bot_get_requests` | BotのGET |
| `bot_response_bytes` | Botの応答バイト数 |

さらに `updated_at_ms INTEGER NOT NULL CHECK(値 >= 0)` を持ちます。`audio_get_requests`、`equivalent_full_downloads`、`lifetime` は照会時に計算します。

明細の整理は、累計への加算と日別行の削除を同じトランザクションで行います。Show IDはDOの固定対象から取得します。

## 更新と参照の関係

```text
制御DOの登録簿 ──登録IDの照合── Show DOの固定対応
                                     │
                                  Show状態
                                     │
                       現在Show内容 ─ Show履歴
                                     │
                      Episode状態 ─ 現在Episode内容 ─ Episode履歴
                          │                 │
                       短縮ID           承認済み音声 ─ 日別統計・累計

予約 ──保存した公開要求── 公開確定と実行イベント
各DOのドメイン変更 ──要求・確定情報── 設定ハッシュ
```

図は論理的な関連を示しています。主な更新単位は次のとおりです。

| 処理 | 同じトランザクションで更新するデータ |
| --- | --- |
| 公開 | 現在内容、履歴、短縮ID、世代番号 |
| 予約実行 | 公開内容の更新と、予約結果・イベント |
| 非公開化・再公開 | 公開状態と関連する版・世代番号 |
| 統計明細の整理 | 整理済み累計への加算と、日別行の削除 |

非公開化後も、内容・履歴・音声参照を保持します。

## DDLの定義元

- [公開基盤・予約](../../src/sqlite-publication-queue.ts)、[内容・履歴](../../src/sqlite-publication-content.ts)、[短縮ID](../../src/sqlite-site-ids.ts)
- [制御DO固有表](../../src/sqlite-service-control.ts)、[Show固定対応](../../src/sqlite-show-service.ts)、[ドメイン変更](../../src/sqlite-domain-runtime.ts)
- [統計](../../src/sqlite-delivery-stats.ts)、[形式版と稼働設定の確認](../../src/sqlite-runtime-identity.ts)
