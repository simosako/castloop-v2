# フェーズ4設計書：全体コード・テスト見直しと残存複雑性の削減計画（2026-10-29）

- 作成日: 2026-10-29
- 調査基準commit: `3bc24bd`（フェーズ1〜3実装完了時点、内部queue/content形式 `14/13`）
- 状態: **実装・ローカル検証完了（Cloudflare未配備）**
- 関連文書: [全体設計の見直し](architecture_simplification_review_20261028.md)、[フェーズ1](phase1_atomic_publication_and_ondemand_delivery_plan.md)、[フェーズ2](phase2_direct_media_and_cli_simplification_plan.md)、[フェーズ3](phase3_deploy_and_runtime_control_simplification_plan.md)

## 1. 背景と目的

フェーズ1〜3の改修により、Podcast配信システムの本幹である「直接メディア配置」「単一SQLiteトランザクションによる同期アトミック公開」「RSS/HTMLのオンデマンド生成」「単発のWorkerデプロイ」「Pause/Resume廃止とlifecycleへの統合」が完了し、コードベース全体は約43,000行から約20,600行まで縮小した。

しかし、最新コードとテストスイート（全20,647行）を改めて全体監査したところ、**旧アーキテクチャ（多段ステージング、R2スナップショット保存、非同期ジョブ台帳、未知I/Oの永久ロックアウト）を前提に作られた周辺モジュール・補助スクリプト・過剰なローカルジャーナル・旧仕様向けテスト** がまだ約3,000〜3,500行残っていることが判明した。

本設計書では、この残存する不要コード・不要テスト・過剰な複雑性を6つの領域に整理し、クリーンアップ計画（フェーズ4）として定義する。

---

## 2. 残存する複雑性と不要コード・テストの洗い出し

### 2.1 アップロード時の最大300MB一時ファイル複製（`staging-sources.ts`）と全量Readback検証（`verified-r2-put.ts`）の残骸

フェーズ2で「R2 `staging/` へのアップロード」と「アップロード直後のR2からの全量再ダウンロード（Readback）検証」は廃止されたが、当時のヘルパー群がそのまま残っている。

1. **最大300MBのMP3を毎回 `.castloop/` に丸ごとコピーしている（`packages/cli/src/staging-sources.ts`, 183行）**:
   - `uploadSqliteMedia`（`packages/cli/src/sqlite-media-upload.ts:27`）が `freezePayloadSources()` を呼んでいる。
   - `freezePayloadSources()` は、アップロードのたびにローカルの `.castloop/upload-inputs-xxxx/0` に元ファイル（最大300MBのMP3やカバー画像）を丸ごとコピーして `chmod 0400` し、送信前・送信中・送信後に元ファイルとコピーの両方を計4回もストリーム走査してSHA-256と `mtimeNs` / `ctimeNs` を比較した上で削除している。
   - しかし現在の公開フロー（`packages/cli/src/sqlite-publish.ts:28-38`）では、アップロード直前にローカルファイルを検査し、アップロード完了直後にも `draftPreview(..., { mode: "local" })` でローカル入力のハッシュが変わっていないことを確認している。`.castloop/` への一時ファイル複製と多重ハッシュ計算はディスクI/Oと時間の無駄であり不要である。
2. **旧ステージング用のスキーマ定義が残っている（`packages/shared/src/upload.ts`, `upload.test.ts`）**:
   - `stageAssetSchema`（もはや使われない `"show_metadata"`, `"episode_metadata"` を含む）、`stagePayloadSchema`、`stageReadbackReceiptSchema` が残っている。
