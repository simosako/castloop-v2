# リモート診断・公開進捗・完了／障害通知・外形監視の設計案（Issue #67）

2026-10-24。Issue #67対応の設計提案。確認基準はv0.7.2のmain（commit `72bc9f0`）と現行treeの[`doctor.ts`](../packages/cli/src/doctor.ts)、[`sqlite-commands.ts`](../packages/cli/src/sqlite-commands.ts)、[`sqlite-management-http.ts`](../packages/cli/src/sqlite-management-http.ts)、[`sqlite-gateway.ts`](../src/sqlite-gateway.ts)、[`sqlite-publication-queue.ts`](../src/sqlite-publication-queue.ts)と既存文書。本文は設計案であり、実装・配備・実環境操作の承認を含まない。

2026-10-24レビュー: §5.1=案A2、§6.1=案B2、§7.1=案C1+C2 fallback（全量downloadなし）、§8.1=案D1、§8.5=案E1に決定。CLI出力は§4.2のエージェント向け規約に統一した。2026-10-25レビュー: 通知はCLI完結（terminal出力・終了code）に決定し、CLI以外の通知経路は非目標とした（§8.3）。

## 1. 現状と不足

### 1.1 既存の観測手段と限界

| 手段 | 参照先 | 読めるもの | 限界 |
| --- | --- | --- | --- |
| `doctor` | `packages/cli/src/doctor.ts` | workspace・管理者key・認証情報の存在・domain journal残存 | local専用。`remote`は常時`not_checked`。権限・有効性・remote readiness・公開内容は検査しない |
| `service-status` / `show-status` | `health` GET | runtime identity、open/paused、admission window、queued/active/drained、保守・更新状態 | 生snapshot。分類・判定・localとの突合なし |
| `target-show` / `target-episode` | `inspect` GET | lifecycle、base revision、expected versions | 生snapshot |
| `job-status` | local journal群＋`jobs/{request_id}` GET | 当該jobのqueued/running/succeeded/failed/blocked | 1jobのみ。待機理由や資産段階との統合なし |
| `operation-list/status` | `operations` GET／local journal | 操作・要求・checkpoint・events | operatorが状態遷移を自力で解釈する必要がある |
| `list-shows` / `list-episodes` | `catalog` POST | lifecycle、unfinished_operation、feed_url（文字列） | feed_urlはserver側計算値で、実際の配信は未取得 |
| `publish-*` の待機 | `sqlite-draft.ts` `wait()` | 当該jobの終端（最大300秒/300回） | CLIプロセス内のみ。終了後の継続観測の導線なし |
| tail／保存ログ | — | 実行履歴の断片 | 欠測あり（[tail欠測の調査](archive/sqlite_tail_missing_logs_investigation_20261017.md)ほか）。CPU 0msや未実行の証明には使えない |

### 1.2 不足（Issue本文の4提案との対応）

1. **remote診断の不在**: 対象identity・readiness・Pause/保守・未完了job・local/remote不一致を整理した読取専用診断がない。
2. **進捗の統合表示の不在**: upload→全量readback→staging→公開受付→FIFO待機→実行→完了を、待機理由付きで一覧する導線がない。cache purgeはCLIからは観測不能なまま。
3. **継続観測・終端報告の不在**: `publish-*`の待機（最大300秒）を超えるFIFO待機やblocked等を、CLIで継続観測し成功／failed／blocked／観測不能として報告する導線がない。
4. **外形確認の不在**: 公開Feed・画像・承認音源を実際にGET/HEADする機能がない。「処理成功」と「配信を確認できた」の分離表示もない。

### 1.3 前提

- 現行の対象はservice schema 2／`sqlite-sequential-v1`／`storage_layout=show-v1`のみ。
- 本案の初期段階は**CLIのみ**で、Worker・DO・永続形式・管理APIの変更をしない。既存の読取API（health/inspect/registrations/operations/catalog/jobs）で必要な情報が揃う。
- ログ（tail・保存ログ）は判定資料に使わない。状態APIとlocal journalのみで判定する。
- 全Showを横断する恒久的な操作索引は作らない。Show単位の責務は維持する。

## 2. 設計原則（安全条件の実装方法）

1. **読取のみ**: 追加コマンドが行うremote操作は管理APIへのGETと公開pathへのGET/HEADのみ。probe実行・purge・repair・Resume・公開・未知要求の再送はしない。外形確認のGET/HEADと状態変更を明確に区別する。
2. **明示対象**: Show・jobは常に明示指定。複数Show確認は明示列挙の読取集約とし、上限を設ける。
3. **予算**: 観測の回数・時間・並列数に上限を置く。並列数は既定1（直列）。1回のGETは既存のbounded reader（[`sqlite-management-http.ts`](../packages/cli/src/sqlite-management-http.ts)、3回/30秒/サイズ上限）で決着させ、開始済みIOを放置しない。
4. **真実性**: 不明は`unknown`/`not_checked`で表示し、正常・0値・成功へ変換しない。`queued`とCLIの`ok`を公開成功と表示しない。ログ欠測を根拠に判断しない。
5. **通知のCLI完結**: 通知はCLIの標準出力・終了codeで完結し、CLI以外への通知経路（外部webhook等）は提供しない。観測不能（unobservable）を成功・正常値として表示しない。
6. **期待応答の分類**: 未公開の404、停止中の503、削除済みの410、redirect、通信断、取得不一致、観測欠測を別々のcodeで表す。
7. **秘密**: 秘密鍵・token・本文・メール・非公開job ID・素材URLを外部通知や任意のログへ送らない。local出力（terminal・local journal）は運用者自身の記録であり、既存コマンドと同じ扱いとする。

