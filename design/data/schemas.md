# 設定・要求・保存データのスキーマ

スキーマは主に `packages/shared/src/` のZod定義をCLIとWorkerで共有する。本書は各形式の意味と検証境界を示す。全フィールドの機械可読定義は定義元を参照し、SQLiteの列・制約は[表設計](sqlite.md)を参照する。

## 版と識別子

| 対象 | 現行値 | 定義元 |
| --- | --- | --- |
| サービス設定 | `schema_version = 2`、`storage_layout = "show-v1"` | [sqlite-service.ts](../../packages/shared/src/sqlite-service.ts) |
| 公開要求 | `schema_version = 1`、`protocol = "sqlite-sequential-v1"` | [sqlite-direct-publication.ts](../../packages/shared/src/sqlite-direct-publication.ts) |
| Show/Episode入力・保存メタデータ | `schema_version = 1` | [metadata.ts](../../packages/shared/src/metadata.ts) |
| 管理者の任意設定 | `schema_version = 1` | [admin-config.ts](../../packages/shared/src/admin-config.ts) |
| SQLite形式 | queue 14 / content 13 / statistics 1 | [公開基盤](../../src/sqlite-publication-queue.ts)、[統計](../../src/sqlite-delivery-stats.ts) |
| 予約 | `sqlite-schedule-v1` | [sqlite-schedule.ts](../../packages/shared/src/sqlite-schedule.ts) |
| 履歴照会 | `sqlite-revisions-v1` | [sqlite-revisions.ts](../../packages/shared/src/sqlite-revisions.ts) |
| 独自ドメイン | `schema_version = 1`、`sqlite-domain-change-v1` | [sqlite-domain.ts](../../packages/shared/src/sqlite-domain.ts) |
| 配信統計の機能識別 | `episode-daily-v1` | [sqlite-stats.ts](../../packages/shared/src/sqlite-stats.ts) |
| 内蔵サイトの機能識別 | `static-show-v2` | [sqlite-service-api.ts](../../packages/shared/src/sqlite-service-api.ts) |
| CLI応答 | `contract_version = 1` | [agent-schema.ts](../../packages/cli/src/agent-schema.ts) |
| RSS公開進捗 | `schema_version = 3` | [sqlite-rss-publication.ts](../../packages/cli/src/sqlite-rss-publication.ts) |
| バックアップ | `CASTLOOP-BACKUP-1`、ヘッダー・マニフェストの版1 | [backup-archive.ts](../../packages/cli/src/backup-archive.ts) |

これらは独立した版であり、数字が一致する必要はない。サービス設定と内部形式は対応する新規環境だけを受け付け、他形式の移行・採用は行わない。

## 共通の入力規則

- TOMLのキーは `snake_case`。不明なキーと `null` を受け付けない。
- メタデータ日時は、引用したRFC 3339文字列。秒・UTCまたはオフセットを必須とし、小数秒を受け付けず、実在する日時を検査する。
- サービスIDは最大20文字、Show IDは32文字、Episode IDは80文字。英小文字・数字をハイフンで区切る形式とする。
- ハッシュはSHA-256の小文字16進数64文字。リビジョン・登録・操作等の識別子には、それぞれ定義したUUIDを使う。
- RSSへ出す文字列はXML 1.0で使用できる文字を検証する。メタデータのWeb URLはHTTP(S)で、認証情報・フラグメントを持たない。

## 設定TOML

### `castloop.toml`

全項目必須。

| フィールド | 意味・制約 |
| --- | --- |
| `schema_version`、`storage_layout`、`publication_protocol` | 上記の固定値 |
| `service_id` | サービス識別子 |
| `account_id` | CloudflareアカウントID、16進数32文字 |
| `bucket_name`、`worker_name` | 小文字英数字とハイフンのリソース名、3〜63文字 |
| `public_base_url` | Feed・サイト等に使用する正規公開オリジン |
| `workers_dev_base_url` | 当該Workerの管理オリジン。Worker名と `workers.dev` 形式を照合 |

オリジンはHTTPSで、認証情報・パス・クエリ・フラグメント・独自ポートを持たない。解析後の設定をJSON化したSHA-256が `service_config_sha256` となる。TOMLの空白やコメントそのものをハッシュするわけではない。

### `castloop-admin.toml`

必須は `schema_version = 1`、任意項目は `timezone` のみ。タイムゾーンはUTCまたはサポートするIANA名を使い、略称を拒否する。認証情報、配備先、操作承認は持たない。

予約時刻は明示オフセットがあればその瞬間を使い、なければ `--timezone`、管理設定、UTCの順に解決する。夏時間で存在しない・曖昧なローカル時刻は拒否する。管理用タイムゾーンとサイト表示用 `site_timezone` は独立している。

## Showメタデータ

