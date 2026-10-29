# フェーズ3：デプロイと稼働制御の簡素化

- 更新日: 2026-10-29
- 状態: 実装済み・未配備。新規環境専用（内部queue/content形式 14/13）。旧形式は変換しない
- 基準commit: `cfc5715`（フェーズ2実装）
- 親文書: [全体設計の見直し](architecture_simplification_review_20261028.md)の改善案D＋E
- 前提: [フェーズ1設計](phase1_atomic_publication_and_ondemand_delivery_plan.md)、[フェーズ2設計](phase2_direct_media_and_cli_simplification_plan.md)

## 1. 目的と方針

日常のWorkerコード更新を「スクリプトを更新するだけ」に戻し、そのためだけに存在する停止・再開・確認の儀式や、途中段階ごとにロックして再実行を拒否する複雑な状態管理をなくす。Podcast配信という目的に対し、デプロイ・初期化・ドメイン変更・稼働制御は次の原則に従う。

- **完了か失敗かの二択と、最初からやり直せる冪等な設計**: 個別API呼び出しの失敗パターンを細分化して `*_requested` 等の中間フェーズで永久ロックする設計をとらない。失敗時はエラーを返し、再実行時は現在の状態をAPIで確認して必要な変更だけを適用し、同じ目標状態へ完了させる。
- **既存データの保全**: 通常のWorker更新ではR2のデータを一切変更せず、いかなる失敗時にも公開済みの音源・画像・履歴を削除しない。設定を変更する操作（独自ドメインの追加・削除）では変更前の設定（`previous_config`）と変更後の設定（`target_config`）を保存しておき、やり直しや継続を同じ手順で行えるようにする。
- **公開と稼働状態のシンプル化**: 公開は同期アトミック処理であり、裏で流れるjobもdrain待ちのqueueも存在しない。配信を止めたい場合は既存のlifecycle操作（非公開化・復元）を使い、独立したruntime停止機構（Pause/Resume）は持たない。
- **Workerバージョンの非永続化**: Workerのバージョンはコードの版であり、データの状態ではない。SQLiteに保存して要求ごとに照合しない。

| 担当 | フェーズ3後の責務 |
| --- | --- |
| 管理者CLI | ローカル入力の検証、素材配置、公開要求、Workerスクリプト配備、ドメイン変更の外部作業と確定要求 |
| Show DO | 認証、要求と公開条件の検証、パージ、SQLite確定、配信、予約の実行 |
| 制御DO | Show IDの予約・所属、Show一覧、ドメイン変更の記録 |
| Alarm | 予約公開の実行のみ |

## 2. Workerデプロイ

`castloop deploy` を、Cloudflare APIへのスクリプト配備と反映確認だけの単発操作にする。

1. 配備前に、ローカルのservice TOMLの設定hashを、稼働中サービスのhealth応答の`service_config_sha256`と比較する。異なれば配備せず、ドメイン変更手順を求める。既存の既知ドメイン確認（`verifyKnownDomains`）も維持する。
2. WorkerスクリプトをPUTし、upload receipt（ETag）を確認する。
3. 配備状況のGETでアップロード版が現在のdeploymentになることを有限回確認し、制御DOのhealthで`worker_version_id`が新しい版に届き、`publication_ready`であることを確認する。全Show DOへの反映は追跡しない（版の一致を要求する箇所がもうないため）。
4. 結果を報告して終わる。

事前のShow停止・drain・2相コミット・Probe・手動Resume・予約の再承認をすべて行わない。配備中の稼働は継続し、予約も維持する。ローカルjournalは書かない。通信切断やタイムアウトで中断された配備は、もう一度 `castloop deploy` を実行すれば上書き配備して完了する（前回の配備途中でRESTとDOのversionが一時的にずれていても拒否しない）。

## 3. 実行環境の識別

実行環境の識別（service ID・設定hash・Worker version）は、DOの起動時に環境変数のservice TOML（`CASTLOOP_SQLITE_CONFIG`）と`CASTLOOP_VERSION_METADATA`から導く。SQLiteへの保存・要求ごとの一致強制をやめる。

- `publication_service`テーブルは`service_id`と`service_config_sha256`だけを保存する1行に縮小する。`worker_version_id`、稼働状態、`admission_window_id`、`availability_version`の列を削除する。
- 公開・登録などの要求には`service_id`と`service_config_sha256`だけを含め、DOは導いた識別と比較する。CLIとサービスの設定ずれはこの比較で拒否される。
- health応答は、実行中の`worker_version_id`を報告のために返す。配備確認（§2）以外はこの値を照合しない。
- 起動時の設定hashの保存値との不一致は、対象設定hashを凍結したドメイン変更の準備がある場合だけ許可する（§6）。それ以外は設定を変える配備を拒否する。

## 4. 稼働状態とPause/Resumeの廃止

`open`／`admission_paused`／`paused`の3状態、`admission_window_id`、`availability_version`、`publication_availability_controls`テーブル、`show-pause`／`show-resume`／`show-admission-pause`／`show-delivery-resume`／`show-control-status`コマンドとそのローカルjournalを廃止する。