## 3. 全体構成

4つの新コマンドを追加し、段階的に実装する。`doctor`は現状維持（local専用）。

| コマンド | 機能 | 通信 | 認証 | 段階 |
| --- | --- | --- | --- | --- |
| `diagnose SHOW_ID...` | 対象Showのlocal/remote読取診断 | 管理API GET（+任意でCloudflare API GET 1件、外形GET） | 管理者key | A |
| `progress JOB_ID` | job単位の進捗・待機理由の統合表示 | 管理API GET | 管理者key | B |
| `verify SHOW_ID [--episode ID]` | 公開pathの外形確認 | 公開path GET/HEADのみ | 不要 | C |
| `watch JOB_ID` | 予算付き継続観測。終端をCLI出力・終了codeで報告 | 管理API GET | 管理者key | D |

共通の検査モデル（scope付きCheck）を`packages/shared`へ追加し、`doctor`・`diagnose`・`verify`で使う。

## 4. 共通出力モデル

### 4.1 Checkモデル（scope付き）

`doctor`の`Check`（`id`/`status`/`code`/`message`/`next_actions`）を拡張し、検査範囲`scope`を追加する。

```ts
type DiagnosticCheck = {
  id: string;
  scope: "local" | "remote" | "external" | "cross";  // localのみ／remote状態／外形確認／両者の突合
  status: "pass" | "warn" | "fail" | "not_checked";
  code: string;                            // allowlist化した診断code
  message: string;                         // 人向け1行（秘密を含まない）
  next_actions: string[];                  // 安定したaction名のみ（doctor互換）
};
```

- `doctor`は全checkに`scope: "local"`を付与するのみで、既存の出力・終了code・契約（offline・通信なし）は変更しない。`scope`追加はresult JSONへの追加フィールドであり、外枠の`contract_version`は変えない。
- 要因ごとに次を区別する: `pass`（期待どおり確認できた）／`warn`（継続監視や運用判断が必要だが壊れてはいない）／`fail`（不一致・到達不能・矛盾）／`not_checked`（前提不足や予算上限で検査しなかった）。
- `message`/`code`は固定allowlistとし、例外文・応答本文・秘密を転載しない（既存のWorker診断と同じ規律）。

### 4.2 エージェント向けの出力・操作規約

本CLIはIssue #5以降、AI agentが`--json`出力を読み、`next_actions`に従って次の操作を自律的に選ぶことを前提としている（[`agent-output.ts`](../packages/cli/src/agent-output.ts)の外枠、`describe`のeffects分類）。本Issueの新コマンドも含む**今後のCLI出力・操作すべて**に次を適用する。

1. **外枠とpayloadの厳密化**: `--json`は`agentEnvelope`の外枠1文書。`result` payloadは厳密なZod schemaで検証済みのオブジェクトのみを格納し、未知キー・例外文・応答本文を転載しない。
2. **安定したcode**: 状態判定はenum化した`code`/`status`で行う。agentは人向け散文`message`をparse対象にしない。`code`は一度決めたら変更しない。
3. **実行可能なnext_actions**: 外枠（`agentEnvelope`）の`next_actions`は既存どおり`{ action, command, args }`の形で具体的な読取コマンドと引数を提示する（例: `{ action: "observe_same_job", command: "progress", args: [job_id] }`）。check単位の`next_actions`はdoctor互換の**安定したaction名文字列**（例: `"observe_same_job"`）とし、運用文書がaction名とコマンドの対応を定義する。いずれも提案するのは読取・記録保全のみで、変更操作（Resume・purge・再送）は提示しない。
4. **人向け出力の導出**: 人向け表示は構造化resultから機械的に生成する（`doctor`の`formatDoctor`と同じ方式）。構造化結果と食い違う個別の表示分岐を作らない。
5. **決定論的な並び**: check/phaseの配列順は固定。集計は数値のみ。時刻はRFC 3339文字列。
6. **長時間コマンドの分離**: `watch`のような長時間コマンドは、途中経過をstderrへJSON linesで出力し、stdoutには最終的な外枠1文書のみを出す（既存の「診断・progressはstderr」規約どおり）。agentはstdoutの末尾1文書だけをparseすればよい。
7. **プロンプトなし**: 読取専用コマンドは対話プロンプトを出さない。`--non-interactive`相当に固定する。
8. **事前の副作用宣言**: 新コマンドを`describe`のeffects/authentication/recoveryに機械可読で登録し、agentが実行前に通信・書込みの有無を判定できるようにする。詳細payloadの個別JSON Schema提供は、既存の未提供方針（[agent_usage.md](../docs/agent_usage.md)）のまま将来課題とする。
9. **終了codeの意味の固定**: 終了codeは文書化した意味のみに使う（`diagnose`/`verify`はdoctorと同じfail=1/warn=0、`watch`は§8.5のE1）。

