# SQLite表設計

SQLiteはDurable Objectごとに独立する。本書は実際に初期化する全21種類の業務用表を説明する。SQLiteが自動管理する `sqlite_sequence` 等は含めない。処理の流れは[Show DO](../components/show-do.md)と[制御DO](../components/control-do.md)を参照する。

## 配置と表一覧

| 表 | 制御DO | Show DO | 用途 |
| --- | --- | --- | --- |
| `publication_queue_schema` | 作成 | 作成 | 公開基盤の形式版 |
| `publication_service` | 使用 | 使用 | サービス・設定の識別 |
| `publication_schedules` | 空の共通表 | 使用 | 予約公開 |
| `publication_schedule_events` | 空の共通表 | 使用 | 予約操作・実行イベント |
| `publication_content_schema` | 作成 | 作成 | コンテンツ形式版 |
| `publication_shows` | 空の共通表 | 使用 | Show公開可否・世代 |
| `publication_show_content` | 空の共通表 | 使用 | 現在のShow内容 |
| `publication_episodes` | 空の共通表 | 使用 | Episode公開可否・現在版 |
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

制御DOにも共通初期化で内容・予約表が作られるが、Showの公開データはShow DOだけに書き込む。これらの表を制御DOの公開データとして集約する設計ではない。

### 表記

- カラムはSQLiteの宣言型 `INTEGER` / `TEXT` で示す。日時の `*_ms` はUnix時刻のミリ秒、`*_date_utc` は `YYYY-MM-DD`、その他の日時文字列は各スキーマに従う。
- キー以外の列は、各節で挙げるNULL許容列を除き `NOT NULL`。既定値は記載したものだけを定義する。
- 単独の `TEXT PRIMARY KEY` はDDLに `NOT NULL` を併記していない。複合主キーの構成列は明示的に `NOT NULL`、単独の `INTEGER PRIMARY KEY` はSQLiteの行識別子である。管理入力はスキーマでNULLキーを拒否する。
- JSON列は `TEXT` として保存する。構造・ハッシュ・他列との対応は読書き時にアプリケーションが検証する。
- **外部キー制約は定義していない。** 以下の関連は、対象照合とトランザクションによって維持する論理的な関係である。

## 識別・形式版

| 表 | カラム | キー・制約 |
| --- | --- | --- |
| `publication_queue_schema` | `id INTEGER`、`version INTEGER` | `id` 主キー、`CHECK(id = 1)`。形式版14 |
| `publication_content_schema` | `id INTEGER`、`version INTEGER` | 同上。形式版13 |
| `publication_delivery_stats_schema` | `id INTEGER`、`version INTEGER` | 同上。形式版1 |
| `publication_service` | `id INTEGER`、`service_id TEXT`、`service_config_sha256 TEXT` | `id` 主キー、`CHECK(id = 1)` |

形式版が一致しない既存DBは拒否し、表やデータをリセットしない。`publication_service` は設定ハッシュを保持するが、稼働Workerの版は環境のversion metadataから得る。コード配備だけで設定ハッシュを変えず、準備済みドメイン変更を通して更新する。

## Show登録とサービス接続

| 表 | カラム | キー・制約 |
| --- | --- | --- |
| `service_show_registry` | `show_id TEXT`、`reservation_id TEXT`、`request_json TEXT`、`state TEXT` | 主キー `show_id`、UNIQUE `reservation_id`、状態は `requested` / `registered` |
| `service_domain_connection` | `id INTEGER`、`connection_json TEXT` | 主キー `id`、`CHECK(id = 1)` |
| `publication_show_binding` | `id INTEGER`、`show_id TEXT`、`reservation_id TEXT`、`registration_json TEXT` | 主キー `id`、`CHECK(id = 1)` |

`reservation_id` は制御DOの登録とShow DOの初期化を結び付ける。異なる登録IDで同一Showを上書きしない。接続表の行は独自ドメインがある場合だけ保持し、削除の最終確定で除去する。

## 現在の公開内容

### `publication_shows`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`reservation_id`、`lifecycle` |
| `INTEGER` | `state_version`、`feed_generation` |

主キーは `show_id`、`reservation_id` はUNIQUE。`lifecycle` のCHECKは `draft` / `published` / `unpublished` / `deleted`。登録時は状態版・Feed世代とも0で始める。

### `publication_show_content`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`metadata_json`、`cover_extension`、`cover_sha256` |
| `INTEGER` | `cover_generation`、`cover_length_bytes` |