3. **たった1箇所の小さな設定ファイルPUTのためだけに全量Readback検証モジュールが残っている（`packages/cli/src/verified-r2-put.ts`, 113行）**:
   - `verifyAcknowledgedR2Object()`（99〜113行目）はどこからも呼ばれていない完全なデッドコードである。
   - `putVerifiedR2Object()` は、`SqliteCloudflareApi.uploadConfig()`（数百バイトの `system/service.toml` のアップロード）の1箇所からしか呼ばれていない。それにもかかわらず、PUTした直後にGETで読み戻してETagとSHA-256を検証する旧ステージング用の複雑な実装と専用テスト（`verified-r2-put.test.ts`, 83行）が維持されている。他の約15ファイルは単に `R2RestTransport` / `R2RestOptions` 型をインポートしているだけである。

**改善方針**:
- `packages/cli/src/staging-sources.ts`、`staging-sources.test.ts`、`packages/shared/src/upload.ts`、`upload.test.ts`、`packages/cli/src/verified-r2-put.ts`、`verified-r2-put.test.ts` を廃止する。
- ローカルメディアファイルのサイズ・SHA-256・ヘッダ検査は `local-input.ts`（または小さなファイル検査ヘルパー）で直接行い、`uploadSqliteMedia` は一時ファイルを複製せず元ファイルから直接ストリーム送信（送信バイト数とR2 PUTレスポンスの `key`・`size` 一致を検証）する。
- `SqliteCloudflareApi.uploadConfig()` も同様にR2 PUTレスポンス（HTTP 200・`success: true`・`key`・`size`）の検証のみとする。

---

### 2.2 オンデマンド配信化（フェーズ1）後に残ったR2スナップショット・バケット参照のデッドコード

フェーズ1でRSSフィードとWebサイトHTMLはすべてShow DOのSQLiteからオンデマンド生成する方式に切り替わったが、旧R2スナップショット方式のコードが複数箇所に残っている。

1. **R2 Feedスナップショットキーと未使用フォールバック（`src/sqlite-feed.ts`, `src/lifecycle-cache.ts`, `src/sqlite-publication-content.ts`）**:
   - `src/sqlite-feed.ts` の `sqliteFeedSnapshotKey()`（`public/podcasts/<showId>/feeds/<generation>.xml`）が残っている。
   - `src/sqlite-publication-content.ts:583`（`advanceFeed`）は `sqliteFeedSnapshotKey(request.show_id, generation)` を呼んで戻り値を捨てているだけである。
   - `src/lifecycle-cache.ts:88, 113` では `renderFeed` がオプショナル（`renderFeed?: LifecycleFeedRenderer`）になっており、未指定時に `sqliteFeedSnapshotKey()` でR2バケットからFeed XMLを読む分岐が残っている。本番Worker（`SqliteCachedAssets`）は常に `renderFeed` を渡すため、このR2フォールバックは一度も使われない。
2. **R2 WebサイトHTMLスナップショットキーの空呼び出し（`packages/shared/src/website.ts`, `src/site-gateway.ts`）**:
   - `packages/shared/src/website.ts:35-40` に `siteSnapshotKey()`（`public/podcasts/<showId>/sites/<generation>/...`）が残っており、`src/site-gateway.ts:22` が戻り値を捨てて呼んでいるだけである。
3. **完全に未使用のドメイン用スナップショットメソッド（`src/sqlite-publication-content.ts:587-613`）**:
   - `domainSnapshot()` と `commitDomainFeed()` はどこからも呼ばれていない完全なデッドコードである（`SqliteDomainRuntime` は `nextFeedGeneration()` を直接使っている）。
4. **Show DO内の未使用R2バケット参照（`src/sqlite-publication-executor.ts`, `src/sqlite-show-service.ts`）**:
   - `src/sqlite-publication-executor.ts:19-25, 46-51` の `verifyCover()` と `SqlitePublicationBucket` 型はどこからも呼ばれていない。
   - `SqliteShowService` コンストラクタ（`src/sqlite-show-service.ts:43`）に渡されている `private readonly bucket: SqlitePublicationBucket` もクラス内で一切使われていない（Show DOはR2バケットにアクセスしない）。