## 5. 機能A: リモート診断 `diagnose`

### 5.1 コマンド形式の候補

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| A1: `doctor --remote --show ID` 拡張 | doctorにremote検査を追加 | 項目が1つにまとまる。実装はdoctor.ts内で完結 | `describe doctor`のoffline契約・Skill記述・`authentication: none`の変更が必要。local検査とremote検査の失敗が1つの終了codeに混ざる。「通信しない」前提の自動化が破壊される |
| A2: 新規`diagnose SHOW_ID` コマンド（**推奨**） | doctorのCheck形式を再利用した独立コマンド | 通信境界が明示的。doctor契約不变。local/remote/externalの混在を出力側で分離できる。段階追加が容易 | コマンドが1つ増える。doctorとdiagnoseの使い分けを文書化が必要 |
| A3: `show-status`等へ判定付きcheck群を追加 | 既存コマンドの拡張 | 新コマンドなし | 既存の生snapshot出力契約を破壊し、JSON利用者に影響する。複数コマンドに同様の判定を重複実装する |

**決定（2026-10-24レビュー）: 案A2。** doctorはlocal専用のまま、`diagnose`をremote診断の入口とする。`diagnose`は必要時に`doctor`のlocal検査を内部再利用し、先頭に`scope: "local"`の行として表示する。

### 5.2 検査項目（初期案）

`diagnose SHOW_ID [SHOW_ID...]`（直列処理）。同時指定の既定上限は5件（定数）で、`--max-shows N`（1〜20、絶対上限も定数）で上書きできる。超過は`invalid_arguments`。共有検査（service全体のhealth・`cf-credentials`）は1 invocation 1回だけ行う。既定はlocal+remote。`--external`で外形確認（機能Cと同じ検査）を追加。`--json`対応。

| id | scope | ソース | fail | warn |
| --- | --- | --- | --- | --- |
| `workspace` / `local-state` / `credentials` / `account-target` / `domain-records` | local | 既存doctor検査の再利用 | 設定不正・account不一致・domain記録破損 | key不在・認証情報不在・未完了domain操作 |
| `local-unfinished` | local | `operation-list --local --incomplete` 相当の読取 | — | 未完了操作の存在（件数とfamilyのみ表示） |
| `remote-identity` | remote | `health` GET | 通信不能・service_id/worker_version_id/service_config_sha256不一致 | — |
| `cf-credentials` | remote | `GET /accounts/{account_id}`（読取、1 invocation 1回）。`CLOUDFLARE_*`未設定時は`not_checked`（存在確認はlocal検査が担う） | token無効（401/400）・Cloudflare API到達不能（管理APIとは別code） | 403（token有効だが当該accountの読取不可。狭権限設計での偽warnあり） |
| `admission` | remote | `health`（Show scoped） | — | paused・`publication_ready=false` |
| `maintenance` | remote | `health.maintenance` / `runtime_update` / `setup` | — | 共有保守・更新・setupが進行中 |
| `registration` | remote | `registrations/{show}` | — | missing/requested |
| `queue` | remote | `health`のqueued/active/drained | active jobがblocked | queued>0（待機中の表示） |
| `unfinished-operations` | remote | `operations/list?incomplete`（当該Show） | — | 未完了操作あり |
| `target-state` | remote | `inspect` | Show missing | draft/unpublished（未公開であることの明示） |
| `consistency` | cross | local draft journal・operation記録と`inspect`/`jobs`の突合 | 凍結済み公開要求がserverに存在しない・identity矛盾 | local下書きが残存している（未公開の意図の確認催促） |
| `delivery`（`--external`時） | external | 機能Cの検査 | 公開済みpathが配信されない | paused期待応答など |

- 判定方針: identity矛盾は即`fail`。paused・blocked・未完了は`warn`とし、命令的に修復しない。`next_actions`は既存コマンド（`show-status`・`operation-status`・[操作ガイド](../docs/sqlite_operation_recovery.md)）への読取指示に限定する。
- `cf-credentials`（2026-10-25レビューで含める決定）は「token有効性と当該accountへの読取」だけを主張し、操作種別ごとの権限保証は表示しない。Cloudflare APIへの通信不能は管理APIの通信不能とは別のcodeで区別する。
- 複数Show指定時（2026-10-25レビューで上限を決定）はShowごとのchecks・summaryに加えて全体summaryを出す。終了codeはdoctorと同じ（いずれかのShowにfailがあれば1、warnのみは0）。一部Showの通信断は他Showの検査を中止させず、各Show独立に報告する。
- 通信断は`remote-*`全体を`fail`（code: `observation_unavailable`）とし、その旨を出力の先頭に明示する。部分的な成功を全体成功として表示しない。

