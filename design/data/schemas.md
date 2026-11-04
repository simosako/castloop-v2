# 設定・メタデータ・管理APIのスキーマ

CLIとWorkerは、主に `packages/shared/src/` のZodスキーマを共有します。本書では、編集用TOMLから公開要求・保存データへ進む順に、各形式の役割と検証内容を説明します。フィールドの正確な定義は各実装、SQLiteの列は[表設計](sqlite.md)を参照してください。

## 共通の表記と入力規則

- TOMLのキーは `snake_case` です。不明なキーはエラーになります。
- サービスIDは最大20文字、Show IDは32文字、Episode IDは80文字です。英小文字・数字をハイフンで区切る形式を使います。
- メタデータの日時は、秒とUTCまたはオフセットを含むRFC 3339文字列です。TOMLでは引用符で囲みます。小数秒は受け付けず、実在する日時を検証します。
- ハッシュはSHA-256の小文字16進数64文字です。リビジョン・登録・操作の識別子には、それぞれのスキーマで定めたUUIDを使います。
- RSSに出力する文字列はXML 1.0で使える文字に限定します。メタデータ内のWeb URLはHTTP(S)で、認証情報とフラグメントを含まない形式です。

## サービス設定

### `castloop.toml`

サービスの配備先と公開URLを定義します。以下はすべて必須です。

| フィールド | 意味・制約 |
| --- | --- |
| `schema_version` | `2` |
| `storage_layout` | `"show-v1"` |
| `publication_protocol` | `"sqlite-sequential-v1"` |
| `service_id` | サービス識別子 |
| `account_id` | CloudflareアカウントID。16進数32文字 |
| `bucket_name`、`worker_name` | 小文字英数字とハイフンで構成する3〜63文字のリソース名 |
| `public_base_url` | Feed・音声・サイトの正規公開オリジン |
| `workers_dev_base_url` | 当該Workerの管理オリジン。Worker名と `workers.dev` のホスト名を照合 |

オリジンはHTTPSで、パス・クエリ・フラグメント・認証情報・独自ポートを含まない形式です。設定を解析・正規化したJSONのSHA-256を `service_config_sha256` とし、管理要求とDOの保存設定の照合に使います。

### `castloop-admin.toml`

CLIの任意設定です。`schema_version = 1` を必須とし、任意項目に `timezone` を持ちます。タイムゾーンにはUTCまたは対応するIANA名を使います。

予約時刻にオフセットがあれば、その瞬間を使います。オフセットがなければ、`--timezone`、管理設定、UTCの順に解決します。夏時間により存在しない時刻や2通りに解釈できる時刻はエラーにします。

## Showメタデータ

| 区分 | フィールド | 意味 |
| --- | --- | --- |
| 必須 | `schema_version`、`show_id` | 形式の版（1）と対象Show |
| 必須 | `title`、`description`、`language`、`author` | 番組情報。言語タグと空でない文字列を検証 |
| 必須 | `owner_name`、`owner_email`、`categories`、`explicit` | 所有者、配信分類、成人向け内容の指定。カテゴリは1件以上、`explicit` は真偽値 |
| 必須 | `image_path` | 隣接するJPEG/PNGファイルの名前 |
| 条件付き | `site_mode`、`site_url` | `builtin` はURLを省略。`external` またはモード省略時は外部URLが必須 |
| 任意 | `site_timezone` | 内蔵サイトの日付表示。既定はUTC |
| 任意 | `site_css_path` | 内蔵サイト用の隣接CSSファイル名 |
| 生成値 | `site_css` | CLIが読み込んだCSS本文。公開・保存用メタデータに含める |
| 任意 | `copyright`、`show_type` | 権利表示、`episodic` / `serial` |

`site_timezone` とCSSは内蔵サイトで使用します。`site_timezone` は表示専用で、管理設定のタイムゾーンとは独立しています。編集用TOMLは `site_css_path` を使い、CLIがCSS本文を追加します。

公開要求では、対象Show ID、画像拡張子、CSSのパスと本文の組み合わせを素材参照と照合します。

## Episodeメタデータ