**改善方針**:
- `src/sqlite-feed.ts` を削除し、`lifecycle-cache.ts` の `renderFeed` を必須化してR2 Feedフォールバックを削除する。
- `website.ts` の `siteSnapshotKey()` と `site-gateway.ts` の呼び出しを削除する。
- `SqlitePublicationContent` の `domainSnapshot()` / `commitDomainFeed()`、`sqlite-publication-executor.ts` の `verifyCover()` / `SqlitePublicationBucket`、および `SqliteShowService` の未使用 `bucket` 引数を削除する。

---

### 2.3 統計保持日数変更（`stats-retention`）の過剰な操作台帳・ジャーナルと廃止済み管理エンドポイント

1. **`stats-retention` の操作台帳と3フェーズジャーナル（`src/sqlite-delivery-stats.ts`, `src/sqlite-stats-http.ts`, `packages/cli/src/stats.ts`）**:
   - `castloop stats-retention <show> <days>` は、Show DOの `publication_delivery_stats_meta` テーブルにある `retention_days`（30〜3650の整数）を1つ更新するだけの設定変更であり、本質的に冪等（同じ日数を何度送っても同じ結果になる）である。
   - それにもかかわらず、以下の過剰な仕組みが残っている：
     - Show DO内の専用テーブル `publication_delivery_stats_controls (operation_id, request_json, record_json, created_at_ms)`（`src/sqlite-delivery-stats.ts:136-141, 256-288`）
     - 結果照会用のGETエンドポイント `/admin/sqlite-stats/retention/<operationId>`（`src/sqlite-stats-http.ts:66-72`, `packages/cli/src/sqlite-service-client.ts:134-137`）
     - CLI側の `.castloop/sqlite-stats-controls/<serviceId>/<operationId>.json` ジャーナル（`prepared` → `requested` → `confirmed`）と再送禁止ロック（`packages/cli/src/stats.ts:28-66`）
   - これらを廃止し、`POST /admin/sqlite-stats/retention` で直接 `retention_days` を更新して結果を返す単発の冪等操作に簡素化する。
2. **未使用の `/admin/sqlite-publication/status` エンドポイントと `SqlitePublicationClient.describe()`**:
   - `src/sqlite-publication-http.ts:17-25` の `GET /admin/sqlite-publication/status`、`packages/cli/src/sqlite-publication-client.ts:20-26` の `describe()`、`packages/shared/src/sqlite-service.ts:26-33` の `sqliteServiceStatusSchema` は、CLIのどのコマンドからも呼ばれていない（稼働状態の確認は `/admin/sqlite-service/health` に統一されている）。
3. **管理HTTPクライアントの旧URL許可リスト（`packages/cli/src/sqlite-management-http.ts:55, 63`）**:
   - `readPath()` に、すでに削除された `/admin/sqlite-publication/status`、`/admin/sqlite-service/update-status/<uuid>`、`/admin/sqlite-service/controls/<uuid>`、および上記 `/admin/sqlite-stats/retention/<uuid>` が残っている。
4. **Show DOキュー・予約内の死んだ定義とCLI内部別名**:
   - `src/sqlite-publication-queue.ts`: 未使用の `PublicationQueueConflict` クラス、`confirm()` メソッド、`publication_schedules` テーブルの死んでいる `'blocked'` / `'block'` CHECK制約が残っている。
   - `src/sqlite-publication-schedules.ts:298, 307` & `packages/shared/src/sqlite-schedule.ts:35`: ドメイン変更時は `ready()` が `false` になり `domain_change` で停止するため、`dispatchDue()` 内の `runtime_mismatch` 分岐は到達不能である。
   - `packages/cli/src/index.ts:250` & `packages/cli/src/sqlite-commands.ts:47, 183`: `deploy` コマンドを内部で廃止済みコマンド名 `"update-service"` に書き換えてディスパッチしている。そのまま `"deploy"` として扱えばよい。

---

### 2.4 ローカルジャーナル種別（`JOURNAL_FAMILIES`）とバックアップ（`backup-*`）の旧仕様スキャン整理