### 5.3 出力例

人向け表示（構造化resultから生成。§4.2）:

```
PASS  remote-identity   Runtime matches the local service configuration
WARN  admission         Show is paused; delivery and admission are suspended
WARN  queue             1 queued job waiting; no active job
FAIL  consistency       Frozen publication request is missing remotely; preserve records
Summary: 6 pass, 3 warn, 1 fail, 0 not checked
```

`--json`は外枠1文書。agentは`scope`/`status`/`code`/`next_actions`だけを解釈し、散文`message`に依存しない:

```json
{ "contract_version": 1, "command": "diagnose", "ok": true,
  "target": { "workspace": "/absolute/workspace", "show_id": "daily" },
  "result": {
    "checks": [
      { "id": "remote-identity", "scope": "remote", "status": "pass", "code": "runtime_matches",
        "message": "Runtime matches the local service configuration", "next_actions": [] },
      { "id": "queue", "scope": "remote", "status": "warn", "code": "queued_waiting",
        "message": "1 queued job waiting; no active job",
        "next_actions": [ "observe_same_job" ] },
      { "id": "consistency", "scope": "cross", "status": "fail", "code": "frozen_request_missing",
        "message": "Frozen publication request is missing remotely; preserve records",
        "next_actions": [ "preserve_records_and_inspect" ] }
    ],
    "summary": { "pass": 6, "warn": 3, "fail": 1, "not_checked": 0 } },
  "operation": null, "error": null, "next_actions": [] }
```

`next_actions`が参照するのは読取・保全のコマンドだけである（§4.2）。

## 6. 機能B: 公開進捗 `progress JOB_ID`

### 6.1 実装方式の候補

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| B1: `job-status`へprogress欄を追加 | 既存コマンドの拡張 | コマンド増なし | `job-status`は「statusをそのまま返す」契約で、合成表示を載せると意味が変わる。lifecycle/archived検索との組み合わせで出力が複雑化 |
| B2: 新規`progress JOB` コマンド（**推奨**） | local journal・remote job状態・operation eventsを合成したフェーズ表示 | 「見える範囲だけ・不明は不明」という表示に専念できる。`job-status`のlookup処理（lifecycle→archived→drafts）を再利用し、job解決は既存と同じ | コマンドが1つ増える |
| B3: `publish-*`の待機出力だけ強化 | wait()の表示を豊かにする | 追加コマンドなし | CLI終了後・他端末からの事後確認ができない。Issueの「後から把握する」用途を満たさない |

**決定（2026-10-24レビュー）: 案B2。** 進捗表示は独立した読取コマンドとし、`publish-*`のwait()は現状維持（段階Dのwatchが待機中の豊富な表示を担う）。

### 6.2 フェーズモデル

job解決は`job-status`と同じchain（lifecycle journal → archived publication → draft journals → remote観測）を使う。各フェーズは固定順で、状態は`done`/`in_progress`/`pending`/`unknown`/`not_applicable`の5値のみ。

| phase | 主ソース | 判定材料 |
| --- | --- | --- |
| `input_frozen` | local draft journal | target 凍結・`input_fingerprint` |
| `upload:audio` / `upload:metadata` / `upload:cover`（資産ごと） | local journal + operation記録 | `prepared`→`put_requested`→`put_acknowledged`→`verified`（全量readback完了）→`attached` |
| `publication_submitted` | local journal + `jobs` GET | 凍結要求とqueued受付（sequence） |
| `fifo_waiting` | `jobs` GET + `health` | state=queued。待機理由を導出（下記）。FIFO内順位は未提供のため表示しない（queued総数のみ） |
| `executing` | `jobs` GET | state=running。実行内部段階・CPUは観測不能と明示 |
| `cache_purge` | なし | 観測不能を既定で`unknown`表示。succeededはpurge完了gateを通過したことを意味する、と注記 |
| `terminal` | `jobs` GET | succeeded / failed（reason_code） / blocked（reason_code） |

待機理由（`waiting_reason`）の導出:

- `admission_paused`: queued中にShow admissionがpaused。
- `head_job_blocked`: 先頭jobがblocked（該当job_idをlocal出力として表示）。
- `waiting_for_active`: 他jobがrunning（該当job_id）。
- `observation_gap`: 状態GETが通信断等で失敗し、表示しているのが最終既知状態（`observed_at`と`stale`表示を併記）。

- 不明なフェーズは`unknown`のまま表示し、`done`や0値へ変換しない。jobが終端でも、`cache_purge`等の観測不能項目は`unknown`（あるいはsucceeded時の注記）を保持する。
- RSS取り込み親操作の集計進捗は既存`operation-status rss-import`の`progress`があるため、初期段階の対象はpublication/lifecycle jobに限定する。
- 出力は人向けフェーズ表＋`--json`（外枠は`agentEnvelope`、`result.phases`・`result.waiting_reason`・`result.observation`）。終端failed/blockedでも`progress`自体の終了codeは0（観測コマンドの失敗ではない）。

