# Issue #40: 操作記録のIDとテーブル設計

更新日: 2026-10-20。公開状態と同じDO SQLiteに保存する操作記録の設計。Issue #48の開発版では各Show DOへこのDDLを適用し、制御DOへ操作記録の正本を分離しない。remote検索・指示は`--show SHOW_ID`を必須とする。旧DB/journalの移行は提供しない。[Show分離契約](do_show_separation_options.md)参照。

## 1. 再検討の結論

**作業を表す`operation`と、その作業への指示を表す`request`は分ける。CLIの起動を表す`session`は今回の設計から省く。**

前案では、作業単位の追跡と、CLIの起動単位の追跡を両方設けていた。今回必要なのは、中断した作業を追跡し、各要求がいつどのクライアントから届いたかを確認することである。これは操作と要求の記録で実現できる。

### operationとrequestを分ける理由

一つのアップロードを例にすると、作業と要求は次の関係になる。

```text
operation O1: 音源を保存し、内容を検証して下書きへ登録する
  request R1: 作業を登録する             client C1 / 10:00
  request R2: アップロードの開始を求める client C1 / 10:01
  request R3: 保存成功を報告する         client C1 / 10:02
  ── CLIが中断 ──
  request R4: 保存済み音源の検証を進める client C1 / 10:10
```

`operation_id`は、再開後も同じ作業を指す。`request_id`は、開始・報告・再開などの指示を区別する。IDを一つにまとめると、同じIDの要求内容が処理段階ごとに変わり、どの指示への応答が失われたのか分かりにくくなる。

また、公開要求の受付が完了しても、公開作業はまだ実行中という場合がある。要求の結果と、作業全体の結果も別々に保持する必要がある。

要求IDの代わりに「操作ID＋要求の連番」で識別する方法もある。ただし、同時に届く要求や拒否された要求も区別する必要があり、既存の公開処理も`request_id`を使っている。今回は独立した要求IDを使う方が扱いやすいと考える。

### sessionを省ける理由

セッションIDが追加する情報は、「同じCLI起動から出た複数の要求」である。これは実行ログの整理には便利だが、再開や取消の判断には使っていない。

RSS取り込みのように関連する作業は、取り込み全体の操作と、その子の操作でまとめられる。各要求にクライアントIDと受信時刻を記録すれば、どのクライアントが開始・再開したかも追える。

したがって、セッションIDと`client_sessions`表は省く。この案では、同じクライアントで並行起動したCLIを「一回の起動」単位で一覧化することは扱わない。将来、無関係な複数の作業をCLIの起動ごとにまとめて調査する必要が出た場合に、起動単位の識別を追加する。

### 要求表と履歴表は分ける

要求表には、指示の種類・内容のハッシュと、受付・適用・拒否などの結果を記録する。履歴表には、作業の状態変化を記録する。拒否された要求では作業状態が変わらず、逆に一つの要求からWorkerが後で複数の状態変更を行うこともあるため、一対一の関係ではない。

要求元は要求表に、Workerによる実行は履歴表に記録する構成を維持する。

## 2. IDと時刻の扱い

| ID | 識別するもの | 扱い |
| --- | --- | --- |
| `client_id` | 同じ作業環境から使うCLI | 初回の変更操作で発行し、`.castloop/`に保存する。各要求に付けて送る |
| `operation_id` | 中断・再開をまたぐ一つの作業 | 同じ作業の続きなら維持する |
| `request_id` | 作業への個々の変更要求 | 送信前にIDと要求内容を保存する。結果を照会するときも同じIDを使う |

新しく発行するIDにはUUID v4を使う。ただし、既に同じ作業を識別するIDがある場合は、その値を`operation_id`にも使う。

- RSS取り込み全体：既存の`import_id`を使う。
- 公開作業：既存の`job_id`を使う。
- 素材のアップロード作業：アップロード試行全体のIDを使う。個々の保存ファイルは既存の`upload_id`で識別する。