| 区分 | フィールド | 意味 |
| --- | --- | --- |
| 必須 | `schema_version`、`show_id` | 形式と対象 |
| 必須 | `title`、`description`、`language`、`author` | 番組情報。文字列は空を拒否し、言語タグを検証 |
| 必須 | `owner_name`、`owner_email`、`categories`、`explicit` | 所有者・配信分類。カテゴリは1件以上、email形式、explicitは真偽値 |
| 必須 | `image_path` | 隣接JPEG/PNGのファイル名。絶対パス・サブディレクトリ不可 |
| 条件付き | `site_mode`、`site_url` | `builtin` はURLを省略。`external` またはモード省略は外部サイトURLが必須 |
| 任意 | `site_timezone` | 内蔵サイトだけで指定可能。表示用で既定UTC |
| 任意 | `site_css_path` | 内蔵サイトだけで指定可能。隣接CSSのファイル名 |
| 生成値 | `site_css` | CLIが読み込んだCSS本文。公開・保存形式用で、ローカルTOMLへの直接記入は禁止 |
| 任意 | `copyright`、`show_type` | 権利表示、`episodic` / `serial` |

公開要求ではShow ID、画像拡張子、CSSのパスと本文の有無が素材参照と整合することも検査する。

## Episodeメタデータと保存リビジョン

| 区分 | フィールド | 意味 |
| --- | --- | --- |
| 必須 | `schema_version`、`episode_id` | 形式と対象 |
| 必須 | `guid` | 空白だけを拒否するXML互換文字列、最大4096 UTF-8 bytes。UUIDやURLに限定しない |
| 必須 | `title`、`description`、`published_at` | 番組内の公開内容 |
| 任意 | `guid_is_permalink` | GUIDをpermalinkとして扱う指定。省略とfalseは同じ意味 |
| 任意 | `explicit`、`episode_type` | 真偽値、`full` / `trailer` / `bonus` |
| 任意 | `season_number`、`episode_number` | 正の整数 |

編集用TOMLには音声URLや生成済みリビジョンIDを入れない。保存用 `episodeRevisionSchema` はこの入力に `revision_id`、`enclosure_url`、`content_type = "audio/mpeg"`、`length_bytes`、`duration_seconds`、`sha256`、`updated_at` を追加する。

通常の更新と過去版採用ではEpisode ID、GUID、permalink指定の意味、公開日時を保持する。`duration_seconds` は正の整数、サイズは1〜300,000,000 bytes。音声公開URLのIDとメタデータのリビジョンIDは、音声再利用時には異なる。

## 入力上限と保存内容の読取

| 新規入力の項目 | 上限 |
| --- | --- |
| Showのタイトル、著者、所有者名・email、各カテゴリ、権利表示 | 各255文字 |
| Show説明 | 4000 UTF-8 bytes |
| Show外部サイトURL | 2048文字 |
| Episodeタイトル | 255文字 |
| Episode説明 | 10,000文字 |

文字数はUnicodeコードポイント数。項目値はtrim・HTMLタグ除去・trim後に測る。ただしURLはtrimのみ、GUIDは元の文字列に固有の制約を適用する。カテゴリ数に追加の件数上限は設けない。

新規入力用 `showMetadataInputSchema` / `episodeDraftInputSchema` は項目別上限を追加する。保存用スキーマにはこの上限を加えず、保存済み内容の読取や過去版採用で切り詰めない。ただし全体の読取・描画上限は別途適用する。

| 対象 | 全体上限・検査 |
| --- | --- |
| Show/EpisodeローカルTOML | 1,000,000 bytes。ShowはCSS同梱後も同じ上限 |
| `validate` のサービス・管理設定読取 | 16,384 bytes |
| カスタムCSS | 65,536 bytes |
| 直接公開要求JSON | 1,016,384 bytes（メタデータ予算＋管理要求分） |
| 予約登録・変更のHTTP本文 | 1,032,768 bytes（直接公開要求＋予約情報分） |
| 公開Episode一覧 | 最大10,000件、revision JSON合計2,000,000コードポイント |
| 描画の事前予算 | `入力bytes × 6 + 件数 × 1024 + 4096 <= 32,000,000` |
| 内蔵サイトHTML | 1ページ1,000,000 bytes |
| RSS取り込みの元XML | 8 MiB。生成後の公開Feed確認は別枠で32,000,000 bytes |

読取上限は用途別であり、同じ数字をすべての管理応答に流用しない。たとえば管理GETは通常16 KiB、内容・履歴の全文取得では最大8 MiBを指定する。

## 管理APIの共通契約

管理先は `workers_dev_base_url`。`X-Castloop-Key` で認証し、Show単位の要求は `X-Castloop-Show-Id` でDOを選ぶ。要求本文の対象IDも照合する。管理応答はJSON、`Cache-Control: no-store`。JSON本文の要求は `application/json` とし、`Content-Encoding` を受け付けない。

サービス識別は `service_id` と `service_config_sha256`。稼働応答には `worker_version_id` を含む。healthはさらに機能識別子、`invocation_id`、`publication_ready`、対象scope等を返す。照会結果は観測であり、それ自体は復旧や変更の許可ではない。

### 直接公開・ライフサイクル・履歴採用

`POST /admin/sqlite-publication/publish` は次を受ける。