## 7. 機能C: 外形確認 `verify SHOW_ID [--episode EPISODE_ID]`

「処理成功」（server内でjobがsucceeded）と「配信を確認できた」（公開originから取得でき、既知の期待と一致した）を別々に報告する。管理key不要・公開pathのみへのGET/HEADで、管理APIには一切触れない。期待値はworkspaceのlocal記録（draft/publication journal・show.toml・episode TOML）から取り、無い比較は`not_checked`にする（公開全文の管理API取得は未提供という既存方針のまま）。

### 7.1 HTTP手法の候補

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| C1: feed=全量GET、cover/audio=HEAD（**推奨**） | feed XMLはbounded全量GET（上限32,000,000 bytes＝serverのrender予算上限と同じshared定数）でparse。cover/audioはHEADでstatus・Content-Length・ETag比較 | 音源を毎回downloadしない（Issueの安全条件）。ETag・Content-Lengthで実質確認できる。feedは内容検証（GUID・enclosure URL）に全量が必要 | HEADが中間系で透過しない環境では追加対応が必要（C2で補完） |
| C2: HEAD不可のときRange GET `bytes=0-0` のfallback | HEADが200/206を返さない場合の補助 | 透過しない環境でも確認可能 | 実装が1段増える |
| C3: 常に全量GET＋sha256照合 | 最大の厳密性 | 監視のたびに最大300MBをdownloadする。Issueが明示的に避けるべきとしている挙動 | 非採用 |

**決定（2026-10-24レビュー）: 案C1を基本とし、HEAD失敗時のC2 fallbackのみを含める。** 全量downloadは提供しない（将来再検討する可能性は残すが、本Issueの範囲外とする）。

### 7.2 検査項目（初期案）

対象は`public_base_url`起点。feedは`/podcasts/{show}/feed.xml`を全量GETし、coverのURLはfeedの`itunes:image`から、audioのURLは当該EpisodeのGUIDに対応する`enclosure`から導出する（実装時の確定: 公開audio URLは`/podcasts/{show}/episodes/{episode}/{revision}.mp3`形式でrevision idをlocal記録から構成できないため）。redirectは`redirect: "manual"`で観測し、連鎖（最大3跳躍・https限定）を記録してから最終targetを確認する。workers.dev→独自domainへの301/307は記録の上、最終targetで検査する。

| id | 期待値ソース | pass | fail / 期待外応答 |
| --- | --- | --- | --- |
| `feed_status` | catalog/local lifecycle | 200（published時）。paused時は503を`pass`（code: `paused_503_expected`）としてadmission状態の行と併記 | published想定で404/503以外の不一致・通信断 |
| `feed_content` | local show.toml・episode TOML | XML parse成功・rss/channel構造・既知GUIDの存在・enclosure URLのoriginが`public_base_url`と一致 | GUID欠落・enclosure URLのorigin不一致。local原本なしでは比較を`not_checked`、観測結果のみ報告 |
| `cover` | local journalのstaged cover（拡張子・length） | 200・Content-Length一致（既知時）・ETag一致（receipt保持時） | 404・length不一致 |
| `audio`（`--episode`時） | local journalのstaged audio（length・receipt） | 200（HEAD）・Content-Length一致・Content-Type: audio/mpeg | 404（published想定時）・length不一致 |
| `unpublished-episodes` | local episode TOML・journal | 未公開Episode（succeeded記録なし）のGUIDがfeedに存在しない→pass（正しく未リンク）。存在すればwarn（意図しない公開の疑い） | feed未取得時はnot_checked |

- 期待する404・停止中の503・削除済み410・redirect・通信断・取得不一致・観測欠測は、すべて別々の`code`で区別する。
- Show paused時に公開pathが200を返す場合はgate不整合として`fail`（配信が止まっていないことになる）。
- 出力は`checks[]`（scope: `external`）に加え、`processing`（local journalのjob終端。無ければ`not_checked`）と`delivery`（外形結果）を独立したblockとして表示する。fail時終了1、warnのみ終了0（doctorと同じ）。
- 読取には既存のbounded reader（`bounded-http-read.ts`の`collectStreamBytes`）を流用し、回数・時間・byte上限を明示する。feed全量GETのbyte上限はserverのrender予算と同じ32,000,000 bytes（[`publication-budget.ts`](../packages/shared/src/publication-budget.ts)の定数を共通利用し、超過時は`fail`・code: `size_limit_exceeded`）とする（2026-10-25レビュー決定）。`Cache-Control`等の応答headerは観測記録に残すが、検査失敗の理由文に応答本文を転載しない。
- 実装時の確定（2026-10-25）: (1) cover・audioのURLはfeed内容から導出する。(2) GUID照合はlocal journalでsucceededが記録されたEpisodeに限定する。(3) audioのETag照合は省略しContent-Length照合とした。(4) `unpublished_paths`は`unpublished-episodes`（未公開Episodeのfeed上リンク不在確認）として実装した。