一つの下書きに対して素材更新と公開は別の作業になるため、すべての`operation_id`を`job_id`と同じにするわけではない。親子の操作と`import_id`を使って、RSS取り込み全体と個々の作業を関連付ける。公開要求の`request_id`と、既存の要求内容・ハッシュはそのまま使う。

クライアントIDは管理APIのヘッダー`X-Castloop-Client-Id`で送り、要求表にCLIの版とともに直接保存する。CLIのログにも、操作IDと要求IDを表示する。

`client_id`は作業環境の識別子であり、端末の証明や認証情報ではない。作業ディレクトリを別のクライアントとして複製する場合は、新しいIDを割り当てる。認証には既存の管理キーを使う。

時刻はサーバー側で取得し、UTCのUnix時刻をミリ秒単位の`INTEGER`で保存する。

| 項目 | 記録する時点 | 用途 |
| --- | --- | --- |
| `received_at_ms` | 要求を受信した時刻 | 「いつ、どのクライアントから」の基準 |
| `resolved_at_ms` | 要求への処理結果を確定した時刻 | 要求単位の完了確認 |
| `recorded_at_ms` | 作業の履歴を記録した時刻 | 経過の表示 |

クライアント側の時刻はCLIのログで確認する。状態変化の順序は、操作ごとの`version`と履歴番号で確定する。

## 3. 表の構成

| 表 | 役割 |
| --- | --- |
| `operation_record_schema` | 今回追加する記録用テーブルの形式番号 |
| `operations` | 作業の対象、開始時の条件、現在状態 |
| `operation_requests` | どのクライアントが、いつ、どの指示を出し、どう処理されたか |
| `operation_assets` | 操作とアップロードファイルの対応、保存・検証・削除の結果 |
| `operation_events` | 状態変化の履歴と、そのきっかけになった要求・サーバー実行 |

```text
operations ── operation_assets
  ├─ operation_requests（client_id、受信時刻、指示、結果）
  └─ operation_events ── きっかけになったrequest_id
```

一つのDOが一つのサービスを担当するため、サービスIDは既存の`publication_service`で確認する。操作の行には、開始時の設定・Workerバージョンなど、再開時の照合に必要な情報を保存する。

### DDL

以下は追加する表の定義である。既存の`publication_jobs`などの保存形式は維持する。記録用の形式番号は、サービス設定や公開キューの形式番号とは別に管理する。