主キーは `show_id`。カバーのCHECKは拡張子 `jpg` / `png`、世代が正、サイズが1〜5,000,000 bytes。Show本体と1対1で、初回公開後に内容を持つ。

### `publication_episodes`

| 型 | カラム |
| --- | --- |
| `TEXT` | `show_id`、`episode_id`、`lifecycle`、`revision_id` |
| `INTEGER` | `lifecycle_version`（既定0） |

主キーは `(show_id, episode_id)`。NULL許容列は `revision_id`。状態のCHECKは `published` / `unpublished` / `deleted`。現在の内容・履歴のリビジョンと整合することをアプリケーションが検査する。

### `publication_episode_content`

カラムは `show_id TEXT`、`episode_id TEXT`、`guid TEXT`、`revision_json TEXT`。主キーは `(show_id, episode_id)`、`(show_id, guid)` がUNIQUE。同じShow内のGUID重複を防ぐ。

`revision_json` はEpisode入力に音声URL・ハッシュ・長さ・リビジョンID等を加えた保存形式であり、編集用Episode TOMLとは異なる。

### `publication_media`

カラムは `show_id TEXT`、`episode_id TEXT`、`audio_revision_id TEXT`、`sha256 TEXT`、`length_bytes INTEGER`。主キーは `(show_id, episode_id, audio_revision_id)`。

公開音声URLをR2のハッシュキーへ対応付ける。メタデータ更新で同じ音声を使うときは行を再利用し、差し替え時は新しい行を追加する。以前の行を消さない。

### `publication_site_ids`

カラムは `show_id TEXT`、`episode_id TEXT`、`site_id TEXT`。主キーは `(show_id, episode_id)`、`(show_id, site_id)` がUNIQUE。公開内容の確定と同じトランザクションで対応を保存する。

## リビジョン履歴

| 表 | `TEXT` カラム | `INTEGER` カラム |
| --- | --- | --- |
| `publication_show_revisions` | `show_id`、`revision_id`、`metadata_json`、`metadata_sha256`、`cover_extension`、`cover_sha256`、`restored_from_revision_id`、`updated_at` | `revision_sequence`、`state_version`、`cover_generation`、`cover_length_bytes` |
| `publication_episode_revisions` | `show_id`、`episode_id`、`revision_id`、`audio_revision_id`、`metadata_sha256`、`revision_json`、`restored_from_revision_id`、`updated_at` | `revision_sequence` |

両表とも `restored_from_revision_id` だけがNULLを許す。

| 表 | キー・CHECK |
| --- | --- |
| Show履歴 | 主キー `(show_id, revision_sequence)`、UNIQUE `revision_id` と `(show_id, revision_id)`。連番・状態版・カバー世代が正、ハッシュ長64、拡張子 `jpg` / `png`、カバーサイズ1〜5,000,000 |
| Episode履歴 | 主キー `(show_id, episode_id, revision_sequence)`、UNIQUE `revision_id` と `(show_id, episode_id, revision_id)`。連番が正、メタデータハッシュ長64 |

履歴は追記し、現在内容の切り替えとまとめて確定する。`revision_sequence` はShowごと、Episode履歴はShow・Episodeごとの連番。過去版採用でも新しい行を追加し、元のIDを `restored_from_revision_id` に記録する。

## 予約とイベント

### `publication_schedules`

| 型 | カラム |
| --- | --- |
| `INTEGER` | `sequence`、`version`、`scheduled_at_ms`、`created_at_ms`、`updated_at_ms`、`dispatched_at_ms`、`cancelled_at_ms` |
| `TEXT` | `schedule_id`、`show_id`、`kind`、`episode_id`、`state`、`reason_code`、`scheduled_at`、`timezone`、`timezone_source`、`resolution_source`、`local_input`、`local_datetime`、`local_offset`、`input_offset`、`preview_sha256`、`request_sha256`、`request_json`、`revision_id` |

主キーは `sequence INTEGER PRIMARY KEY AUTOINCREMENT`、`schedule_id` はUNIQUE。NULL許容列は `episode_id`、`reason_code`、`input_offset`、`revision_id`、`dispatched_at_ms`、`cancelled_at_ms`。

CHECKで次を制約する。