- 配信の可否はShowとEpisodeのlifecycle（`draft`／`published`／`unpublished`／`deleted`）だけで判定する。配信を一時的に止めたい場合は既存の非公開化（`preview-*-lifecycle`＋`lifecycle-execute`）を使い、復元も既存のまま使う。
- 公開の受付を止めるruntime状態を作らない。公開は管理者の明示操作であり、実行したくなければ実行しない。
- 制御DOの`service-status`集約から状態別Show数（`open_shows`等）を削除し、所属数・準備状態・予約などの静的な情報だけを返す。
- healthから`state`、`admission_state`、`delivery_policy`、`admission_window_id`、`availability_version`、`queued`、`active`、`drained`、`availability_controls`識別子を削除する。`publication_ready`は「初期化済み・schema現行・未解決のドメイン変更がない」の意味で残す。

非公開化とruntime停止の2つの停止機構を併存させない。親文書が認める「公開状態またはシンプルな停止フラグ」のうち公開状態を採り、lifecycleに既にある非公開化・復元と重複する機構を追加しない。

## 5. 初期化とShow登録

起動時Probe Alarm（`publication_runtime_setup`）を廃止する。R2の`system/service.toml`読取、cache記述の確認、ダミーパージは、initの外部手順と本来の公開・配信処理で代替される。

- `init`：各手順（bucket確認・作成、service TOMLのPUT、Worker作成・配備、Access有効化、health確認）を、実行前に現状をGETして確認する冪等なstepにする。`*_requested` でロックすることはせず、中断時は`init`の再実行で続きから完了する。`init-reconcile`、`init-continue-verification`を削除する。
- Show登録（`create-show`）：登録済みのShow DOは初期化と同時に稼働を開始する。probe完了待ちや新しいwindow UUIDによる`show-resume`は不要になる。Showの初期化と制御DOの登録も冪等にし、中断時は同じ登録要求の再実行で完了できるようにする。
- 初回はworkers.devで始めるという既存の制約は維持する。

## 6. ドメイン変更

ドメイン変更だけがservice TOMLを変える操作であり、変更前後の設定（`previous_config`と`target_config`）をローカルjournalに保存した上で、以下の冪等な手順で完了まで進める。

1. **準備**：CLIが、変更前設定と対象設定（新しい`public_base_url`と設定hash）および既知ドメイン接続を保存し、要求を制御DOへ送る。制御DOと全Show DOがこの要求を`publication_domain_changes`に記録し、未解決の変更が1件であることを保証する。全Showの未実行予約を`needs_approval`へ移す（凍結した要求の設定識別が変わるため、再承認で作り直す）。
2. **外部作業と配備**：CLIがCloudflare APIでドメイン・DNS・Worker domainを設定（または既に設定済みなら確認して再利用）し、`system/service.toml`の更新と新しい設定を組んだWorkerの配備を行う。
3. **確定**：配備後、CLIが各DOへ確定を要求する。DOは必要なキャッシュパージを行い、1つのtransactionで実行中の設定hashが要求の対象hashに一致することを確認して保存設定hashを更新し、Feed世代を進める。同じ要求の再送は変更なしで完了する。
4. **ローカル設定同期・完了**：ローカルの`castloop.toml`を対象設定へ更新し（`remove`の場合はここで旧ドメイン接続を切断）、制御DOが`service_domain_connection`を更新して操作を完了にする。

保守拘束（`maintenance_id`）、membership管理表（`service_show_maintenance`、`service_show_update_targets`）、Showごとのprepare/activate/release fan-out、`feed_ready`とProbe完了の待機、および `*_requested` による途中ロックを廃止する。途中で通信が切れた場合も、保存してある変更前後の設定をもとに `domain continue`（または同じ操作の継続）で現在の状態を確認し、未完了のstepから完了まで進められるようにする。

準備から確定の間、そのDOは`publication_ready`ではなくなり配信は503を返す（今日の保守中と同じ）。公開要求は設定識別の不一致で拒否される。開始したドメイン変更は完了まで運ぶ。並行した外部変更は従来どおり対象外とする。

## 7. 予約への影響

- Pause・window切替・Worker更新保守による予約の`needs_approval`化を廃止する。通常のdeployでは予約に触れない。
- 更新元の競合（`base_conflict`）による`needs_approval`と再承認（`preview-schedule-reapprove`／`schedule-reapprove`）は維持する。公開済み内容が進んだ予約は、内容確認のために再承認を作り直すというフェーズ2の契約のままである。
- ドメイン変更の準備では、対象Showの未実行予約を`needs_approval`へ移す（§6）。凍結済み要求の設定識別が変わるため、再承認で作り直す。
- 予約の中断理由はこの2つ（更新元競合・ドメイン変更）に整理し、`show_paused`、`show_admission_paused`、`runtime_mismatch`、`stale_window`を削除する。

## 8. Alarmとテーブル構成

Show DOのAlarmの用途は予約公開の実行（`dispatchDue`）だけになる。初期化Probe、Worker更新確認、ドメイン変更の分割実行という用途を削除する。