| 区分 | フィールド | 意味 |
| --- | --- | --- |
| 必須 | `schema_version`、`episode_id` | 形式の版（1）と対象Episode |
| 必須 | `guid` | RSSでEpisodeを識別する文字列。XML互換、空白だけは不可、最大4096 UTF-8バイト |
| 必須 | `title`、`description`、`published_at` | 公開する内容とRSS上の公開日時 |
| 任意 | `guid_is_permalink` | GUIDがEpisodeのURLであることを示す指定。省略とfalseは同じ意味 |
| 任意 | `explicit`、`episode_type` | 成人向け内容の指定、`full` / `trailer` / `bonus` |
| 任意 | `season_number`、`episode_number` | 正の整数 |

通常更新と過去版の採用では、Episode ID、GUID、permalink指定の意味、公開日時を保持します。

### 保存リビジョン

保存用の `episodeRevisionSchema` は、編集用メタデータに次を加えます。

| フィールド | 内容 |
| --- | --- |
| `revision_id` | 確定した内容のUUID |
| `enclosure_url` | 音声の公開URL |
| `content_type` | `"audio/mpeg"` |
| `length_bytes` | 1〜300,000,000バイト |
| `duration_seconds` | 正の整数秒 |
| `sha256` | 音声のハッシュ |
| `updated_at` | 更新日時 |

音声URLのIDとメタデータのリビジョンIDは別に管理します。音声を再利用する更新では、音声URLを維持して内容のリビジョンを更新できます。

<a id="入力上限と保存内容の読取"></a>

## 入力と生成物のサイズ制限

### 新規入力の項目別上限

| 項目 | 上限 |
| --- | --- |
| Showのタイトル、著者、所有者名・email、各カテゴリ、権利表示 | 各255文字 |
| Show説明 | 4000 UTF-8バイト |
| Show外部サイトURL | 2048文字 |
| Episodeタイトル | 255文字 |
| Episode説明 | 10,000文字 |

文字数はUnicodeコードポイントで数えます。表示文字列の上限は、前後の空白とHTMLタグを除いた値で検査します。URLは前後の空白を除いた値、GUIDは元の文字列で検査します。

新規入力用の `showMetadataInputSchema` と `episodeDraftInputSchema` が項目別上限を検査します。保存用スキーマでは、保存済みの内容をそのまま読み取れるよう、項目別上限を分けています。

### 全体の上限

| 対象 | 上限・検査 |
| --- | --- |
| Show/EpisodeローカルTOML | 1,000,000バイト。ShowはCSS同梱後も同じ上限 |
| `validate` のサービス・管理設定読み取り | 16,384バイト |
| カスタムCSS | 65,536バイト |
| 直接公開要求JSON | 1,016,384バイト |
| 予約登録・変更のHTTP本文 | 1,032,768バイト |
| アクセス統計の取込JSON | 12,288バイト。正規化後も同じ上限 |
| 公開Episode一覧 | 最大10,000件、revision JSON合計2,000,000コードポイント |
| 描画前のサイズ見積もり | `入力バイト数 × 6 + 件数 × 1024 + 4096 <= 32,000,000` |
| 内蔵サイトHTML | 1ページ1,000,000バイト |
| RSS取り込みの元XML | 8 MiB |
| 取り込み後の公開Feed確認 | 32,000,000バイト |

管理GETの応答上限は取得内容に応じて指定します。通常は16 KiB、内容・履歴の全文取得では最大8 MiBです。

## 管理API

### 共通の要求・応答

管理先は `workers_dev_base_url` です。`X-Castloop-Key` で認証し、Show単位の要求は `X-Castloop-Show-Id` でDOを選びます。本文の対象IDも照合します。

JSON本文は `application/json` で送信し、`Content-Encoding` は受け付けません。管理応答はJSONと `Cache-Control: no-store` を返します。

サービスは `service_id` と `service_config_sha256` で識別します。稼働応答には `worker_version_id`、healthには機能識別子、`invocation_id`、`publication_ready`、対象の `scope` などを含めます。

### 公開・非公開化・再公開・履歴採用

`POST /admin/sqlite-publication/publish` に以下を送ります。

| 要求の種類 | 主な内容 |
| --- | --- |
| 共通 | スキーマ版、プロトコル、サービス識別、Show ID、`expected_show_state_version` |
| `action = publish` | `kind` に対応するメタデータと、`cover` または `audio` |
| Episode | Episode ID、公開状態の期待版、既存内容があれば `base_revision_id` |
| `unpublish` / `restore` | 対象と更新元 |
| `restore_revision` | 対象、更新元、`target_revision_id` |