```sql
CREATE TABLE operation_record_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

INSERT INTO operation_record_schema (id, version) VALUES (1, 1);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  parent_operation_id TEXT REFERENCES operations (operation_id),
  import_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'rss_import', 'show_registration', 'local_install',
    'upload', 'publication', 'cleanup'
  )),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('show', 'episode')),
  show_id TEXT NOT NULL,
  episode_id TEXT,
  job_id TEXT,
  worker_version_id TEXT NOT NULL,
  service_config_sha256 TEXT NOT NULL CHECK (length(service_config_sha256) = 64),
  admission_window_id TEXT,
  expected_show_state_version INTEGER CHECK (expected_show_state_version >= 0),
  expected_episode_lifecycle_version INTEGER
    CHECK (expected_episode_lifecycle_version >= 0),
  base_revision_id TEXT,
  base_metadata_sha256 TEXT CHECK (length(base_metadata_sha256) = 64),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'in_progress', 'succeeded', 'failed', 'blocked', 'cancelled'
  )),
  phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  CHECK (parent_operation_id IS NULL OR parent_operation_id <> operation_id),
  CHECK (kind <> 'rss_import' OR (import_id IS NOT NULL AND operation_id = import_id)),
  CHECK (kind <> 'publication' OR (job_id IS NOT NULL AND operation_id = job_id)),
  CHECK (
    (target_kind = 'show' AND episode_id IS NULL) OR
    (target_kind = 'episode' AND episode_id IS NOT NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled') AND finished_at_ms IS NOT NULL) OR
    (state IN ('prepared', 'in_progress', 'blocked') AND finished_at_ms IS NULL)
  )
);

CREATE INDEX operations_parent
  ON operations (parent_operation_id, operation_id)
  WHERE parent_operation_id IS NOT NULL;

CREATE INDEX operations_import
  ON operations (import_id, operation_id)
  WHERE import_id IS NOT NULL;

CREATE INDEX operations_target
  ON operations (show_id, episode_id, updated_at_ms, operation_id);

CREATE INDEX operations_pending
  ON operations (updated_at_ms, operation_id)
  WHERE state IN ('prepared', 'in_progress', 'blocked');

CREATE TABLE operation_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  client_id TEXT NOT NULL,
  cli_version TEXT NOT NULL CHECK (length(cli_version) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN (
    'register', 'begin_upload', 'report_upload', 'verify_upload',
    'attach_asset', 'submit_publication', 'resume', 'cancel', 'cleanup'
  )),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'accepted', 'applied', 'rejected', 'unknown'
  )),
  resolved_at_ms INTEGER CHECK (resolved_at_ms >= 0),
  reason_code TEXT CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (
    (outcome IN ('applied', 'rejected') AND resolved_at_ms IS NOT NULL) OR
    (outcome IN ('accepted', 'unknown') AND resolved_at_ms IS NULL)
  )
);

CREATE INDEX operation_requests_client
  ON operation_requests (client_id, received_at_ms, request_id);

CREATE INDEX operation_requests_operation
  ON operation_requests (operation_id, received_at_ms, request_id);

CREATE TABLE operation_assets (
  upload_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN (
    'show_metadata', 'episode_metadata', 'cover_jpg', 'cover_png', 'audio'
  )),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 256),
  length_bytes INTEGER NOT NULL CHECK (length_bytes BETWEEN 1 AND 300000000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  duration_seconds REAL CHECK (duration_seconds > 0),
  upload_state TEXT NOT NULL CHECK (upload_state IN (
    'prepared', 'put_requested', 'put_acknowledged',
    'verified', 'attached', 'unknown', 'cancelled'
  )),
  put_etag TEXT,
  object_version TEXT,
  put_acknowledged_at_ms INTEGER CHECK (put_acknowledged_at_ms >= 0),
  verified_at_ms INTEGER CHECK (verified_at_ms >= 0),
  attached_at_ms INTEGER CHECK (attached_at_ms >= 0),
  cleanup_operation_id TEXT REFERENCES operations (operation_id),
  deletion_state TEXT NOT NULL DEFAULT 'none'
    CHECK (deletion_state IN ('none', 'requested', 'deleted', 'unknown')),
  deleted_at_ms INTEGER CHECK (deleted_at_ms >= 0),
  CHECK (asset_kind NOT IN ('cover_jpg', 'cover_png') OR length_bytes <= 5000000),
  CHECK (
    (asset_kind = 'audio' AND duration_seconds IS NOT NULL) OR
    (asset_kind <> 'audio' AND duration_seconds IS NULL)
  ),
  CHECK (
    (put_etag IS NULL AND object_version IS NULL AND put_acknowledged_at_ms IS NULL) OR
    (put_etag IS NOT NULL AND length(put_etag) > 0 AND
     object_version IS NOT NULL AND length(object_version) > 0 AND
     put_acknowledged_at_ms IS NOT NULL)
  ),
  CHECK (verified_at_ms IS NULL OR put_etag IS NOT NULL),
  CHECK (attached_at_ms IS NULL OR verified_at_ms IS NOT NULL),
  CHECK (upload_state NOT IN ('put_acknowledged', 'verified', 'attached')
    OR put_etag IS NOT NULL),
  CHECK (upload_state NOT IN ('verified', 'attached') OR verified_at_ms IS NOT NULL),
  CHECK (upload_state <> 'attached' OR attached_at_ms IS NOT NULL),
  CHECK (deletion_state = 'none' OR put_etag IS NOT NULL),
  CHECK (
    (deletion_state = 'none' AND cleanup_operation_id IS NULL AND deleted_at_ms IS NULL) OR
    (deletion_state IN ('requested', 'unknown') AND
     cleanup_operation_id IS NOT NULL AND deleted_at_ms IS NULL) OR
    (deletion_state = 'deleted' AND
     cleanup_operation_id IS NOT NULL AND deleted_at_ms IS NOT NULL)
  )
);

CREATE INDEX operation_assets_operation
  ON operation_assets (operation_id, upload_id);

CREATE INDEX operation_assets_cleanup
  ON operation_assets (cleanup_operation_id, upload_id)
  WHERE cleanup_operation_id IS NOT NULL;

CREATE TABLE operation_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  operation_version INTEGER NOT NULL CHECK (operation_version > 0),
  request_id TEXT REFERENCES operation_requests (request_id),
  upload_id TEXT REFERENCES operation_assets (upload_id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'worker')),
  invocation_id TEXT NOT NULL,
  worker_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'in_progress', 'succeeded', 'failed', 'blocked', 'cancelled'
  )),
  phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  reason_code TEXT CHECK (length(reason_code) BETWEEN 1 AND 64),
  UNIQUE (operation_id, operation_version),
  CHECK (actor_type <> 'client' OR request_id IS NOT NULL)
);
```