1. **`JOURNAL_FAMILIES` の廃止済みディレクトリ名（`packages/cli/src/local-journal-path.ts:4-7`）**:
   - 15種類のうち、`sqlite-drafts`, `sqlite-uploads`, `sqlite-publications`, `sqlite-controls`, `sqlite-stats-controls`, `sqlite-lifecycle`, `sqlite-revisions`, `sqlite-service-updates`, `sqlite-operation-requests` の9種類はすでに廃止された機能のディレクトリ名である。
2. **バックアップ作成・復元時の旧ドラフト・更新スキャン（`packages/cli/src/backup-create.ts`, `backup-restore.ts`, `backup-archive.ts`）**:
   - `backup-create.ts:120-159` の `scanLocalOperations()` が、廃止された `.castloop/sqlite-drafts`・`sqlite-uploads`・`sqlite-service-updates` を走査して `drafts_staged`、`drafts_unresolved`、`show_controls`、`service_updates`、`source_paths` を集計している。
   - さらに `backup-create.ts:221` と `backup-restore.ts:87-88, 135-136` が、廃止された `operation-status` コマンドや `restage` を案内している。
   - バックアップマニフェストの未完了操作（`pending`）やスキャン対象を現行の仕様（未完了の `domain_changes` 等）に合わせて整理し、存在しないコマンドの案内を削除する。

---

### 2.5 初期化（`init`）・Show登録（`create-show`）・独自ドメイン変更（`domain`）のローカルジャーナルの簡素化

フェーズ3で「各ステップはAPIの現在状態を確認して冪等に再実行できる」設計に統一したが、ローカルジャーナルのスキーマには旧設計の細かい中間フェーズが残っている。

1. **独自ドメイン変更の13フェーズジャーナルの圧縮（`packages/cli/src/sqlite-domain-journal.ts`, `sqlite-domain-operation.ts`, `sqlite-domain-attachment.ts`, `sqlite-domain-cloudflare.ts`）**:
   - 現在、`sqlite-domain-journal.ts` は `prepared` → `maintenance` → `attachment_acknowledged` → `connected` → `configured` → `deploy_acknowledged` → `deployed` → `verified` → `commit_requested` → `remote_ready` → `local_synced` → `detached` → `completed` の **13フェーズ** を持ち、中間レシート（`attachment_acknowledgement`, `upload_receipt`, `receipt`, `commit`）の整合性を30行超の `superRefine` で検証している。
   - これは以前「PUTの直後にGETで確認する前の中間レシートを別フェーズとしてディスクに保存しなければならない」としていた名残である。
   - 改善：
     - `SqliteDomainCloudflare.attach()` の中で接続確認GET（旧 `confirmAttachment()`）まで完結させ、中間型 `SqliteDomainAttachment`（`sqlite-domain-attachment.ts` 全体）と `attachment_acknowledged` フェーズを廃止する。
     - `api.uploadWorker()` と `api.deploymentReceipt()`・`api.inspect()` を1ステップで行い、`upload_receipt` の中間保存や `deploy_acknowledged` / `verified` / `commit_requested` フェーズを統合する。
     - これにより、ドメイン変更ジャーナルは変更前後の設定（`previous_config` / `target_config`）を保持したまま、**`prepared` → `connected` → `deployed` → `remote_ready` → `local_synced` → `completed`（6フェーズ）** の明快な構造になり、`continue` の安全性・冪等性を一切損なわずにコード量と複雑さを大幅に削減できる。
