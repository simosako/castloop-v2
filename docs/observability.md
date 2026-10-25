# 観測・診断コマンドの利用方法

Issue #67で追加した読取専用の観測コマンドの使い分けと出力の読み方。いずれも状態変更（probe実行・purge・repair・Resume・公開・再送）を行わない。設計は[設計案](../design/remote_diagnostics_and_monitoring_plan.md)を参照する。

| 目的 | コマンド | 通信 | 認証 |
| --- | --- | --- | --- |
| Showのlocal/remote状態の一括診断 | `castloop diagnose SHOW_ID [SHOW_ID...]` | 管理API GET、Cloudflare API GET 1件（任意で外形GET） | 管理者key |
| 1 jobの進捗・待機理由の統合表示 | `castloop progress JOB` | 管理API GET | 管理者key |
| 公開Feed・画像・音源の外形確認 | `castloop verify SHOW_ID [--episode EPISODE_ID]` | 公開pathへのGET/HEADのみ | 不要 |
| 1 jobの終端までの有限観測 | `castloop watch JOB [--timeout S] [--interval S]` | 管理API GET | 管理者key |

## diagnose

明示指定したShow（既定5件まで、`--max-shows N`で1〜20）を直列に診断し、各検査を `scope`（local / remote / cross / external）と `pass` / `warn` / `fail` / `not_checked` で分類する。failが1つでもあれば終了1、warnのみは終了0。

主な検査とcode:

| id | 主なcode | 意味 |
| --- | --- | --- |
| `remote-identity` | `runtime_matches` / `runtime_differs` / `observation_unavailable` | 管理APIのruntime identity（service_id・config hash）とlocal設定の突合 |
| `cf-credentials` | `cf_account_readable` / `cf_account_forbidden` / `cf_token_invalid` / `cf_unreachable` / `cf_credentials_absent` | Cloudflare API tokenの有効性と当該accountの読取（1 invocation 1回）。操作権限の保証ではない |
| `maintenance` | `no_maintenance` / `maintenance_active` / `runtime_update_active` / `setup_active` | 共有保守・更新・setupの進行 |
| `registration` | `registered` / `registration_missing` / `registration_pending` | Show登録状態 |
| `admission` | `admission_open` / `admission_paused`（受付のみ停止・配信継続）/ `show_paused`（受付も配信も停止）/ `not_publication_ready` | Show単位の受付・配信状態（[3状態モデル](show_availability.md)に対応） |
| `queue` | `queue_drained` / `jobs_queued` / `active_running` / `active_blocked` | Show FIFO。active blockedはfail |
| `target-state` | `target_published` / `target_draft` / `target_unpublished` / `target_deleted` / `target_missing` | lifecycle |
| `unfinished-operations` / `local-unfinished` | `unfinished_operations` / `no_unfinished_operations` | server・localそれぞれの未完了操作 |
| `consistency` | `no_pending_drafts` / `draft_pending_publication` / `job_known_remote` / `frozen_request_missing` / `submission_outcome_unknown` | local draft journalとremote job記録の突合 |
| `delivery`（`--external`指定時） | `delivery_verified` / `delivery_warn` / `delivery_verification_failed` | verifyと同じ外形検査の集約 |

`--external`を付けると各Showの外形確認（下記verifyと同じ検査）を1件の`delivery`検査に集約して追加する。

## progress

job-statusと同じ検索順（過去版採用のrevision journal → lifecycle journal → 公開済みarchive → draft journal）で対象jobを特定し、進捗をフェーズ表として表示する。各フェーズは `done` / `in_progress` / `pending` / `unknown` / `not_applicable` の5値で、観測できないもの（FIFO内順位、実行の内部段階、cache purge）は`unknown`のまま表示し、完了や0値へ変換しない。

Issue #64の過去版採用jobは`job.source="revision"`となり、素材uploadのフェーズは表示しない。計画保存のみで送信を始めていなければ`state="draft"`、送信開始済みでも受付を確認できなければ`state="unknown"`とする。remote取得失敗時に保存済みstatusを表示する場合は`observation.stale=true`を付ける。記録の書換え・再送・修復は行わない。

待機理由（`waiting_reason`）はjobが`queued`のときだけ導出される:

| reason | 意味 |
| --- | --- |
| `admission_paused` | Showの受付が停止中（`admission_paused`＝配信継続、`paused`＝配信も停止） |
| `head_job_blocked` | 先頭jobがblockedしFIFOが停止している |
| `waiting_for_active` | 他jobが実行中 |
| `waiting_in_fifo` | 上記以外のFIFO待機（順位は未提供） |
| `observation_gap` | remote観測が失敗し、表示しているのは最終既知のlocal記録（`observation.stale`がtrue） |

観測コマンドのため、jobがfailed/blockedでも終了codeは0。

## verify

`public_base_url` の公開pathだけをGET/HEADで確認する。管理者keyも管理APIも使わない。feedはserverと同じrender予算上限（32,000,000 bytes、共有定数）で全量取得して内容を検証し、coverとaudioはHEAD（不正時はRange GET `bytes=0-0` で補助）でstatus・Content-Lengthを確認する。音源を毎回全量downloadすることはない。

出力は「処理成功」（local journalにsucceeded記録があるか）と「配信確認」（外形検査）を別々のblockで報告する。failが1つでもあれば終了1。

| id | 主なcode |
| --- | --- |
| `feed-status` | `feed_served` / `feed_unavailable`（503。配信停止か障害かはdiagnoseで確認）/ `published_feed_missing` / `feed_absent_no_publication_evidence` / `feed_transport_error` |
| `feed-content` | `feed_content_verified` / `guid_missing`（local journalでsucceededのEpisodeのGUIDがfeedにない）/ `enclosure_origin_mismatch` / `feed_parse_failed` / `no_local_expectations` |
| `cover` | `cover_served` / `cover_missing` / `cover_url_unknown`（feedにcover URLがない） |
| `audio`（`--episode`時） | `audio_served` / `audio_missing` / `audio_content_mismatch` / `audio_no_local_expectation` / `audio_not_requested` |
| `unpublished-episodes` | `unpublished_not_linked` / `linked_without_publication_evidence`（未公開のEpisodeがfeedに載っている）/ `no_unpublished_episodes` |

Issue #64で認証付き全文取得APIを追加したが、`verify`は管理鍵不要・公開pathのみの契約を維持するため使用しない。local原本・journalがない比較は`not_checked`になる。過去版採用後も原本は自動更新されないため、比較対象が古い場合は[公開内容の確認・書出し](published_content_review.md)で確認し、古いlocal期待値との不一致を直ちに配信障害と判断しない。

## watch

1 jobを予算付きで観測し、終端（succeeded / failed / blocked）または観測不能を報告する。途中経過はstderrへJSON lines、最終報告はstdout（`--json`で外枠1文書）。

- 予算: `--timeout`既定600秒（上限3600）、`--interval`既定5秒（1〜60）、poll回数の絶対上限720。各pollは管理APIへのbounded GET（3回/30秒）。
- blockedは「解消を待つ」対象ではなく終端として扱う。解消は明示的な運用操作。
- 観測済みのjobが消失した場合は `unobservable`（`job_missing`）で即時終了する。
- 過去版採用jobも対象にする。送信前の計画はpollせず`job_not_submitted`を返す。応答不明の送信に対する404は未実行の証明にせず、有限観測を続ける。保存済みstatusで受付を確認できているjobの消失は`job_missing`、保存済み結果に矛盾する応答は観測欠測として扱い、成功・再送へ変換しない。
- 通知はCLI完結（外部送信なし）。SIGINTは終了130で、最終文書を出さない。

終了code:

| code | 意味 |
| --- | --- |
| 0 | `succeeded`を観測 |
| 1 | `failed`または`blocked`を観測 |
| 2 | `unobservable`（`budget_exhausted` / `job_missing` / `job_not_submitted` / `interrupted`） |

`succeeded`観測時の`next_actions`は`castloop verify SHOW_ID`を指し、処理成功と配信確認を分けて確認する導線になる。

## 失敗時の読み方

- `diagnose` / `verify`のfailは、まず該当checkの`next_actions`（action名）と表を对照し、対応する読取コマンド（`show-status`、`operation-status`、`progress`など）で詳細を確認する。いずれのコマンドも修復・再送を提案しない。
- 通信断・観測欠測は成功・正常値として表示されない。`observation_unavailable` / `unobservable` / `observation_gap`が出ている間は、結果を確定させず[操作ガイド](sqlite_operation_recovery.md)に従って記録を保全する。
- 実Cloudflareでの配備・公開・Resume・資源変更は、対象と範囲を明示して承認を受けてから行う。