カバー参照はハッシュ・サイズ・拡張子、音声参照はハッシュ・サイズ・秒数を持ちます。応答はサービスの稼働情報、対象、`result = changed | unchanged`、`revision_id` を返します。

このAPIでは、不正要求を400、認証失敗を401、対象・更新元・設定の不一致を409、未準備や実行失敗を503で返します。各APIの詳しい分類は実装を参照してください。

### 照会・予約・統計・ドメイン変更

| 経路 | 内容 | スキーマ |
| --- | --- | --- |
| `/admin/sqlite-service/` | health、登録、一覧、対象状態、現在内容、履歴、ドメイン準備・確定・照会 | [service-api](../../packages/shared/src/sqlite-service-api.ts)、[catalog](../../packages/shared/src/sqlite-catalog.ts)、[revisions](../../packages/shared/src/sqlite-revisions.ts)、[domain](../../packages/shared/src/sqlite-domain.ts) |
| `/admin/sqlite-schedules` | 予約作成、一覧、個別照会、取消、時刻変更、再承認 | [schedule](../../packages/shared/src/sqlite-schedule.ts) |
| `/admin/sqlite-stats/` | Episode一覧、日別集計、保持日数更新 | [stats](../../packages/shared/src/sqlite-stats.ts) |
| `/admin/sqlite-access-stats/` | 収集元・承認済み素材・日別値の照会、日別値の置換 | [access-stats API](../../packages/shared/src/sqlite-access-stats.ts) |

予約の変更は予約ID・期待版・承認ハッシュを照合します。予約応答は解決済み時刻、公開要求とハッシュ、状態、版、実行結果を持ちます。ドメイン変更には前後設定と接続・配備情報、統計には集計値と計測開始・保持範囲・記録エラー数を含めます。

正確な経路とメソッドは、[制御HTTP](../../src/sqlite-control-http.ts)、[Show管理HTTP](../../src/sqlite-service-http.ts)、[予約HTTP](../../src/sqlite-schedule-http.ts)、[統計HTTP](../../src/sqlite-stats-http.ts)にあります。

## Logpushの共通アクセス記録と日別集計

