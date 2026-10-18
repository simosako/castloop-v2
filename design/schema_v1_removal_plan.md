# v0.6.0: schema version 1サービスのコード削除計画（Issue #24）

作成日: 2026-10-18。調査基準: `c83152d97cd0cab57b7dc5194e87dfba4ad026eb`（v0.5.2）。

本書は[Issue #24](https://github.com/simosako/castloop-v2/issues/24)と関連Issue・現行コードを確認した実施計画である。計画作成後、管理者から開発の承認を受け、`feat/schema-v1-removal`でローカル実装・検証を行った。結果は末尾に記録する。バージョン変更・リリース・実環境操作は行わない。

## 1. 目的とリリース境界

管理者の方針を次のように適用する。

| 系列 | サービス設定と対応方式 | 方針 |
| --- | --- | --- |
| v0.5.x | `schema_version = 1`のQueue/R2方式、`schema_version = 2`のSQLite方式 | 既存機能を維持する。今回の削除やSQLite既定化をバックポートしない |
| v0.6.0以降 | `schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`のみ | Queue/R2方式のCLI・Worker・専用スキーマ・専用テストを削除する |

目的は非推奨警告を足すだけではなく、二方式の分岐とQueue専用実装を実際にコードベース・配布物から取り除くこと。SQLiteのprotocol、サービス設定、保存形式、公開URL/object keyはこの整理のために変更しない。

- 削除はv0.6.0向け開発で行う。v0.5.xのタグ・配布物・履歴を変更しない。
- 現在`release/v0.5.2`が存在するが、v0.5.x全体の保守ブランチ名・期間・新規パッチリリースは別途決める。実装前に保守先を確認し、削除変更を混入させない。
- 共通の不具合修正をv0.5.xへ反映する場合は、必要部分だけを個別に選び、QueueとSQLiteの両方をその保守先で検証する。
- v0.6.0のリリース告知で、Queue利用者はv0.5.xのCLI／Workerを維持する必要があることを明示する。v0.5.xを無期限に保守する約束は追加しない。
- 管理者の追加指示により、CLIの新規作成はサービス設定のschema version 2をデフォルトかつ唯一の対応形式とし、旧サービス設定version 1からのマイグレーション機能は実装しない。

## 2. Issueの理解と関連課題

Issue #24の本文は「今後機能追加しないschema version 1を廃止し、コードベースを削減する」という提案で、コメントはない。削除時期とv0.5.x維持の境界は今回の管理者指示で具体化された。

| Issue | 確認した内容 | 本計画での扱い |
| --- | --- | --- |
| [#28](https://github.com/simosako/castloop-v2/issues/28)（open） | Queue専用の匿名runtime probeがR2読取負荷・runtime識別情報取得を起こせる。SQLiteには同routeがない | v0.6.0ではdomain操作と旧probeを削除する。v0.5.xや既存配備のリスクが消えるとは扱わず、追加対策・Issueの扱いは別判断 |
| [#33](https://github.com/simosako/castloop-v2/issues/33)（closed） | 旧#10/#11/#13と現行SQLiteの適用範囲を棚卸し済み | 調査済みのprotocol分離と未知IOの保全を引き継ぐ。本文の「#11はopen」は棚卸し時点で、その後の完了コメントを優先する |
| [#10](https://github.com/simosako/castloop-v2/issues/10)、[#13](https://github.com/simosako/castloop-v2/issues/13)（not plannedでclosed） | 旧RSS公開の状態検証エラー、旧Queue consumer取消後のtoken残留。廃止予定を受け追加調査を終了 | 削除のために再調査・実機再現しない。closeやコード削除を根本原因確定・完全修正とは表現しない |
| [#11](https://github.com/simosako/castloop-v2/issues/11)（completedでclosed） | 元はQueue更新のupload-only停止。後にSQLiteの配備後GET失敗も別経路として修正・実機検証済み（PR #37/#38） | Queueの更新経路は削除する一方、SQLiteのPUT成功checkpoint・明示検証続行・旧journalの拒否境界は残す |
| [#34](https://github.com/simosako/castloop-v2/issues/34)（open） | 共通化後のテスト重複監査。Queue専用テストの大規模整理は#24に連携 | 削除した機能だけのテストは本件で除く。共用処理の試験を名前や見た目だけで消さず、一般的な重複監査は#34へ残す |
| [#1](https://github.com/simosako/castloop-v2/issues/1)（open） | RSSからの移行機能 | ローカル取り込みとSQLiteへの明示公開は維持する。旧Queueへの公開runnerだけを除く |

[#29](https://github.com/simosako/castloop-v2/issues/29)・[#30](https://github.com/simosako/castloop-v2/issues/30)のCI不安定性はそれぞれ別件として修正済みであり、その回帰試験をQueue整理の名目で削除しない。RSS取得のBun/DNS互換性（[#32](https://github.com/simosako/castloop-v2/issues/32)）やメタデータ項目別上限（[#31](https://github.com/simosako/castloop-v2/issues/31)）も本件へ取り込まない。

## 3. 削除対象の定義：`schema_version = 1`の全消去ではない

ここで廃止するのは、**サービス設定のschema version 1で選択されるQueue/R2方式**である。各ファイル／要求のschema versionは独立している。

SQLiteも次のversion 1を使用しており、変更・削除しない。

- Show入力、Episode下書き、公開Episode revisionの`schema_version = 1`。
- `sqlite-publication.ts`の公開要求、SQLiteのAPI／journal等にある独立したversion 1。
- protocol名`sqlite-sequential-v1`。末尾の`v1`はサービス設定versionとは無関係。
- 既存SQLite更新journalの互換読み取りと、証拠不足の旧journalを拒否する検査。

Queue側にもversion 2の更新journal等があるため、version 2だから残すという判定も行わない。文字列検索は棚卸しの入口に限り、呼出元・責務・永続形式ごとに判定する。サービス設定をversion 3へ上げたり、メタデータを一括version 2化したりしない。

## 4. 調査済みの変更箇所

以下は削除・分離の候補範囲であり、ワイルドカードでの一括削除指示ではない。実装時にシンボル単位の利用元とテストを確定する。

### 4.1 CLI・配布経路

| 箇所 | 現状と変更方針 |
| --- | --- |
| `packages/cli/src/index.ts` | 二方式のinit、設定分岐、M6実行、domain、Queue job alias、二Workerのbundle取得を一本化する。SQLite側でも一覧引数検査が`M6_COMMAND_ARGUMENTS`に依存するため、必要な引数表を先に独立させる |
| `packages/cli/src/workspace-config.ts` | version 2以外をQueue schemaへ渡す現在のfallbackを廃止。上限付き・通常ファイル・symlink拒否・厳密UTF-8読取を維持し、version 1を明示拒否する |
| `packages/cli/src/m6-*.ts`、Queue専用のclient／operation／journal群 | 旧init/update、Show登録、staging/publication、target/status、lifecycle、async管理を削除。共用処理の抽出後に参照がなくなったものだけを消す |
| `packages/cli/src/domain-*.ts`、`management-queue-client.ts`、旧`cloudflare-api.ts` | Queueのdomain・資源作成／更新・通知／送信に限定される実装を除く。SQLiteの`SqliteCloudflareApi`へ旧機能を移植しない |
| `packages/cli/src/help.ts` | Queue grant・Queues Edit・published/released・pause ID再利用の説明と旧専用commandを除き、SQLiteの契約を本文にする |
| `scripts/build-cli.ts`、`packages/cli/src/worker-payload.ts` | `src/sqlite-worker.ts`のbundleだけを生成・埋め込む。旧sourceとM6 compatibility dateへの依存を除く |
| `.github/workflows/build-binaries.yml` | domain等の旧command smokeと二方式helpの期待値を更新し、SQLite既定init・旧設定拒否を検査する |

`sqlite-*`の公開型・ファイル名をこの機会に全面改名しない。既存の`src/sqlite-worker.ts`を正式入口として維持し、旧`src/worker.ts`は不要になれば削除する。DO class名`SqlitePublicationService`、cache export名`SqliteCachedAssets`、binding名、compatibility dateを整理だけの理由で変更しない。

### 4.2 Worker・shared

- Worker: `src/worker.ts`、`m6-*`、`management-queue-consumer.ts`、`queue-delivery.ts`と、旧publication/staging/登録/lifecycle/domain/service admissionの専用実装を削除する。
- Queue用R2正本のcontrol、reservation、job/status/progress、execution token、公開判定projection、Queue通知／DLQ／probeを新Workerから除く。SQLiteのSQL FIFOを意味する`SqlitePublicationQueue`は残す。
- `src/worker.ts`が持つ`Cloudflare.GlobalProps.mainModule`の型宣言は、SQLite単独のmoduleへ合わせて移す。旧Worker削除後も`ctx.exports`の型検査を通す。
- `packages/shared/src/index.ts`はQueueのサービス設定・job・target・大量のre-exportと、共通メタデータ／hash／TOML処理が混在する。共通部分とSQLite向けexportを残し、旧専用schema／型／parse関数とその依存を除く。
- sharedの`async-management`、旧publication／staging／lifecycle管理、service admission、M6 setup/deployment、domain等は利用元確認後に除く。ファイル全体を残す必要がない混在moduleは、先に共通定義を分離する。
- `worker-configuration.d.ts`はプラットフォームの共通型である。汎用の`Queue`型等が含まれることを理由に手編集・再生成・削除しない。

### 4.3 先に分離すべき共用部分

実際に次の依存があり、「旧ファイル名だから削除」するとSQLiteも壊れる。

| 現在の依存 | 先行して行う分離 |
| --- | --- |
| `sqlite-rss-publication.ts` → `rss-import-publication.ts`の`writeImportedMetadata`／`verifyImportedFeed` | metadata設置・feed照合を方式非依存moduleへ移し、その後に旧RSS公開runnerを削除する |
| `sqlite-draft.ts`／`sqlite-upload.ts` → `staging-sources.ts` | `inspectLocalStagingSource`、`assertLocalStagingSource`、`freezePayloadSources`と型を残し、旧`freezeStagingSources`／`StageUploadRequest`への依存を切る |
| `verified-r2-put.ts` → shared `staging.ts`のreceipt schema、SQLiteの`StagePayload`利用 | asset／payload／ETag・versionの共通検証を独立させ、旧stage-start／generation／settlement protocolだけを削除する。上限・検証・保存済み値を変えない |
| `sqlite-worker.ts` → `lifecycle-cache.ts` | 共用の`serveCachedLifecycleAsset`と型を残す。旧専用purgeとtransportは利用元を確認して除き、SQLiteの`purgeSqliteCache`を維持する |
| `public-assets.ts`／`lifecycle-cache.ts` → 旧`lifecycle-control`／`lifecycle-gateway`の型 | 共通のasset/cache props等を独立させ、旧visibility snapshot変換や型だけの依存も除く |

そのほか、`feed.ts`、`media-url.ts`、認証・本文上限・管理response、MP3解析、bounded HTTP reader、ローカルmetadata/journal IO、`.gitignore`保護、RSS download/feed/local/preflight、hash、一覧table整形と対応テストを残す。各共用moduleに残る旧family分岐・型・helperは、利用元がなくなった段階で狭める。

## 5. v0.6.0の外部仕様

### 設定・初期化

- 現行CLIで方式を明示する指定は`init --publication-protocol sqlite-sequential-v1`であり、`--schema-version`オプションではない。この指定によりサービス設定の`schema_version = 2`を生成している。
- v0.6.0では`castloop init`だけで`schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`のサービスを新規作成する。方式・schemaの選択を必須にせず、新たな`--schema-version`オプションや対話でのversion選択も追加しない。
- 既存スクリプトのため`--publication-protocol sqlite-sequential-v1`は引き続き受け付ける。それ以外の指定は拒否し、Queue作成の選択肢を残さない。
- 保存するサービス設定は既存のversion 2形式のまま。Queue名・DLQ名を生成しない。
- README・help・通常の操作例は方式指定なしの`castloop init`を基本とし、既存flagは省略可能であることを明記する。
- version 1設定を検出したら、v0.6.0では非対応であることとv0.5.x利用の案内を出し、終了コード1で停止する。未知version・欠落・不正設定も拒否し、変換しない。
- 旧設定での`init`再実行を含め、ネットワーク要求・Worker build／配備・管理鍵／journal／素材作成・設定の上書きに進む前に拒否する。既存workspaceと`.castloop/`のbytesを変更しない。
- `help`／`--version`／workspaceを使わない`import-rss`は引き続き設定なしで利用できる。

### commandの整理

| 区分 | 扱い |
| --- | --- |
| init、Show/Episode作成・update・publish、target、一覧、job/service status、pause/resume、deploy、RSS | SQLite実装を唯一の経路とする。`deploy`から内部`update-service`への既存振り分けも維持する |
| `init-reconcile`、`init-continue-verification`、`update-service-verify`、`update-service-reconcile` | SQLiteにある厳密な照合・限定続行だけを維持する |
| lifecycle preview／execute、`operation-status lifecycle JOB` | SQLiteのunpublish/restoreを維持する。`job-status`によるlifecycle照会も残す |
| domain、retry/release系、`update-service-continue`、`local-operation-status`、旧staging/publication/show-registrationのstatus family | 旧専用command／alias／help／dispatcherを除く。入力されても明示エラーで終了し、鍵作成やIOへ進まない |
| lifecycle delete／旧削除用ack | SQLiteでは非対応のまま明示拒否。旧delete実装を救済経路として残さない |

SQLite既存の任意MP3引数の照合など、対応済みcommandの入力互換を不要に変えない。resumeは新しい受付window UUID、公開完了は該当jobの`succeeded`であり、Queueのpause IDや`published/released`の契約を持ち込まない。

### 既存サービスと移行

- v0.6.0のCLIへ交換しても既存Queue Workerは変化せず、削除・停止・安全性改善も自動では起こらない。Queueの運用・照会は対応するv0.5.xを別途保持して行う。
- v0.6.0 CLIからQueue Workerへdeployする経路を設けない。TOMLのversionだけを書き換える案内、既存bucket／namespace採用、dual-write、自動fallbackは行わない。
- 旧サービス設定version 1からversion 2へのマイグレーション機能は実装しない。専用移行command、in-place移行、設定・R2制御記録・旧journalの変換を提供せず、リリース条件にもしない。既存RSS取り込みを使う場合も、新しいworkspace／資源／Showへの別の明示操作であり、旧購読先・URLの自動移行や旧ホスト撤去を意味しない。
- 既存SQLiteは同じconfig/schema/namespaceのcode-only更新契約を維持する。ただし未完了init/updateの凍結source hashは新CLIの組み込みcodeと異なり得る。記録を再hash・昇格せず、適合する旧CLIでの照合／完了と、更新前の停止・drain確認を案内する。未知IO・blockedを先に解放してアップグレードする手順は作らない。

## 6. 実装順序とレビュー単位

### P0: 範囲と基準を固定

1. v0.6.0向け作業先とv0.5.x保守先を確認する。タグ・既存リリースを削除変更から隔離する。
2. `bun test`、`npm run check`、Linux CLI buildの基準結果を保存する。source／テスト行数・bundle／binaryサイズは同一条件で測り、未測定の削減率を宣言しない。
3. ファイル／シンボルごとに「Queue専用／SQLite／共用／テスト・文書」を分類し、本書の候補を確定する。静的importだけでなくre-export、動的import、build plugin、独立process preload、型参照も調べる。

### P1: 共用部分を先行分離

1. 4.3のRSS helper、upload素材・receipt、配信・型を分離する。
2. この段階は両方式の振る舞いと保存形式を変えず、既存の対象テスト・全体テスト・型検査を通す。
3. 共用試験の検証責務を対応付け、Queue専用テストからしか検査されていない共用の安全条件は独立テストへ移す。

### P2: CLIをSQLite単独化

1. 設定読取をSQLite専用にし、旧設定の副作用前拒否を追加する。
2. initの既定化、引数検査の独立、dispatch／status family／helpを整理する。
3. source-processの正式entrypoint試験で、新しい既定initと旧入力拒否を検証する。

### P3: 旧実装と配布物を削除

1. CLIから旧専用client／runner／journal／Cloudflare APIを削除する。
2. Queue Workerと専用管理・公開・配信判定・shared schemaを削除し、共通indexの旧exportを除く。
3. SQLiteのmodule型宣言・単一Worker埋め込み・CI smokeを整える。
4. 削除機能だけのテスト・fixture・preloadを削除する。共用fixtureは最小単位へ分け、SQLiteと共通安全条件の試験は残す。

P2/P3は依存関係上、同じレビュー単位にまとめてもよい。ただし各統合点でbuild・型検査が通る状態にし、未完の中間版をリリースしない。大規模な命名変更、抽象化、性能改修を同時に行わない。

### P4: 文書・リリース境界を整備

- `README.md`、SQLite／RSSガイド、`design/initial_design.md`をSQLite唯一の現行仕様へ更新する。旧方式のinit既定・Queues権限・domain/delete対応を現行仕様として残さない。
- `docs/queue_service.md`と旧domain手順はv0.5.x専用の保存先／案内として明示し、v0.6.0の通常操作から外す。旧版タグをたどれる導線を残す。
- Queue専用設計は実装完了時に`design/archive/`へ移し、適用版と歴史資料であることを明示して索引・リンクを直す。共用の安全契約やSQLiteの未解決制限まで一括アーカイブしない。
- `AGENTS.md`は実装完了後に現行のSQLite参照先・正式入口へ更新する。未知IO・明示公開・immutable履歴・配信gate・実環境承認の共通規則は残す。
- v0.6.0のrelease notesに破壊的変更、v0.5.x利用方法、非対応の移行／domain／deleteを記載する。version更新とタグ／公開はリリース時の別作業とする。

## 7. 検証計画・完了条件

### 拒否と互換性

- [x] 正式CLIでflag省略initと明示SQLite initが同じversion 2設定を生成し、Queue／DLQ／R2通知APIを呼ばない。
- [x] help・通常操作例が方式指定不要のinitを案内し、version選択や旧version 1からの移行commandを追加していない。
- [x] 最小・通常・任意項目付きversion 1設定、未知version、不正設定を拒否する。既存旧workspaceでのinitを含め、fetch／鍵／journal／upload／配備が0回で、設定・既存記録が不変である。
- [x] 削除command／旧status family／lifecycle deleteの入力を副作用前に拒否し、helpに対応済みとして表示しない。
- [x] 共通Show/Episode/revisionのversion 1とSQLiteのversion 1要求・既存journalが引き続き読める。旧Queue journalはSQLite journalとして採用しない。

### 残す機能の回帰

- [x] fresh init → paused → 新windowでresume → Show/Episode公開 → status → pause、一覧pagination、target照会を通す。
- [x] metadata-only／audio-only、GUID・日時・音源URL・不変revision、RSS取り込み／続行／feed照合を維持する。
- [x] upload前上限、MP3解析、source EOF完了順序、全量readback/hash/size/ETag/version、source差替え拒否、失敗時submit 0回、IO settlementを維持する。
- [x] FIFOの原子的受付、stale base/runtime/config/window拒否、未知POST/PUT非再送、running再実行禁止、blocked後続停止、allowlist診断・秘密非出力を維持する。
- [x] unpublish/restoreの保存snapshot・子状態・世代照合、paused/blocked/readinessと承認済みpathの配信gate、GET/HEAD/Range/304、system/staging非公開、purge-before-success、cache世代分離を維持する。
- [x] SQLite code-only更新、PUT checkpoint、`update-service-verify`／reconcile／initの限定続行、未知配備・旧receipt-free journal拒否を維持する。

### 削除と配布物の確認

- [x] Queue専用実装へのimport／re-export／型参照／build参照が残らず、旧実装を別名の互換moduleやbundleへ退避していない。
- [x] 残る`schema_version = 1`、`queue`、`M6`等の検索結果を用途別に説明できる。SQLite FIFO、共通型、履歴文書の存在を削除漏れと誤判定しない。
- [x] 単一SQLite Workerのbrowser bundleと、`npm run build:cli -- linux-x64`が成功する。ソースと単体binaryでversion/help、旧設定拒否、引数エラーを確認する。
- [x] `bun test`、`npm run check`、`git diff --check`と更新したCI smokeが成功する。削除したテストと残した／移設した共通の検証責務を記録する。
- [x] 変更した文書のリンク・適用版が整合し、v0.5.xの継続利用とv0.6.0の非互換を明記している。

テスト数・時間・サイズが減ったことだけを合格条件にせず、残るSQLiteの契約を基準にする。ローカル試験だけでCloudflare native挙動・全Free適合・300MB実機公開・#13恒久解消を主張しない。

## 8. 対象外・安全境界

- Cloudflareへの配備、resume／公開、移行、資源作成・削除、domain/DNS・証明書・権限・課金／CPU変更は本計画の作成・コード整理に含まない。必要なら対象と範囲の別承認を得る。
- コード削除は既存Queue資源やR2オブジェクトのcleanupではない。保持サービス`sq16r-6ec01dc6`、非テストDNS、共有証明書、ローカル原本・journal・private証跡を変更しない。
- 旧jobの成功への書換え、token／lockの強制解放、期限による失効、DLQ／空queue／HEAD不在を根拠にした未知IO再送を行わない。
- 物理delete、独自domain、既存移行、blocked retry/release等のSQLite新機能を、Queue削除の穴埋めとして追加しない。機能同等化はv0.6.0の本件完了条件にしない。
- GitHubへのコメント・Issue close・PR・push、リリース公開は今回のローカル開発には含まない。

## 参照する現行契約

- [SQLite操作・制限](../docs/sqlite_sequential_development.md)、[SQLite公開の実装計画](sqlite_sequential_publication_implementation_plan.md)
- [SQLite Worker更新の検証続行](sqlite_worker_update_recovery.md)
- [Queue操作（v0.5.x）](../docs/queue_service.md)、[Queue非同期管理](archive/async_management_implementation.md)
- [配信判定projection](archive/public_delivery_projection.md)、[明示公開・保持・安全方針](m6_review_queue.md)
- [旧実装整理で分離した検証責務](archive/v050_redundancy_refactor.md)

## 9. ローカル実装結果（2026-10-18）

### 到達範囲

- 新規initをversion 2既定にし、明示SQLite flagも維持した。旧設定は`loadWorkspaceConfig`でv0.5.x利用を案内して拒否し、変換しない。
- CLIのQueue分岐・旧専用command/status family、Queue Worker・R2制御記録の管理・署名／通知／DLQ／匿名probe・専用schemaとfixtureを削除した。旧moduleのコードを互換moduleへ退避していない。
- `src/sqlite-worker.ts`単独の型宣言・browser bundle・CLI埋め込み・CI smokeへ変更した。DO/cache export・binding・compatibility date・永続形式は維持した。
- `rss-publication-content.ts`へmetadata設置／feed照合を分離し、shared `upload.ts`へasset/payload/receipt検証を移した。`staging-sources.ts`、`lifecycle-cache.ts`、`public-assets.ts`、`publication-inputs.ts`はSQLiteが使う部分だけを残した。
- Queue設計本文をarchiveへ保存し、以前のパスは履歴への短い案内にした。共通安全方針は直下に残し、適用範囲を明示した。README／help／操作ガイドはSQLite単独の現行仕様と、未リリース・v0.5.xとの差を案内する。
- `release/v0.5.2`は調査基準commitのまま変更していない。package versionもリリース作業までは0.5.2のままなので、開発binaryを公開済み0.5.2と同一視しない。凍結sourceを持つ未完了操作のため、適合する旧CLIを保持する。

### テスト整理と共用の検証責務

| 削除・整理した範囲 | 残した／移設した検証 |
| --- | --- |
| Queue staging/publication／旧RSS runnerとその統合fixture | SQLite draft/upload/publication/RSS統合試験を維持。素材・receipt上限は`upload.test.ts`、metadata変更拒否と公開feed identityは`rss-publication-content.test.ts`へ独立化 |
| 旧family固有journalとvalidation試験 | generic storage/readの単体試験を維持し、path試験をSQLite各family＋RSS downloadへ変更。symlink parent・dangling lock・parent差替え・別owner lock保全を検証 |
| 旧gateway／R2 visibility props変換／専用purge | 共通cache handlerのstream/HEAD/Range/304/412/416/size/props/path試験を残し、SQLite gatewayの最新判定・世代分離・秘密非転送とSQLite purge試験へ対応付けた |
| 旧service config／commit／HMAC protocolの試験 | 旧サービス設定の拒否試験を追加。共通metadata・GUID・XML・日付・hashと管理鍵のnative照合／標準HMAC fallbackの試験は維持。削除したHMAC helperは旧Queue署名だけの用途 |
| 旧command help／binary smoke | 全残存commandのworkspace不要help、旧command/family/deleteの副作用前拒否、SQLite一覧TSV/JSON、単体binaryの旧設定拒否へ更新 |
| 旧upload wrapper | EOF順序（#30）、readback/hash/size/object identity、秘密非出力、source変更・symlink拒否、active IO中のdispose/reuse拒否と非再送の試験を維持・追加 |

#29のnative tail試験と#30のsource completion回帰は残している。一般的な重複試験の整理（#34）は本件で行っていない。

### 基準と測定方法

Linux／Bun 1.4.2、同じcheckout・lockfileで`npm ci`後に確認した。最初の試行は未導入依存のため失敗したが、導入後の変更前基準は1,303 pass / 0 fail（141 files、92.28秒）、型検査・Linux CLI build成功。共用分離後も両方式を含む関連34テストが成功した。

以下は`src/`、`packages/cli/src/`、`packages/shared/src/`の`.ts`だけを対象に、Git基準commitと作業treeで比較した値。runtimeはtest／test-supportを除く。scripts・プラットフォーム型・文書は数えない。

| 区分 | 変更前 file / 行 | 変更後 file / 行 |
| --- | --- | --- |
| runtime | 194 / 17,653 | 67 / 4,997 |
| test | 136 / 21,882 | 51 / 4,837 |
| fixture | 19 / 988 | 5 / 282 |

230個の既存TSファイルを削除し、共通module／単体試験4ファイルを追加した。Linux単体binaryは同じ`npm run build:cli -- linux-x64`で83,580,384 → 82,621,920 bytes。Bun runtimeを含むため、source行数とbinaryサイズの削減割合は異なる。

### 検証範囲と制限

- 最終`bun test`: **439 pass / 0 fail（56 files、34.24秒）**。`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`も成功した。試験時間はこのローカル実行の値であり、性能保証ではない。
- CI workflow内のsmoke手順をローカルの構築済みbinaryで実行し、checksum/version/help、旧command拒否、旧設定に対するinit/deploy/statusの非変更拒否を確認した。GitHub上のCI実行を確認したという意味ではない。
- source-processのloopback模擬試験で、**設定ファイルがない新workspace**からflag省略／明示指定の両方を初期化し、ready/paused/drained・Queue API不使用を確認した。既存SQLiteの公開→lifecycle→code-only更新の正式入口試験も維持した。
- 相対import欠落と、production sourceの旧protocol／binding／Worker参照を検査し、該当なし。残るversion 1はcontent／SQLite要求・journal、queueはSQL FIFO、旧名称のcache/source helperは共通処理。プラットフォームの汎用Queue型は変更していない。
- 変更・移動した文書のローカルリンクを確認した。既存のM6資料2箇所にある過去の`experiments/m6/`不在リンクは本件以前のもので、旧証跡の再作成やcleanupはしていない。
- 模擬試験の初回追加時にテスト側のmetadata出力名、fixtureの管理鍵参照先、削除済みWorkerを要求する旧bundle期待値を補正した。製品IOの安全条件を緩和したものではない。
- Cloudflareへの配備・公開・資源操作・未知IO再送・証跡削除は0件。commit／push／Issue更新・close／リリースも行っていない。