## 8. 機能D: 継続観測と終端報告 `watch JOB_ID`

### 8.1 観測単位の候補

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| D1: job単位（**推奨**） | `watch JOB_ID` で当該jobの終端まで観測 | 対象が最小かつ明示。既存lookup/観測APIで足りる。報告対象のidentityが単純 | 複数job/Show全体の見守りには複数回実行が必要 |
| D2: Show単位 | 未完了操作すべてを対象化 | 1回でShow全体を見守れる | 「Show全体の完了」の定義（RSS子操作・draft・blockedの扱い）が必要になり、初期段階の範囲が不明瞭化する |
| D3: 常駐daemon | バックグラウンド常駐 | 継続性 | 単一バイナリCLIの運用方針を外れる。予算・排他・生存確認の設計が別途必要。Issueは要求していない |

**決定（2026-10-24レビュー）: 案D1。** D2はD1の安定後に読取集約として追加できる。D3は非採用。

### 8.2 観測の予算と挙動

- `--timeout SECONDS`（既定600、上限3600）と`--interval SECONDS`（既定5、下限1、上限60）。poll回数は`timeout/interval`で制限し、さらに720回の絶対上限を設ける。各pollは既存bounded GET（3回/30秒）。
- 観測対象は`progress`と同じjob解決chain。remote観測は`jobs/{request_id}` GET（Show scoped）。応答喪失時は既定の有限retryの後、`observation_gap`として最終既知状態を維持する。一度でも観測済みのjobが消失した場合は`unobservable`（code: `job_missing`）で即時終了し、継続pollしない。
- 終端（succeeded/failed/blocked）を観測した時点、または予算消費で`unobservable`（code: `budget_exhausted`）となった時点で終了する。blockedは「解消を待つ」対象ではなく終端として扱う（解消は明示的な運用操作）。
- SIGINTでは追加pollを行わず終了130とする（最終の外枠文書は出さない）。実行中のGETはbounded readerの中断で決着させ、localへの書込みはないため保全すべき追加状態は生じない。
- watchは読取専用でlocalへの書込みを行わない。並列実行・再実行は安全であり、同一の終端を再報告するだけである（最終既知状態の保持は`publish-*`/lifecycle実行の既存journalが担う）。
- watchは`--verify`のような合成flagを持たない（2026-10-25レビュー: 案B）。観測終端が`succeeded`のとき、最終報告の`next_actions`に外形確認を含め、agentが次の操作として`verify`コマンド（`show_id`引数付き）を実行できるようにする。処理成功と配信確認は別コマンド＝別報告として分離する。

### 8.3 通知経路の決定（CLI完結）

**決定（2026-10-25レビュー）: 通知はCLIで完結させる。CLI以外の通知経路（外部webhook・SaaS・メール・OS通知等）は本Issueでは提供しない。**

- 通知の受け手は「CLIを後から実行する管理者/agent」だけを想定する。`publish-*`の待機は最大300秒で、それを超えるFIFO待機・blocked・観測不能は、`watch`での継続観測か、`progress`/`job-status`による後発確認で受け取る。
- 通知とは`watch`の終端報告である（人向けの終端行、`--json`の`result.outcome`、終了code §8.5）。追加の通知機構（outbox・`notification_id`・再送・通知先の秘密管理）は持たない。
- 報告するイベントは**jobの終端のみ**（`succeeded`/`failed`/`blocked`/`unobservable`）とし、中間遷移（queued→running等）はstderrのJSON linesにのみ出す。
- 検討した比較案と却下理由: 外部への汎用webhook 1経路（運用者指定の受信側へのJSON POST）は、マシンを離れた運用者への異常到達を満たす唯一の案として検討した。しかし現行の運用仕様（CLI/agent経由の操作と後発確認）に対して過剰であり、通知先の秘密管理・結果不明時の再送設計といった新たな論点を持ち込むため非採用とする。特定SaaS個別対応・OpenCode session通知（[過去試験のsupervisor方式](archive/trial_notifications_and_r2_read_diagnostics.md)）も同様に範囲外とする。外部通知が必要になった時点で別Issueとして再設計する。

### 8.4 通知の表現と再確認

- 通知は`watch`の標準出力と終了codeで完結する。人向けには終端と理由codeの行、`--json`には外枠の`result.outcome`と`result.observation`を出す。
- 外部送信（POST等）を行わないため、通知不達・重複送信・秘密の外部送信は構造的に発生しない。観測不能（`unobservable`）は成功として表示せず、終了code 2で区別する（§8.5）。
- `watch`終了後の再確認は同じ読取chainで行う。`progress JOB`/`job-status JOB`が同一のjournal・APIから終端を再報告し、外形確認は`verify`コマンドが担う。

### 8.5 出力と終了code