2. **初期化（`init`）とShow登録（`create-show`）のジャーナル簡素化（`packages/cli/src/sqlite-initialization.ts`, `packages/cli/src/sqlite-commands.ts`）**:
   - `init` の各ステップ（事前確認、バケット作成、設定PUT、Worker作成、Workerデプロイ、workers.dev有効化、health確認）はすべて現在の状態をAPIで確認する冪等な処理になったため、9フェーズ（`fresh`〜`ready`）に細分化して1ステップごとにローカルジャーナルを書き換える必要がない。開始時の設定・ソースハッシュ記録（`prepared`）と完了記録（`ready`）の2フェーズ（または配備証憑記録を含む3フェーズ）に簡素化できる。
   - `create-show`（`registeredShow`）も、制御DOとShow DOが同じ `reservation_id` に対して冪等になったため、ローカルジャーナル（`.castloop/sqlite-registrations/<showId>.json`）は `reservation_id` の保持と完了確認のみに簡素化できる。

---

### 2.6 廃止済み実機トライアル用スクリプト・テストの削除と過剰テストの整理

1. **旧世代トライアル監視スクリプト群の削除（`scripts/test-support/*`, 13ファイル・計1,613行）**:
   - `scripts/test-support/` 配下の以下のファイル群は、廃止されたv0.5.x Queue方式および旧SQLite非同期ジョブキュー・ステージング・オペレーション台帳時代の実機試験用ツールである：
     - `legacy-sqlite-publication.ts`（17行）、`legacy-sqlite-operations.ts`（9行）
     - `sqlite-observability.ts`（193行）、`sqlite-observability.test.ts`（146行）：旧 `/admin/sqlite-publication/jobs/<id>` や `sqlite_operation` / `sqlite_runtime_setup` ログの解析
     - `sqlite-tail.ts`（50行）、`sqlite-tail.test.ts`（56行）
     - `worker-tail.ts`（162行）、`worker-tail.test.ts`（271行）：旧 `staging.*` / `management.stage-start` 等のログ監視WebSocketクライアント
     - `trial-supervisor.ts`（136行）、`trial-supervisor.test.ts`（131行）：tmux内からOpenCodeローカルAPIを叩く旧試験ランナー監視
     - `trial-read.ts`（83行）、`trial-read.test.ts`（91行）：旧トライアルスクリプト専用のGETヘルパー
     - `rss-lookup-probe.ts`（135行）：過去のBun 1.4.2 DNS lookup調査用の単発プローブスクリプト
   - これらは本番コード（`src/`, `packages/`）から一切参照されておらず、現在のアーキテクチャとも乖離している。歴史的経緯は `design/archive/` の各文書に記録済みであるため、`scripts/test-support/` ごと削除する。
   - また `scripts/measure-revision-storage.ts`（58行）もIssue #64検討時の単発試算スクリプトであり、必要なければあわせて整理できる。
2. **旧「未知応答での永久ロック」仕様向けの過剰な合成異常系テストの整理**:
   - `packages/cli/src/sqlite-domain-operation.test.ts`（408行）および `packages/cli/src/sqlite-domain-cloudflare.test.ts`（220行）には、かつての「レスポンスの微細な違いでジャーナルを永久ロックし二度と再送しない」仕様を検証するための合成的な異常レスポンス試験（DELETEの7種類の不正ボディループ、20種類以上のJSONフィールド欠落パターンなど）が多数残っている。
   - AGENTS.mdの原則（現実的な動作・回帰・文書化された要件のテストを優先し、仮説的・人工的な分岐のテストで肥大化させない）に従い、正常系（add / remove / list / status）、中断からの冪等な `continue`（TLS待機、Worker反映待ち、各ステップ中断）、設定・認証・不変条件の検証に整理する。

---

## 3. 削除・簡素化の対象一覧と削減見込み