UUIDやハッシュの正確な形式、操作ごとに使える`phase`と`reason_code`は、管理APIの入力スキーマでも厳密に検証する。DDLの外部キーとCHECK制約は、参照切れや記録の矛盾を防ぐために使う。

## 4. 記録の読み方と更新方法

### 要求の受付から完了まで

DBに記録するのは、特定の作業に対する変更要求である。各要求にクライアントID・CLIの版・受信時刻を記録する。状態照会のアクセスはWorkers Logsで追跡する。

作業の作成時には、最初の要求と、操作の版番号1の履歴も同じトランザクションで保存する。この履歴から、作業を開始したクライアントを確認できる。作成元を表すためだけのIDは追加しない。

新しい要求では、対象操作・入力・開始時の条件と`expected_version`を照合する。状態の更新、関連ファイルの更新、`version`の加算、同じ番号の履歴追加を、一つのトランザクションで行う。版番号が変わっていれば、別の要求が先に進んだことが分かる。

`operation_requests.outcome`の意味は次のとおりである。

| 値 | 意味 |
| --- | --- |
| `accepted` | 要求を保存し、処理中である |
| `applied` | 依頼された変更を適用した |
| `rejected` | 条件が合わず、変更を適用せずに終了した |
| `unknown` | 開始した処理の結果を確認できず、記録を保持している |

例えば公開受付の要求が`applied`になった場合は、公開キューへの登録が完了したという意味である。公開自体の完了は、既存の`publication_jobs`と操作の履歴で確認する。

要求ID、要求元、操作の対象と開始条件は、最初の登録後は固定する。同じ要求IDが再度届いた場合は、操作ID・クライアントID・指示の種類・期待する版番号・要求内容のハッシュを元の記録と照合する。元の受信時刻や要求元は維持し、内容が異なる要求は拒否する。再到着自体はWorkers Logsで追跡する。

### 再開時の記録

再開コマンドでは、元の`operation_id`と、確認した版番号を指定して次の処理を依頼する。その指示には新しい`request_id`を付ける。過去の要求の結果照会には、元の要求IDを使う。

再開前後のつながりは、同じ操作IDと`expected_version`から追えるため、前案の`continued_from_request_id`も省く。再開の要求元と時刻は新しい要求の行に残るので、別のクライアントから再開した場合も区別できる。