- `kind` は `show` / `episode`、`version > 0`。
- `state` は `scheduled` / `needs_approval` / `dispatched` / `cancelled` / `failed`。
- Show予約では `episode_id IS NULL`、Episode予約では非NULL。
- `dispatched` と実行日時の存在、`cancelled` と取消日時の存在がそれぞれ同値。

`request_json` は素材参照と更新元を含む直接公開要求。日時の入力・解決元・オフセットを残し、UTC時刻だけでは失われる承認時の解釈を保持する。

### `publication_schedule_events`

カラムは `sequence INTEGER`、`schedule_id TEXT`、`version INTEGER`、`action TEXT`、`state TEXT`、`reason_code TEXT`、`request_sha256 TEXT`、`recorded_at_ms INTEGER`。主キーは `sequence INTEGER PRIMARY KEY AUTOINCREMENT`。NULL許容列は `reason_code`。

`action` のCHECKは `create` / `reschedule` / `cancel` / `reapprove` / `dispatch` / `suspend` / `fail`。操作時の予約版・状態・要求ハッシュを追記する。予約変更とイベント追加、公開と実行イベント追加はそれぞれ同一トランザクションで行う。

### 明示的インデックス

| 名前 | 定義・用途 |
| --- | --- |
| `publication_one_open_schedule` | UNIQUE `(show_id, kind, COALESCE(episode_id, ''))`、`state IN ('scheduled', 'needs_approval')` の部分インデックス。同じ対象の未完了予約を1件に限定 |
| `publication_schedules_due` | `(state, scheduled_at_ms, sequence)`。実行順で予約を取得 |
| `publication_schedule_events_schedule` | `(schedule_id, sequence)`。予約別のイベント取得 |

## ドメイン変更

`publication_domain_changes` は `operation_id TEXT`、`request_json TEXT`、`request_sha256 TEXT`、`commit_json TEXT`、`state TEXT` を持つ。主キーは `operation_id`、NULL許容列は `commit_json`。状態のCHECKは `prepared` / `completed`。

`publication_one_domain_change` は定数式 `((1))` に対する、`state != 'completed'` の部分UNIQUEインデックス。同一DO内の未完了変更を1件に制限する。

同じ変更要求を制御DOと各Show DOに保存する。要求JSONは変更前後の設定、確定JSONは配備と接続の証拠を持つ。各DOの設定更新と `completed` は同一トランザクションで確定するが、DO間の同時確定は保証しない。

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

日付の実在性やUTCの意味はアプリケーションで検証する。保持境界より古い日は、物理整理待ちの行があっても日別照会で保持済みと表示しない。

### 日別・整理済み累計

| 表 | キーカラム | 主キー |
| --- | --- | --- |
| `publication_episode_daily_stats` | `episode_id TEXT`、`date_utc TEXT`、`audio_revision_id TEXT` | `(episode_id, date_utc, audio_revision_id)` |
| `publication_episode_pruned_totals` | `episode_id TEXT`、`audio_revision_id TEXT` | `(episode_id, audio_revision_id)` |

両表は `WITHOUT ROWID`。日付列は長さ10のCHECKを持つ。両表共通のカウンタはすべて `INTEGER NOT NULL DEFAULT 0 CHECK(値 >= 0)`。

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

さらに `updated_at_ms INTEGER NOT NULL CHECK(値 >= 0)` を持つ。`audio_get_requests`、`equivalent_full_downloads`、`lifetime` は読取時に計算する値で、同名の保存列・表はない。

明細の整理では、同じトランザクションで累計へ加算してから日別行を削除する。Show IDはDOの固定対象から得るため、統計2表のキーには重ねて保存しない。

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
各DOのドメイン変更 ──要求・確定証拠── 設定ハッシュ
```

図の線は外部キーではない。公開では内容・履歴・短縮ID・世代、予約実行ではそれらと予約結果をまとめて確定する。通常の非公開化は公開可否と世代だけを変更し、内容・履歴・音声参照を削除しない。

## DDLの定義元

- [公開基盤・予約](../../src/sqlite-publication-queue.ts)、[内容・履歴](../../src/sqlite-publication-content.ts)、[短縮ID](../../src/sqlite-site-ids.ts)
- [制御DO固有表](../../src/sqlite-service-control.ts)、[Show固定対応](../../src/sqlite-show-service.ts)、[ドメイン変更](../../src/sqlite-domain-runtime.ts)
- [統計](../../src/sqlite-delivery-stats.ts)、[形式版と稼働設定の確認](../../src/sqlite-runtime-identity.ts)