- 人向けには観測開始・状態変化・終端を行単位で表示する（途中経過はstderrのJSON lines、最終の外枠1文書はstdout。§4.2）。`--json`は外枠に`result.outcome`（`succeeded|failed|blocked|unobservable`＋理由code）・`result.observation`（poll回数・最終観測時刻・gap履歴）。
- 終了code（2026-10-24レビューでE1を採用。2026-10-25レビューで外部通知の廃止に伴い「3=通知不達」を削除）:
  - 0: `succeeded`を観測
  - 1: `failed`または`blocked`を観測
  - 2: `unobservable`（`budget_exhausted`・`job_missing`等）
  - SIGINTによる中断は130（§8.2）
- 「常に0とする案（旧E2）」は不採用のまま。観測不能と失敗を終了codeから区別しないと、Issueの「異常を見逃さない」に反するためである。

## 9. 実装段階とファイル構成

各段階は単独でリリース可能な粒度とし、段階間の依存は共有Checkモデル（段階A）のみとする。

| 段階 | 内容 | 主なファイル |
| --- | --- | --- |
| A | 共通Checkモデル（scope付き）・`doctor`の`scope: "local"`付与・`diagnose` | `packages/shared/src/diagnostics.ts`（新規）、`packages/cli/src/doctor.ts`、`packages/cli/src/diagnose.ts`（新規）、`help.ts`・`index.ts`・`describeCommand` |
| B | `progress` | `packages/cli/src/progress.ts`（新規）、同上の配線 |
| C | `verify`（bounded公開path読取helperを含む） | `packages/cli/src/verify.ts`（新規）、`packages/cli/src/public-http.ts`（新規） |
| D | `watch`（終端のCLI報告・終了code・next_actionsによる`verify`連鎖） | `packages/cli/src/watch.ts`（新規） |

- `agentEnvelope`の外枠・`CONTRACT_VERSION`は変更しない。`describe`のeffects分類は、`diagnose`/`verify`/`watch`をread_only（remote: `read_only`）として追加する。
- 管理者Skill（`admin-skill.ts`）のコマンド案内に新コマンドを追記する。
- Worker（`src/sqlite-worker.ts`）・DO・SQLite形式・管理API・`readSqliteManagementGet`の許可pathは変更しない。将来の拡張（FIFO内順位・purge checkpoint等のserver側開示）は必要になった時点で別案とする。

## 10. テスト計画（ローカル回帰）

受け入れ条件ごとの対応。既存の模擬transport（`test-support`）とfake public originで単体試験する。実機は別承認時のみ。

| 受け入れ条件 | 試験 |
| --- | --- |
| 検査範囲とpass/warn/fail/not_checkedの区別 | `diagnose`/`verify`が全checkにscope・statusを持つこと。`doctor`がlocal専用のまま出力互換であること |
| queued・CLI okを公開成功としない | `progress`のqueued表示・`watch`のoutcome・`verify`のprocessing/delivery分離の各assertion |
| 進捗不明・観測不能・ログ欠測の明示 | unknown フェーズがdone/0へ変換されないこと。`unobservable`が成功として表示されないこと。実装がログを読まないこと（設計属性） |
| 通信断 | transport拒否時に`observation_unavailable`/`unobservable`となり、成功・正常値へフォールバックしないこと |
| 重複観測 | 再watch・並列watchが読取として安全であること（local書込みなし・同一終端の再報告） |
| 終端報告 | 終端行・`--json`の`outcome`・終了code（0/1/2）が一致すること。外部POSTを行わないこと（設計属性） |
| Pause | paused中の`diagnose` warn・`verify`の期待503・`progress`の`admission_paused` |
| blocked | `progress`/`watch`がblockedを終端として理由code付き表示し、自動解消しないこと |
| HTTPエラー | 管理API 401/404/5xx・公開path 404/410/503/redirectの各分類code |
| 未公開path | unpublished audio 404・draft feed 404が期待どおりpassになること |
| 予算 | timeout/interval/poll上限・byte上限の強制。予算消費で`unobservable`/`not_checked`になること |
| 秘密 | 外部送信を行わないこと。出力・記録に秘密鍵・token・応答本文が含まれないこと |

`bun test`・`npm run check`を通し、`npm run build:cli`後の単一バイナリでのsmokeも既存手順に合わせる。native性能・Free適合・実機配信確認は本地試験の範囲外と明記する。

## 11. 運用文書

- 新規`docs/observability.md`: 4コマンドの使い分け、検査範囲とcode一覧、`watch`の終了codeと再確認の方法、失敗時の読み方（既存[操作ガイド](../docs/sqlite_operation_recovery.md)への接続）。
- [agent_usage.md](../docs/agent_usage.md)に新コマンドの概要と「ok≠公開成功」「処理成功と配信確認の分離」の記載を追加。
- [README.md](../README.md)のコマンド一覧への追記、[design/README.md](README.md)の索引更新。CHANGELOGは実装時に記載する。