結果不明の送信はそのまま保持し、成功が確認できた地点から次の処理を進める。実行権限や所有者・更新番号の検査は、操作記録のIDとは別に行う。

`operations.state`の`failed`は処理の書込み前に確定した失敗、`blocked`は結果不明などで確認を要する状態とする。公開処理に対応する場合は、既存の公開ジョブの失敗区分も維持する。

### Workerが後から実行する場合

Alarmなどによる状態変化は、`actor_type = 'worker'`として記録する。`request_id`には、対応が分かる場合に元の要求を指定する。これにより、依頼元のクライアントと、実際にWorkerが処理した時刻を区別できる。

`invocation_id`は、DOのHTTP/RPC受付やAlarmの実行ごとにサーバーで発行するUUIDである。同じ実行内の履歴とWorkers Logsに共通して付ける。履歴の`worker_version_id`には実際に実行した版を記録し、操作開始時の版とは区別する。

### アップロードと削除の記録

`operation_assets`は、最初の保存先・サイズ・ハッシュを固定して保持する。保存成功の応答と、内容の検証、下書きへの反映を別々に記録する。削除の状態は`deletion_state`に分け、削除後も元のアップロード結果を確認できるようにする。

削除対象を確定するときは、対象ファイルと削除操作を`cleanup_operation_id`で関連付け、新たな公開での利用を止める処理とまとめて記録する。削除対象のファイルを列挙する索引も用意する。参照状況・送信終了・保存ファイルの一致は、実行時に別途照合する。

履歴の`request_id`は同じ操作の要求、`upload_id`はその操作のファイルまたは削除対象のファイルであることを確認する。こうした表をまたぐ業務上の条件は、DO内でSQL更新を確定する前に検査する。

## 5. 検索例

### あるクライアントから届いた要求

```sql
SELECT r.received_at_ms, r.client_id, r.cli_version,
       r.request_id, r.action, r.outcome,
       o.operation_id, o.kind, o.show_id, o.episode_id
FROM operation_requests AS r
JOIN operations AS o ON o.operation_id = r.operation_id
WHERE r.client_id = :client_id AND r.received_at_ms >= :since_ms
ORDER BY r.received_at_ms, r.request_id
LIMIT 50;
```

### 中断と再開を含む一つの操作の履歴

```sql
SELECT e.operation_version, e.recorded_at_ms, e.actor_type,
       r.client_id, r.cli_version, e.request_id,
       e.state, e.phase, e.invocation_id
FROM operation_events AS e
LEFT JOIN operation_requests AS r ON r.request_id = e.request_id
WHERE e.operation_id = :operation_id
ORDER BY e.operation_version
LIMIT 50;
```

Workerによる履歴では、結合先のクライアントは処理を依頼したクライアントを表す。実行主体は`actor_type`で区別する。

一覧APIでは次のページの位置を返し、続きの要求で残りを取得する。履歴は`operation_version`、要求一覧は受信時刻と要求IDの組を使ってページを区切る。

## 6. 記録の保持と容量管理