| 区分 | 対象ファイル | 処置 | 削減見込み |
| --- | --- | --- | --- |
| **旧トライアル補助スクリプト・テスト** | `scripts/test-support/*`（全13ファイル） | 全面削除 | 約1,610行 |
| **ステージング・全量Readback** | `packages/cli/src/staging-sources.ts`, `staging-sources.test.ts`, `packages/cli/src/verified-r2-put.ts`, `verified-r2-put.test.ts`, `packages/shared/src/upload.ts`, `upload.test.ts` | 削除し、`local-input.ts` / `sqlite-media-upload.ts` / `sqlite-cloudflare.ts` を直接化 | 約600行 |
| **R2スナップショット・バケット残骸** | `src/sqlite-feed.ts`, `src/lifecycle-cache.ts`, `src/site-gateway.ts`, `packages/shared/src/website.ts`, `src/sqlite-publication-content.ts`, `src/sqlite-publication-executor.ts`, `src/sqlite-show-service.ts`, `src/test-support/sqlite-publication-bucket.ts` | 未使用関数・引数・R2 Feedフォールバックを削除 | 約150行 |
| **統計保持設定・廃止済み管理API** | `src/sqlite-delivery-stats.ts`, `src/sqlite-stats-http.ts`, `packages/cli/src/stats.ts`, `src/sqlite-publication-http.ts`, `packages/cli/src/sqlite-publication-client.ts`, `packages/cli/src/sqlite-management-http.ts`, `packages/shared/src/sqlite-service.ts`, `src/sqlite-publication-queue.ts`, `src/sqlite-publication-schedules.ts`, `packages/cli/src/index.ts`, `packages/cli/src/sqlite-commands.ts` | `stats-retention` 台帳・ジャーナル廃止、`/admin/sqlite-publication/status` 廃止、デッドコード削除 | 約250行 |
| **ジャーナル種別・バックアップ整理** | `packages/cli/src/local-journal-path.ts`, `packages/cli/src/backup-create.ts`, `packages/cli/src/backup-restore.ts`, `packages/cli/src/backup-archive.ts`, `packages/cli/src/backup.test.ts` | 廃止済みジャーナル種別と旧ドラフト・更新スキャンの削除 | 約180行 |
| **ドメイン・初期化ジャーナル圧縮とテスト整理** | `packages/cli/src/sqlite-domain-attachment.ts`（削除）, `sqlite-domain-journal.ts`, `sqlite-domain-operation.ts`, `sqlite-domain-cloudflare.ts`, `sqlite-initialization.ts`, `sqlite-domain-operation.test.ts`, `sqlite-domain-cloudflare.test.ts`, `sqlite-initialization.test.ts` | `attachment_acknowledgement` 統合、フェーズ圧縮、過剰な合成異常系テストの整理 | 約450行 |

合計でさらに **約3,200行（全体の約15%）** を削減でき、リポジトリ全体は約17,400行のスリムで一貫した構成になる。

---

## 4. 実装順序と検証計画

1. **ステップ1（旧トライアルスクリプト・R2スナップショット残骸・廃止管理APIの削除）**:
   - `scripts/test-support/` の削除。
   - `src/sqlite-feed.ts`、`domainSnapshot`、`commitDomainFeed`、`verifyCover`、`siteSnapshotKey`、`/admin/sqlite-publication/status`、`update-service` 内部別名の削除。
2. **ステップ2（ステージング一時コピーと全量Readbackの撤去）**:
   - `staging-sources.ts`、`verified-r2-put.ts`、`shared/upload.ts` を削除し、`uploadSqliteMedia` と `SqliteCloudflareApi.uploadConfig` をシンプルな直接ストリームPUTへ置き換える。
3. **ステップ3（`stats-retention` 簡素化とバックアップ・ジャーナル種別の整理）**:
   - `publication_delivery_stats_controls` テーブルと `sqlite-stats-controls` ジャーナルを廃止し、バックアップの旧ドラフト・サービス更新スキャンを整理する。
4. **ステップ4（`domain`・`init` ジャーナルのフェーズ圧縮とテスト整理）**:
   - `sqlite-domain-attachment.ts` を削除して `attach` に統合し、ドメインジャーナルを6フェーズ、`init` ジャーナルを最小フェーズへ圧縮する。関連テストを整理する。
5. **ステップ5（全体検証とバイナリ再ビルド）**:
   - `npm run check`、`bun test`、`npm run build:cli -- linux-x64`、`scripts/smoke-agent-cli.mjs` を実行して全チェックの通過を確認する。