## 12. 非目標

- probe実行・purge・repair・Resume・公開・未知要求再送などの状態変更（表示とnext_actions提示に限定）。
- CLI以外の通知経路（外部webhook・SaaS連携・メール・OS通知等）。常駐daemon。必要になった時点で別Issueとして再設計する。
- ログ（tail・保存ログ）に基づく判定。CPU時間の推定。
- Worker管理API・永続形式の変更。全Show横断索引の新設。
- 公開済み全文の管理API取得・field差分表示（既存の未提供方針を維持）。
- 音源全量downloadによる監視・確認（提供しない。将来再検討の可能性は残すが、本Issueの範囲外）。

## 13. 安全条件・受け入れ条件との対応

| Issueの条件 | 本案での対応 |
| --- | --- |
| remote診断は新規probe・purge・repair・Resume・公開・再送をしない。GET/HEADと状態変更を区別 | §2.1・§5（管理API GETのみ）・§7（公開path GET/HEADのみ、管理key不要） |
| 全Showの操作横断索引を前提にしない | §1.3・§5（明示1〜5 Showの読取集約）・§8.1（job単位） |
| pollingの予算と開始済みIOのsettlement | §2.3・§8.2（bounded GET・回数/時間上限・SIGINT決着） |
| 通知は重複し得る前提での照合。通知失敗と公開失敗の混同禁止 | §8.3（CLI完結・外部送信なしで構造的に解消）・§8.5（終了code分離） |
| 秘密・非公開job ID・素材URLを外部通知へ送らない。通知先も秘密 | §8.3（外部通知なし）・§4.1（出力のallowlist規律） |
| 期待する404・停止中503・通信断・不一致・欠測の区別。全量download禁止 | §4（code分類）・§7.1（C1採用・C3非採用） |
| 検査範囲とpass/warn/fail/not_checkedの区別 | §4（scope付きCheck） |
| queued/okを公開成功としない。job終端と外形確認の分離 | §6（フェーズ表示）・§7.2（processing/delivery分離） |
| 進捗不明・通知不達・ログ欠測を正常・0値へ変換しない | §2.4・§6.2（unknown維持）・§8.3/§8.4（通知不達は外部送信なしで構造的に発生しない） |
| 通信断・重複観測・通知失敗・Pause・blocked・HTTPエラー・未公開pathの回帰試験 | §10 |
| 段階的実装の仕様と運用文書 | §9・§11 |

## 14. レビュー経過と残る論点

### 決定済み

2026-10-24レビュー:

- §5.1 = 案A2: 新規`diagnose`コマンド。`doctor`はlocal専用のまま分離する。
- §6.1 = 案B2: 新規`progress`コマンド。`publish-*`のwait()は現状維持。
- §7.1 = 案C1 + C2 fallback（HEAD失敗時のRange GET 1byte）。音源全量downloadは提供しない（将来再検討の可能性のみ残す）。
- §8.1 = 案D1: watchはjob単位。
- §8.5 = 案E1（watch終了code）。ただし下記の2026-10-25決定により「3=通知不達」を削除。
- CLI出力・操作の全般規約として§4.2（エージェント向け出力・操作規約）を追加。

2026-10-25レビュー:

- §8.3 = 通知はCLI完結。`watch`の標準出力・終了codeで終端を報告し、CLI以外の通知経路（外部webhook等）は非採用・非目標とする。これに伴い、outbox・`notification_id`・通知先秘密管理の仕組みを設計から削除し、watch終了codeは0/1/2に簡約した（§8.5）。
- §5.2 = `cf-credentials`検査を含める（案A、既定on）。`GET /accounts/{account_id}`の読取1件を1 invocation 1回だけ行う。未設定時は`not_checked`、403は`warn`、主張はtoken有効性に限定する。
- §5.2 = 複数Show同時指定は既定上限5件（定数）+`--max-shows N`（1〜20、絶対上限も定数）。超過は`invalid_arguments`。service設定(`castloop.toml`)への記載はconfig hashとWorker runtime identityの照合を壊すため不採用。新規のCLI設定ファイルも上限1つのため不採用。
- §8.2/§8.4 = `watch --verify`は持たない（案B）。watchは純粋な観測とし、`succeeded`観測時の`next_actions`で`verify`コマンドへ連鎖する。処理成功と配信確認は別コマンド・別報告とする。
- §7.1/§7.2 = feed全量GETのbyte上限は32,000,000 bytes（serverのrender予算上限と同じshared定数を共通利用）。超過は`fail`（`size_limit_exceeded`）。

### 残る論点

なし（2026-10-25レビューで4点すべて決定）。実装へ移行する。

### 実装状況（2026-10-25）

段階A〜D（`diagnose`/`progress`/`verify`/`watch`）を実装し、`bun test`・`npm run check`を通過した。`diagnose --external`（verify検査の集約）、watch成功時のnext_actionsによるverify連鎖、終了code 0/1/2/130を含む。運用文書は[observability.md](../docs/observability.md)。