[access-stats.ts](../../packages/shared/src/access-stats.ts)は、収集方法に依存しないアクセス記録と日別値を定義します。Logpush形式の変換・日別集計、R2読取・ローカル索引、Show DOの保存・管理APIを実装しています。Logpush設定とCLIコマンドとの接続は[Issue #122の設計](../issue-122-logpush-design.md)に沿って追加する予定です。

| 形式 | 主な項目と制約 |
| --- | --- |
| 素材参照 | `show_id`、`resource_path`、`resource_kind`、`episode_id`、`audio_revision_id`。既存の公開パス解析でIDとパスを照合し、カバーではEpisode・音声リビジョンを`null`にする |
| アクセス記録 | 素材参照に収集元・要求ID、発生時刻、ホスト、GET/HEAD、200/206/304、本文バイト数、キャッシュ状態を加える。HEAD・304の本文バイト数は0 |
| 日別カウンタ | GET 200・GET 206・HEAD・GET 304の件数、GET 200/206の本文バイト数、キャッシュ状態別の件数。キャッシュ内訳の合計は対象応答の総数と一致する |
| 日別値 | 素材参照、`format = access-daily-v1`、収集元、UTC日付、日別カウンタ。集計単位は収集元・Show・UTC日付・素材パス |

各形式は不明なキーを拒否し、IP・Cookie・User-Agent原文などのリスナー識別情報を持ちません。カウンタは0以上の安全な整数です。キャッシュ状態を取得できない収集元の記録では`cache_status = null`とし、日別内訳の`unavailable`に分類します。

[Logpush変換](../../packages/cli/src/http-logpush-events.ts)は、設定した11フィールドを検証し、外部リスナーの対象ホスト・承認済み素材への応答を共通記録へ変換します。[日別集計](../../packages/cli/src/access-stats-aggregate.ts)は、発生日ごとに収集元・要求IDの組で重複を除きます。Botを含むエッジ本文バイト数による指標なので、既存のWorker統計とは別の定義として扱います。

[R2読取](../../packages/cli/src/http-logpush-r2.ts)は、RESTの一覧からキー・ETag・圧縮サイズを取得します。ETagを本文応答と照合し、圧縮サイズを確認しながらgzipのNDJSONを解析します。[Show・期間別読取](../../packages/cli/src/http-logpush-read.ts)は1〜366日のUTC期間を受け付け、対象記録を順に渡します。完了結果には、対象期間と重なるファイル一覧と、新規ファイル全体にあった期間外の日付を含めます。索引に保存する項目は[表設計](sqlite.md#ローカルのアクセスログ索引)を参照してください。

### アクセス統計の管理API

[sqlite-access-stats.ts](../../packages/shared/src/sqlite-access-stats.ts)は、収集元と日別値を保存・照会する形式を定義します。既存の管理オリジン・認証とShowヘッダーを使います。

| 形式 | 主な内容 |
| --- | --- |
| 収集元 | `source_id`、`collector = http_logpush`、ゾーン・ホスト、`metric_definition = access-daily-v1`、`byte_measurement = edge_body`、`collection_mode = best_effort`、収集開始・終了、最終配送時刻、中断日時と許可した理由コード |
| 収集元の保存値 | 収集元情報、`version`、`updated_at_ms` |
| 日別値の保存値 | 共通の日別値、`version`、`input_sha256`、`input_min_at_ms`・`input_max_at_ms`、`read_at_ms`・`applied_at_ms` |
| 置換要求 | サービス識別・Show、`source`・`expected_source_version`、`daily`・`expected_version`、入力ハッシュ・入力日時範囲・読取日時 |
| 日別照会応答 | 収集元・素材・期間、期間全体の合計と計測範囲、日別値と版、保持範囲、次ページのカーソル |

GETはサービスID・設定ハッシュをクエリで指定します。日別照会では収集元・素材パス・UTC開始日・終了日も必須です。保存済み0件にはカウンタを返し、未集計・保持範囲外では`null`を返します。`observed`と`partial`は観測値の計測範囲を示し、配送の欠損があり得る方式であることは収集元にも記録します。

JSON取込は12 KiB、応答は16 KiBを上限にします。1ページの上限は収集元・素材が20件、日別値が31日です。収集元と日別値は、応答サイズに収まるよう件数を調整します。HTTPの要求・応答と状態コードは[アクセス統計の管理HTTP](../../src/sqlite-access-stats-http.ts)、版と保持範囲は[保存処理](../../src/sqlite-access-stats.ts)を参照してください。

## ローカル記録とバックアップ

| 記録 | 主な内容と定義元 |
| --- | --- |
| 初期化 | 設定・ソース・配備メタデータのハッシュ、`fresh / prepared / deployed / ready`、配備情報。[定義](../../packages/cli/src/sqlite-initialization.ts) |
| Show登録 | Show ID、登録ID、設定ハッシュ、`prepared / registered`。[定義](../../packages/cli/src/sqlite-commands.ts) |
| RSSダウンロード | RSSハッシュ、元URL、素材サイズ・ハッシュ。[定義](../../packages/cli/src/rss-import-local.ts) |
| RSS公開進捗 | 設定・取り込み元・入力ハッシュ、`step`・`phase`・`installed`。[定義](../../packages/cli/src/sqlite-rss-publication.ts) |
| ドメイン変更 | 要求とハッシュ、変更前後の配備、接続、進捗。[定義](../../packages/cli/src/sqlite-domain-journal.ts) |
| バックアップヘッダー | CLI版、日時、サービスID、音声同梱、鍵導出・暗号情報、チャンクサイズ、件数・サイズ。[定義](../../packages/cli/src/backup-archive.ts) |
| バックアップマニフェスト | ファイルのパス・種別・サイズ・ハッシュ、除外項目、ロック情報、未完了ドメイン変更、`scan_errors`。同上 |

配置は[保存構造](storage.md)、暗号化と展開は[バックアップ設計](../components/workspace-backup.md)で説明しています。

## CLIのJSON出力

`--json` の共通応答は `contract_version`、`command`、`ok`、`target`、`result`、`operation`、`error`、`next_actions` を持ちます。エラーにはコード、許可したメッセージ、`outcome = not_started | unknown`、必要に応じてフィールド位置と検証コードを含めます。機密情報の扱いは[セキュリティ](../security.md)を参照してください。

`castloop schema` は、`service-config`、`admin-config`、`show-input`、`episode-input`、`result` のJSON Schemaを出力します。フィールド間の条件や素材の検査は `validate` で確認します。

## 形式の版と機能識別子

設定、API、SQLiteはそれぞれ独立した版を持ちます。現在のサービスは、新規作成した以下の形式を対象としています。サービス設定やDBの形式が異なる場合はエラーとして扱い、保存済みデータを維持します。

| 対象 | 現行値 | 定義元 |
| --- | --- | --- |
| サービス設定 | `schema_version = 2`、`show-v1` | [sqlite-service.ts](../../packages/shared/src/sqlite-service.ts) |
| 公開要求 | `schema_version = 1`、`sqlite-sequential-v1` | [sqlite-direct-publication.ts](../../packages/shared/src/sqlite-direct-publication.ts) |
| Show/Episodeメタデータ | `schema_version = 1` | [metadata.ts](../../packages/shared/src/metadata.ts) |
| 管理者の任意設定 | `schema_version = 1` | [admin-config.ts](../../packages/shared/src/admin-config.ts) |
| SQLite | 公開基盤（queue）14 / 内容（content）13 / Worker統計1 / アクセス統計1 | [公開基盤](../../src/sqlite-publication-queue.ts)、[Worker統計](../../src/sqlite-delivery-stats.ts)、[アクセス統計](../../src/sqlite-access-stats.ts) |
| 予約 | `sqlite-schedule-v1` | [sqlite-schedule.ts](../../packages/shared/src/sqlite-schedule.ts) |
| 履歴照会 | `sqlite-revisions-v1` | [sqlite-revisions.ts](../../packages/shared/src/sqlite-revisions.ts) |
| 独自ドメイン | `schema_version = 1`、`sqlite-domain-change-v1` | [sqlite-domain.ts](../../packages/shared/src/sqlite-domain.ts) |
| Worker配信統計 | `episode-daily-v1` | [sqlite-stats.ts](../../packages/shared/src/sqlite-stats.ts) |
| 共通アクセス統計・管理API | `access-daily-v1` | [共通データ](../../packages/shared/src/access-stats.ts)、[管理API](../../packages/shared/src/sqlite-access-stats.ts) |
| 内蔵サイト | `static-show-v2` | [sqlite-service-api.ts](../../packages/shared/src/sqlite-service-api.ts) |
| CLI応答 | `contract_version = 1` | [agent-schema.ts](../../packages/cli/src/agent-schema.ts) |
| RSSダウンロード記録 | 1 | [rss-import-local.ts](../../packages/cli/src/rss-import-local.ts) |
| RSS公開進捗 | `schema_version = 3` | [sqlite-rss-publication.ts](../../packages/cli/src/sqlite-rss-publication.ts) |
| ドメイン変更ジャーナル | 1 | [sqlite-domain-journal.ts](../../packages/cli/src/sqlite-domain-journal.ts) |
| ローカルのログファイル索引 | 1 | [access-log-file-index.ts](../../packages/cli/src/access-log-file-index.ts) |
| バックアップ | `CASTLOOP-BACKUP-1`、ヘッダー・マニフェストの版1 | [backup-archive.ts](../../packages/cli/src/backup-archive.ts) |

## 関連テスト

- 入力：[設定](../../packages/shared/src/sqlite-service.test.ts)、[項目上限](../../packages/shared/src/metadata-limits.test.ts)、[XML文字](../../packages/shared/src/metadata-xml.test.ts)
- 要求：[直接公開](../../packages/shared/src/sqlite-direct-publication.test.ts)、[履歴](../../packages/shared/src/sqlite-revisions.test.ts)、[ドメイン](../../packages/shared/src/sqlite-domain.test.ts)
- 共通アクセス統計：[データ形式](../../packages/shared/src/access-stats.test.ts)、[Logpush変換](../../packages/cli/src/http-logpush-events.test.ts)、[日別集計](../../packages/cli/src/access-stats-aggregate.test.ts)
- ログ読取：[R2・gzip・NDJSON](../../packages/cli/src/http-logpush-r2.test.ts)、[ファイル索引](../../packages/cli/src/access-log-file-index.test.ts)、[Show・期間・遅着ログ](../../packages/cli/src/http-logpush-read.test.ts)
- アクセス統計の保存：[共有スキーマ](../../packages/shared/src/sqlite-access-stats.test.ts)、[置換・保持](../../src/sqlite-access-stats.test.ts)、[管理HTTP](../../src/sqlite-access-stats-http.test.ts)
- CLI：[スキーマ出力](../../packages/cli/src/agent-schema.test.ts)、[予約日時](../../packages/cli/src/schedule-time.test.ts)、[ローカル検証](../../packages/cli/src/agent-cli.test.ts)