現在のDDLは、再開・結果照会・重複防止に必要な小さい記録を保持する構成である。初版は5テーブルを維持し、容量表示と警告を加える。初期の費用見積もりと警告基準は、[保存先比較の容量管理](sqlite_operation_record_storage_options.md#6-容量管理と記録の保持)を参照する。

操作・要求・ファイル識別情報と、開始・保存成功・検証・最終結果などの履歴を関連付けたまま保持する。版番号1の履歴は作成元の確認に、`expected_version`が指す履歴は要求の判断根拠の確認に使う。

将来、詳細な計測値や繰り返しの進捗情報をSQLへ追加する場合は、これらの必要な記録と分けて整理可能にする。現在の`operation_events`全体に保持期限を付ける方式にはしない。

容量表示にはDOの`databaseSize`を使い、全履歴を数え直す処理を状態確認のたびに行わない。SQLの読書き行数、索引の更新、整理に伴う書込みも含めて実際の利用量を確認する。

## 7. DDLの導入と確認

初期化時に記録用の形式番号を確認し、追加DDLをDOのstorage transactionで適用する。通常の状態変更にも`transactionSync`などのDO Storage APIを使う。外部通信はSQLトランザクションの外で行う。

導入時には、外部キーが有効なこと、未対応の形式番号を更新前に拒否することを確認する。まずローカルSQLiteでDDLと検索例を実行し、参照切れ、要求IDの重複、履歴番号の重複、保存結果と処理段階の矛盾、古い版番号での更新を検査する。DO上の永続化と同時実行は、実装後に隔離環境で確認する。

記録は操作結果の照会に使うため、操作・要求・必要な履歴を関連付けたまま保持する。書込み量は、状態と履歴に加え、要求と索引の更新も含めて計測する。

## 8. 実装したAPIとCLIの記録

管理APIは既存の管理キーで認証する。

| API | 用途 |
| --- | --- |
| `GET /admin/sqlite-operations/list` | 操作一覧とDB容量。`incomplete`、`cursor`、`parent`で絞り込む |
| `GET /admin/sqlite-operations/OPERATION_ID` | 操作、素材、要求、履歴。`after_version`と`request_cursor`で続きを取得する |
| `GET /admin/sqlite-operations/requests/REQUEST_ID` | 保存済み要求の結果を照合する |
| `GET /admin/sqlite-operations/cleanup/OPERATION_ID` | 取消済みuploadの削除候補と確認hashを取得する |
| `POST /admin/sqlite-operations/commands` | 登録、PUT開始、成功報告、検証・下書き登録、進行記録、取消、削除を指示する |

一覧・詳細の各配列は1ページ20件とし、応答は64KiB以内で読む。未完了の一覧は`operations_pending`、操作履歴は操作IDと版番号、要求の続きは受信時刻と要求ID、削除対象は`cleanup_operation_id`の索引を利用する。

RSS詳細の`summary=true`は、親操作の索引から子操作の状態別件数と直近5操作を返す。通常の状態更新ではこの集計を省き、取り込み件数に比例する検索を各処理段階で繰り返さない。サーバーに未着手のエピソード一覧は保存しないため、その件数は不明として表示する。

既存の公開APIは要求本文を変えず、`X-Castloop-Client-Id`と`X-Castloop-Cli-Version`から要求元を記録する。公開キューと操作記録を同じトランザクションで保存し、Alarmの実行・完了にも同じ実行の`invocation_id`を付ける。登録済み素材の利用可否の確認は、クライアント情報のヘッダーがない要求にも適用する。

新しいCLIの下書き・アップロード・RSS・変更要求のローカル記録は形式番号2で作成する。ローカルSQLiteはプロセス排他だけに使い、サーバーの操作記録とは別である。旧形式の記録は変換せず、残存`.lock`を検出した場合は更新しない。

RSS取り込みでは、親の`import_id`に、upload・公開・登録/ローカル配置の子操作を関連付ける。単独のShow登録の旧journal、init、Worker更新、サービスのpause/resumeは従来の専用記録で管理する。今回の5表へ既存操作を事後登録しない。

実装は`src/sqlite-operation-records.ts`、DDLは`src/sqlite-operation-schema.ts`、入出力の検証は`packages/shared/src/sqlite-operations.ts`に置く。[利用方法](../docs/sqlite_operation_recovery.md)と[確認結果](sqlite_operation_records_verification.md)を参照する。

## 関連資料

- [操作の確認・再開・取消](sqlite_operation_recovery_options.md)
- [保存先の比較とコスト](sqlite_operation_record_storage_options.md)
- [DO SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [SQLiteの外部キー](https://www.sqlite.org/foreignkeys.html)、[CREATE TABLEと制約](https://www.sqlite.org/lang_createtable.html)