- 共通：スキーマ版、プロトコル、サービス識別、Show ID、`expected_show_state_version`。
- `action = publish`：`kind` に対応するメタデータと `cover` または `audio`。
- Episode：Episode ID、公開可否の期待版、既存内容があれば更新元 `base_revision_id`。
- `action = unpublish | restore | restore_revision`：対象・更新元。履歴採用だけ `target_revision_id` も必須。

カバー参照はハッシュ・サイズ・拡張子、音声参照はハッシュ・サイズ・秒数を持つ。結果はサービス稼働識別、対象、`result = changed | unchanged`、`revision_id`。

公開HTTPは、不正要求を400、認証失敗を401、対象・更新元・設定の不一致を409、未準備や未確認の実行失敗を503で返す。すべての管理エンドポイントが同じエラー分類を使うわけではない。

### その他のAPI

| 機能・経路 | 主な要求・応答 | 定義元 |
| --- | --- | --- |
| サービス `/admin/sqlite-service/` | health、登録、catalog、対象状態、現在内容、履歴、ドメイン準備・確定・照会 | [service-api](../../packages/shared/src/sqlite-service-api.ts)、[catalog](../../packages/shared/src/sqlite-catalog.ts)、[revisions](../../packages/shared/src/sqlite-revisions.ts)、[domain](../../packages/shared/src/sqlite-domain.ts) |
| 予約 `/admin/sqlite-schedules` | 作成、一覧、個別照会、cancel、reschedule、reapprove。変更時は予約ID・期待版・プレビューハッシュを照合 | [schedule](../../packages/shared/src/sqlite-schedule.ts) |
| 統計 `/admin/sqlite-stats/` | Episode一覧・日別集計と保持日数更新。照会は期間・カーソルを持つ | [stats](../../packages/shared/src/sqlite-stats.ts) |

予約は解決済み時刻、公開要求とそのハッシュ、状態、版、実行結果を返す。ドメイン変更は前後設定と接続・配備証拠を持つ。統計は集計値に加え、計測開始・保持境界・coverage・記録エラー数を返す。

正確な経路とHTTPメソッドは [制御HTTP](../../src/sqlite-control-http.ts)、[Show管理HTTP](../../src/sqlite-service-http.ts)、[予約HTTP](../../src/sqlite-schedule-http.ts)、[統計HTTP](../../src/sqlite-stats-http.ts)に定義する。

## ローカル記録とバックアップ

| 記録 | 主な内容と定義元 |
| --- | --- |
| 初期化 | 設定・ソース・配備メタデータのハッシュ、`fresh / prepared / deployed / ready`、配備証拠。[定義](../../packages/cli/src/sqlite-initialization.ts) |
| Show登録 | Show ID、登録ID、設定ハッシュ、`prepared / registered`。[定義](../../packages/cli/src/sqlite-commands.ts) |
| RSSダウンロード | 制御記録と素材完了記録は版1。RSSハッシュ、元URL、素材サイズ・ハッシュ。[定義](../../packages/cli/src/rss-import-local.ts) |
| RSS公開進捗 | 版3、設定・取り込み元・全入力ハッシュ、step・phase・installed。[定義](../../packages/cli/src/sqlite-rss-publication.ts) |
| ドメイン変更 | 版1、要求とハッシュ、変更前配備、接続、新配備、6つの確認済みフェーズ。[定義](../../packages/cli/src/sqlite-domain-journal.ts) |
| バックアップヘッダー | 版、CLI版、日時、サービスID、音声同梱、KDF・salt・暗号、チャンクサイズ、件数・サイズ。[定義](../../packages/cli/src/backup-archive.ts) |
| バックアップマニフェスト | 各ファイルのパス・種別・サイズ・ハッシュ、除外項目、残存ロック情報、未完了ドメイン変更、scan_errors。同上 |

保存場所は[保存構造](storage.md)、バックアップの暗号化と展開条件は[バックアップ設計](../components/workspace-backup.md)を参照する。

## CLIのJSON出力

`--json` の共通応答は `contract_version`、`command`、`ok`、`target`、`result`、`operation`、`error`、`next_actions` を持つ。エラーにはコード、固定または許可したメッセージ、`outcome = not_started | unknown`、必要ならフィールド位置と検証コードを含める。入力値や一般例外を転載しない。

`castloop schema` で `service-config`、`admin-config`、`show-input`、`episode-input`、`result` のJSON Schemaを取得できる。フィールド間の条件や素材検査などJSON Schemaだけでは表せない検査があるため、CLIの `validate` も使う。

## 関連テスト

- [設定](../../packages/shared/src/sqlite-service.test.ts)、[項目上限](../../packages/shared/src/metadata-limits.test.ts)、[XML文字制約](../../packages/shared/src/metadata-xml.test.ts)
- [直接公開要求](../../packages/shared/src/sqlite-direct-publication.test.ts)、[履歴](../../packages/shared/src/sqlite-revisions.test.ts)、[ドメイン](../../packages/shared/src/sqlite-domain.test.ts)
- [スキーマ出力](../../packages/cli/src/agent-schema.test.ts)、[予約日時](../../packages/cli/src/schedule-time.test.ts)、[ローカル検査](../../packages/cli/src/agent-cli.test.ts)
