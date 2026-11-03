# 制御DOのSQLite構造に関する検討

> Issue #109の調査・比較検討を保存した記録です。本文の構成説明や行番号は調査時点を指します。現行の設計は[制御DO](../components/control-do.md)と[SQLite表設計](../data/sqlite.md)を参照してください。

対象: [Issue #109: [refactor] 制御DOのSQLiteにShow専用テーブル群が作成される構造の見直し](https://github.com/simosako/castloop-v2/issues/109)

調査対象: コミット `b578f14`、2026-11-02時点

この文書は改善案の比較です。制御DOのSQLiteに、制御経路で使わないShow専用の表が作られる現状を確認し、複数の変更案のメリットとデメリットを示して、推奨案を提示します。案Bを採用し、2026-11-02に実装しました。

ここでの制御DOは、Durable Object名前空間 `service/{service_id}` のインスタンスで、Show登録簿・カタログ集約・独自ドメインの状態を担います。Show DOは `show/{service_id}/{show_id}` のインスタンスで、番組ごとの公開内容・履歴・予約・配信統計を担います。ランタイム(runtime)は `SqliteServiceRuntime` とその構成部品の総称で、識別情報は service_id・worker_version_id・service_config_sha256 の3点組を指します。`publication_service` 表に永続するのはservice_idと設定ハッシュの2点です。

## 現状と課題

### 制御DOの構築と表の作成

WorkerのDOクラスは、制御DOインスタンスの初期化で [sqlite-worker.ts](../../src/sqlite-worker.ts) 110〜112行のとおり、`SqlitePublicationQueue` → `SqlitePublicationContent` → `SqliteServiceRuntime`(内包する `SqliteDomainRuntime`)をこの順に構築し、続けて `SqliteServiceControl` を構築します。各クラスのコンストラクタが表を作るため、新規の制御DOには次の16表と索引が作られます。

| 作成元クラス | 表 |
| --- | --- |
| `SqlitePublicationQueue` | `publication_queue_schema`、`publication_service`、`publication_schedules`、`publication_schedule_events` |
| `SqlitePublicationContent` | `publication_content_schema`、`publication_shows`、`publication_show_content`、`publication_episodes`、`publication_episode_content`、`publication_media`、`publication_show_revisions`、`publication_episode_revisions`、`publication_site_ids` |
| `SqliteDomainRuntime`(`resolveSqliteRuntime` 経由を含む) | `publication_domain_changes` |
| `SqliteServiceControl` | `service_show_registry`、`service_domain_connection` |

[表設計](../data/sqlite.md)はこの現状を「制御DOにも共通の初期化処理で内容・予約の表が作られます」と記載し、該当する表を「空の共通表」と呼んでいます。

### 制御経路で実際に使う表

| 表 | 使用 | 根拠 |
| --- | --- | --- |
| `publication_service` | 使用 | 識別情報の照合(`SqlitePublicationQueue.identity`)、ドメイン確定時の設定ハッシュ更新(`changeConfiguration`)、新規初期化検査(worker 109行が表の存在を確認) |
| `publication_domain_changes` | 使用 | ドメイン変更の準備・確定・照会(`SqliteDomainRuntime`)、準備中判定(`pendingSqliteDomain`)、稼働識別の解決(`resolveSqliteRuntime`) |
| `service_show_registry` / `service_domain_connection` | 使用 | 登録簿と最終確定済み接続情報(制御DO固有、`SqliteServiceControl`) |
| `publication_queue_schema` | 使用 | 公開基盤の形式版の照合 |
| `publication_content_schema` | 使用(形式版の照合のみ) | `resolveSqliteRuntime` が表の存在時に版を照会するが、制御経路で内容表は読まない |

### 制御経路で使わない表とコード

- コンテンツ8表: `SqliteServiceRuntime` のうちコンテンツを読むメソッド(`catalog`・`inspect`・`contentSnapshot`・`previewInventory`・`revisions`・`revisionDetail`)は `createSqliteServiceHttp` からしか呼ばれず、このHTTPハンドラを接続するのは `SqliteShowService` だけです。制御DOのHTTP(`createSqliteControlHttp`)はhealth・登録・カタログ集約・ドメイン操作だけを扱い、カタログも各Show DOへの問い合わせ結果を集約します。
- `publication_schedules` / `publication_schedule_events`: 読み書きするのは `SqlitePublicationSchedules` だけで、これを構築するのもShow DOだけです。alarmによる予約実行も、workerの `alarm()` はShowインスタンス(`this.show`)でのみ動きます。
- `SqliteDomainRuntime` へ渡す `content` と `cache` は、Showスコープ(`showId` がある場合)だけで使われます。制御DO分岐でworker 111行が構築する `cache` も、ドメイン確定時のパージがShowスコープ限定のため、制御DOでは未使用のままです。

### 発生理由

`SqliteServiceRuntime` のコンストラクタが `queue` と `content` を必須とし、`SqlitePublicationQueue` のコンストラクタが予約表のDDLを抱えています。このため、識別情報とドメイン状態だけが必要な制御DOでも、Show DOと同じ構成一式が作られます。

## 目指す状態と制約

目指す状態は、新規の制御DOに作られる表が「識別・形式版・ドメイン変更・登録簿・接続」の5表(`publication_queue_schema`、`publication_service`、`publication_domain_changes`、`service_show_registry`、`service_domain_connection`)とドメイン変更の一意索引だけになることです。

制約はIssueと[作業規則](../../AGENTS.md)によるものです。

- DOクラス名・バインディング・compatibility date・永続化済みSQLite形式を維持する。
- 既存の制御DOにすでに作られた未使用表を削除する移行は行わない(残置しても実害はストレージ量のみ)。
- ワイヤープロトコルと共有スキーマは変えない。

## 案

以下の案A・案Bはどちらも「予約表DDLの移動」と「制御DOでのコンテンツ構築の廃止」を含み、違いはランタイムクラスの扱いです。

### 案A: 共有クラスのまま、制御DOだけ構築内容を変える

`SqliteServiceRuntime` を両DOで共有したまま、依存の注入を役割に応じて変えます。

1. 予約表2表とその索引のDDLを `SqlitePublicationQueue` のコンストラクタから `SqlitePublicationSchedules` のコンストラクタへ移動します(Show DOでは同じDDLが同じ構築順で実行されます)。
2. `SqliteServiceRuntime` と `SqliteDomainRuntime` の `content` を任意にし、制御DOでは `SqlitePublicationContent` を構築しません。`cache` は構築し続けます(`SqliteDomainRuntime` が必須引数のままのため)。

メリット:

- 変更範囲が小さい。共通のDDL移動に加え、worker・ランタイム2クラス・テストフィクスチャの修正で完了します。
- ランタイムクラスは1つのままなので、クラス構成の読み替えが不要です。

デメリット:

- 「contentを持たないランタイム」という中間状態が型に表れません。コンテンツ系メソッドは制御側インスタンスでは動かないため、呼び出されない前提の防御チェックか実行時エラーで表すことになります。呼び出し経路が存在しない防御は加えないという作業規則と衝突します。
- 制御DOで使わないメソッドがインスタンスに残り、1クラスに2通りの構築モードという暗黙の契約が読み手の負担になります。これはIssueが挙げる「共有することが読みやすさを損なわないか」という懸念そのものです。
- 未使用の `cache` 構築が制御DOに残ります。

### 案B: 制御DO専用の構成に分ける(採用・実装済み)

`SqliteServiceRuntime` をShow専用にし、制御DOは必要な部品だけを直接構成します。

1. 案Aと同じく、予約表DDLは `SqlitePublicationSchedules` へ移動します。
2. `SqliteServiceRuntime` は `SqliteShowService` 専用にし、`content` は必須のまま変えません。
3. `SqliteDomainRuntime` のコンストラクタを `(storage, queue, config, actual, scope?)` に変え、Showスコープの依存を `scope?: { showId, content, cache }` に集約します。`SqlitePublicationQueue` の `scope?: { showId, ready }` と同じ形で、制御DOはscopeなしで構築します。`commit` 内の `this.showId` 参照は `this.scope` に読み替えます。
4. `health` と `requireTarget` の本体を `sqlite-service-runtime.ts` からexportする共有関数(例: `sqliteRuntimeHealth(actual, ready)`)として切り出し、`SqliteServiceRuntime` のメソッドと制御側の両方から呼びます。実装は1箇所のままです。
5. `SqliteServiceControl` のコンストラクタを `(storage, queue, domains, actual, peer)` に変え、`runtime` への依存を除きます。識別情報の照合は `queue.identity()`、health応答は共有関数で組み立てます。
6. workerの制御DO分岐は `queue` + `SqliteDomainRuntime` + `SqliteServiceControl` だけを構成し、`SqlitePublicationContent` と未使用の `cache` を構築しません。Show DO分岐(`openShow`)は変更しません。

メリット:

- 各DOが必要な部品だけを構成し、制御DOの表が目指す状態(5表)に一致します。
- 型が正直になります。contentを持たないランタイムや、使わないメソッドを持つインスタンスが存在しなくなります。
- 共有すべき論理(識別情報・ドメイン変更・health応答の形式)はキュー、`SqliteDomainRuntime`、共有関数として1箇所のままで、構築だけが役割ごとに分かれます。
- 制御DOでの未使用の `cache` 構築もなくなります。

デメリット:

- 変更点が案Aより多いです(`SqliteServiceControl`・`SqliteDomainRuntime`・`SqliteServiceRuntime`・worker・テストフィクスチャと、`f.runtime` を使う既存テスト数か所)。
- ランタイムの構築経路がShow経由と制御直構成の2つになります。ただしドメイン処理の本体は同一クラスなので、動作の重複はありません。

### 案C: 制御DO専用のランタイムクラスを新設する

案Bの構成に加え、キューとドメインランタイムとhealth応答をまとめる制御専用クラス(例: `SqliteControlRuntime`)を新設します。

メリットは、制御側の構築コードが1クラスにまとまることです。デメリットは、委譲するだけのラッパークラスが増え、既存の直接コードを迂回させることです。新しいふるまいを追加しないラッパーは作業規則が避ける対象のため、採用しません。

### 現状維持(比較のため)

機能障害はありません。ただし新規の制御DOに毎回11表の未使用表と索引が作られ、表設計は「空の共通表」という例外を説明し続けます。Issueの優先度(中)のとおり、構造的な整理課題です。

### 案の比較

| 観点 | 現状維持 | 案A | 案B | 案C |
| --- | --- | --- | --- | --- |
| 新規制御DOの表 | 16表 | 5表 | 5表 | 5表 |
| 変更規模 | なし | 小 | 中 | 中 |
| 型の表現 | 変更なし | contentが任意になり曖昧 | 各クラスが必須依存のみを持つ | 案Bと同じ |
| 共有論理の重複 | なし | なし | なし(構築のみ分離) | なし(委譲層が一段増える) |
| 作業規則との適合 | 問題なし | 呼び出しのない防御が必要になり衝突 | 適合 | ラッパー追加として衝突 |

## 推奨: 案B

Issueが評価軸に挙げた「ランタイムクラスの分割がコードの読みやすさを損なわないか」について、制御経路がランタイムから使うのはhealth・ready・`requireTarget`・識別情報・ドメイン処理だけです。このうち識別情報はキュー、ドメイン処理は `SqliteDomainRuntime` が元から担っており、分割しても各DOが使う部品は同じクラス・同じ関数のままです。healthと `requireTarget` も共有関数にすれば実装は1箇所を保てます。逆に共有を続けると、「contentなし構築」という中間状態を型か実行時チェックのどちらかで表すことになり、読みやすさを損ないます。このため案Bを推奨します。

## 案Bの実装メモ

変更の順序とファイル:

1. [sqlite-publication-schedules.ts](../../src/sqlite-publication-schedules.ts): 予約表2表と索引のDDLをコンストラクタで作成します(`CREATE TABLE IF NOT EXISTS` のまま)。
2. [sqlite-publication-queue.ts](../../src/sqlite-publication-queue.ts): 予約表のDDLを削除します。
3. [sqlite-domain-runtime.ts](../../src/sqlite-domain-runtime.ts): コンストラクタを `(storage, queue, config, actual, scope?)` に変更し、`commit` 内の `this.showId` 参照を `this.scope` に変更します。
4. [sqlite-service-runtime.ts](../../src/sqlite-service-runtime.ts): `health` と `requireTarget` の本体をexport付きの関数に切り出してメソッドから呼び、`domains` の構築にscopeを渡します。
5. [sqlite-service-control.ts](../../src/sqlite-service-control.ts): `runtime` を `queue`・`domains`・`actual` に置き換えます。
6. [sqlite-worker.ts](../../src/sqlite-worker.ts): 制御DO分岐を新しい構成に書き換えます。
7. [テストフィクスチャ](../../packages/cli/src/test-support/sqlite-service.ts): `boot()` の制御構成を新しい構成に合わせます。
8. テスト: `f.runtime` を使う箇所(`sqlite-cli-entrypoint.test.ts`・`sqlite-commands.test.ts`・`sqlite-domain-operation.test.ts`・`sqlite-initialization.test.ts`・`sqlite-show-separation.test.ts`)を読み替えます。加えて、新規の制御構成で `sqlite_master` に作られる表が制御5表とドメイン変更の一意索引だけであることを検証するテストを追加します。

互換性の確認:

- 表のDDLは同一で、作成するクラスと実行の契機が変わるだけです。保存形式の互換性は変わらないため、`publication_queue_schema`(版14)と `publication_content_schema`(版13)の版番号は変えません。
- 既存の制御DOにある未使用表はそのまま残ります。`resolveSqliteRuntime` は `publication_content_schema` が存在する場合だけ版を照合し、現行版と一致するため問題ありません。
- 新規初期化検査(worker 109行の `publication_service` 存在確認)と、ドメイン確定による `publication_service` の設定ハッシュ更新の経路は変わりません。
- DOクラス名・バインディング・compatibility date・ワイヤープロトコル・共有スキーマに変更はありません。

ドキュメント更新(実装と同じ変更で行う):

- [表設計](../data/sqlite.md): 「配置と表一覧」の制御DO列を「作成しない」に変更し、「空の共通表」の注記を、既存の制御DOには残置表がある旨の説明に置き換えます。予約表のDDL所在も更新します。
- [制御DO設計](../components/control-do.md): 制御DOの保存表が識別・形式版・ドメイン変更・登録簿・接続の5表であることを明記します。
- [Show DO設計](../components/show-do.md)と[全体構成](../architecture.md): 初期化の説明に関わる部分があれば合わせて更新します。

確認は `bun test` と `npm run check` を実行します。

## スコープ外

- 既存の制御DOにある未使用表の削除(移行は行わない)。
- DOクラス名・バインディング・ワイヤープロトコル・共有スキーマの変更。
- 表数削減によるストレージ使用量の定量評価。