Show DOのテーブルは、内容（show・episode・revision・素材・site ID）、予約、配信統計、ドメイン変更記録、そして識別（schema版・`publication_service`・`publication_show_binding`）だけになる。制御DOは`service_show_registry`と`service_domain_connection`だけになる。実行の都合による内部状態表（`publication_availability_controls`、`publication_runtime_setup`、`publication_runtime_updates`、`service_show_maintenance`、`service_show_update_targets`）を削除する。

テーブル名の付け替えは行わない。改善案Eの狙いは実行都合の表をなくして構成を安定させることであり、現行の内容表の名前はそのまま使う。以後の変更は、既存環境を維持した`ALTER TABLE`で済む形を優先する。

内部形式はqueue側だけが変わるため、queue形式を13から14へ上げる。content形式に変更がなければ13のままとする。

## 9. 削除対象と実装順序

| 削除対象 | 変更後 |
| --- | --- |
| `worker_version_id`のDB保存・要求ごとの照合 | 起動時の環境導出とhealth報告だけ |
| `update-service`の2相コミット、probe待機、手動Resume | §2の単発deploy |
| `update-service-verify`、`update-service-reconcile`、deploy journal | 再実行可能なdeploy手順 |
| `init-reconcile`、`init-continue-verification` | 再実行可能な`init` |
| `show-pause`、`show-resume`、`show-admission-pause`、`show-delivery-resume`、`show-control-status`と制御journal | lifecycle操作とhealth照会 |
| 稼働3状態、`admission_window_id`、`availability_version`、制御記録表 | lifecycleによる配信判定 |
| 起動Probe（`publication_runtime_setup`）と準備API | 即時稼働する登録・初期化 |
| ドメイン変更の保守拘束・membership表・fan-out追跡 | §6の冪等な専用手順 |
| `packages/shared`のruntime更新・稼働要求schema | 縮小したhealth・要求schema |

実装は次の順に行う。

1. 共通schemaとhealth語彙を縮小し、runtime識別を環境導出へ切り替える。
2. Show DOから稼働状態・制御記録・Probe・runtime更新表を削除し、Alarmを予約だけにする。
3. 制御DOから共有更新機構を削除し、登録・一覧・`service-status`を縮小する。
4. ドメイン変更を§6の形へ再構成する。
5. CLIのdeploy・init・登録をつなぎ、削除コマンドの受け口を外す。
6. 診断・help・agent schema・利用ガイド・Skill・AGENTS.md該当行を更新する。

## 10. 検証

通常deploy（無停止・予約維持・配信継続）、deploy中断後の再実行、設定を変えた配備の拒否、初期化の再実行、Show登録後の即時稼働、lifecycleによる配信停止と復元、ドメイン変更の準備・配備・確定・予約の再承認、確定要求の再送、未解決ドメイン変更中の配信503と公開拒否、`base_conflict`予約の再承認、予約のAlarm実行を確認する。`bun test`、`npm run check`、CLI buildとsmoke試験で検証する。実Cloudflareでの配備・ドメイン変更は別途承認を要する。

## 11. 実装状況

ローカル実装・自動試験完了（実Cloudflareへの配備・実機性能測定は未実施、別途承認を要する）。

- 共通schema: 要求は`service_id`＋`service_config_sha256`のみ（`sqliteServiceIdentitySchema`）。health・catalog・snapshot等の応答はruntime報告（`worker_version_id`込み）を維持。稼働3状態、`admission_window_id`、`availability_version`、resume要求schemaを削除した。
- 識別: `src/sqlite-runtime-identity.ts`が起動時に環境変数からruntimeを導出し、保存設定hashとの不一致は未解決ドメイン変更（`publication_domain_changes`の`prepared`行）がある場合だけ許可する。`publication_service`表は1行だけ。
- queue: 内部形式を14へ上げ（`SQLITE_QUEUE_SCHEMA_VERSION=14`）、状態列・制御表を削除し、`admits()`と設定変更`changeConfiguration`を設けた。content形式は13のまま。
- deploy: `packages/cli/src/sqlite-service-deploy.ts`の単発操作（health確認→既知ドメイン確認→スクリプトPUT→配備証憑→新versionのhealth確認）。journalなし。設定が異なる場合はドメイン変更手順を案内して拒否し、中断時は`castloop deploy`の再実行で完了する。
- init / create-show / publish-rss-import: `*_requested`による再実行拒否を廃止し、各ステップでAPIの現在状態を確認して冪等に再実行・完了できるようにした。
- ドメイン変更: 変更前設定（`previous_config`）と変更後設定（`target_config`）をローカルjournalに保存し、準備で予約を`needs_approval`に移す。確定時はパージの成功後に保存hash更新・Feed世代更新・完了記録をトランザクションで確定する。`*_requested`による途中ロックを廃止し、中断時は`domain continue`で現在の状態を確認して完了まで進められるようにした。
- 削除: `show-pause`系5コマンド、`update-service`系、起動Probe、保守拘束・membership表、`sqlite-availability.ts`・`sqlite-runtime-update.ts`等を除去した。Alarmは予約実行のみ。
- ドキュメント: `AGENTS.md`、`README.md`、`docs/`、`skills/castloop/`を更新済み。
