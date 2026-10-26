# Issue #65: Episode予約公開の設計・開発計画

**現在の統合版：** Issue #70のサイト改善を統合した開発版は内部queue/content形式**11/11**の新規環境専用。本書の9/9は予約公開単独の導入段階であり、実機検証もその環境の結果である。旧9/9・サイト試験版10/11等からのDB変換・互換配備は提供しない。現在の設定・操作は[管理用設定ガイド](../docs/admin_configuration.md)を参照する。

作成日: 2026-10-24。**管理者レビューにより、scheduler A／管理設定C／日時identity A／停止後Aと4節の日時解決規則を採用し、開発・ローカル検証へ進む。**

- 対象Issue: [#65](https://github.com/simosako/castloop-v2/issues/65)
- 調査基準: このworktreeの`9c8c23f`（v0.7.3）。Issue本文の調査基準であるv0.7.2から、独自domainと内部queue/content形式6/7の変更を含む。
- 初回は設計案だけを作成。その後の管理者annotationで上記方針を選択し、日時解決規則の実装指示を受けた。
- 実装承認と、Cloudflareへの配備・公開・Resume・資源／domain／権限／課金変更・削除の承認は別である。

## 1. 要件と今回の補正

目的は、確認済みのEpisodeをまとめて準備し、管理者PCを起動したままにせず指定日時以降に公開すること。

Issue本文の「タイムゾーンを明示した予約日時」は、今回の管理者指示により次のように補正する。

1. **ユーザーによるタイムゾーン指定は任意。未指定ならサーバーの時間基準を使う。**
2. 現行Cloudflare Workersのサーバー基準はUTC。管理者PCのOS設定やエッジ拠点の所在地を使わない。
3. 設定ファイルまたはCLIからタイムゾーンを指定できるようにする。
4. 指定を強制しない一方、承認画面には採用したzone／offset・現地日時・UTC日時・設定の出所を表示する。
5. 予約承認時にUTCの絶対時刻へ確定し、以後の設定変更やタイムゾーンデータ更新で予約時刻を動かさない。

その他の必須要件:

- create／update／uploadだけでは公開も予約もしない。対象・素材・日時を含む明示承認が必要。
- 遠い将来の予約を公開FIFOへ先に入れず、通常公開を待たせない。
- 一覧・詳細・日時変更・取消・JSON出力を提供する。
- 実行時もruntime／config／window／base／generation／素材identity／公開gateを照合する。
- 予約受付、FIFO受付、公開完了を区別する。公開成功は同じ公開jobの`succeeded`で判断する。
- Pauseや保守を勝手に解除しない。不明な要求・公開書込を再送しない。
- Feedだけでなく、未承認音源の直リンクからも予定前に漏れない。

## 2. 現行実装から分かったこと

| 実装 | 現状と設計への影響 |
| --- | --- |
| `packages/cli/src/sqlite-draft.ts` | `publish()`でローカル素材を再照合し、runtime／config／window付き要求を凍結して送る。予約にも同等の照合が必要 |
| `packages/cli/src/sqlite-draft-journal.ts` | 送信済みdraftの編集や未知jobへの置換を拒否する。予約受付後も同じ保護が必要 |
| `src/sqlite-publication-queue.ts` | 全queued jobを受付sequence順に実行する。未来予約をそのまま入れる方式には適さない |
| 同上の`schedule()` | 現在はAlarmが存在しないときだけ即時予約する。未来Alarmが既にあると通常公開の起動が遅れるため、変更必須 |
| `src/sqlite-worker.ts` | 同じShow DOのAlarmをdomain保守・runtime setup・公開jobで共用している。予約用Alarmを独立に上書きできない |
| `src/sqlite-show-service.ts` | Show単位の受付・Pause・保守拘束を管理する。予約もここに閉じるのが自然 |
| `src/sqlite-operation-records.ts` | uploadの再変更・取消・cleanup禁止を現在は`publication_jobs`の存在で判断する。予約中の素材参照にも拡張が必要 |
| `packages/shared/src/index.ts`、`src/sqlite-publication-executor.ts` | 公開済みEpisodeのGUID・`published_at`等を維持する。予約時刻の変更とmetadata identity変更は別問題 |
| `packages/shared/src/sqlite-service.ts` | strictなサービス設定全体をhash化する。CLIの表示・入力設定を安易に追加すると配備identityへ影響する |

現行のShow分離、immutable Feed／cover／audio、purge-before-completion、failed／blockedの区別は維持する。

## 3. 方式の比較

### 3.1 サーバー側scheduler

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A: Show DO内の予約表＋既存Alarm（推奨）** | 到来前は予約表だけに保存し、到来時に同じDO内の公開FIFOへ原子的に移す | 既存構成を利用。取消とFIFO投入を同じtransactionで調停できる。Show間分離を維持。Cron等の追加資源不要 | 共用Alarmの最早期限調停が必要。予約・job・素材保護の統合が必要 |
| B: 専用scheduler DO | schedulerが期限を管理し、Show DOへ要求を送る | 予約用Alarmを公開処理から分離できる | DO間送信の不明結果・重複・取消競合を扱う必要。原子的な取消が難しく、状態と保守対象が増える |
| C: Cronで定期走査 | 定期実行でShowの期限到来予約を探す | 定期巡回という動作は理解しやすい | 走査間隔による遅延、Show横断の発見・fan-out、設定とAPI管理が増える。既存のShow内完結方針と相性が悪い |
| D: 外部schedulerからCLI起動 | 管理者が別環境のcron等を用意する | castloop本体の変更は小さい | 外部端末・秘密・監視が必要。Issueのサーバー側予約機能の代替にならない |

**推奨はA。** Queue、D1、Workflowsやサービス制御DOへの予約正本は追加しない。

### 3.2 タイムゾーン設定の置き場所

すべての案で`--timezone`を提供し、未指定時の既定をサーバー基準UTCとする。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| A: CLI指定のみ | 毎回`--timezone Asia/Tokyo`を付ける | 最小構成。設定ファイルの追加不要 | 常用zoneを毎回指定する手間・指定忘れがある |
| B: `castloop.toml`＋CLI | サービス設定に`admin_timezone`を追加する | 既存ファイル1つで管理できる | 現状は完全config hashの対象。配備設定と管理者の入力設定を分離する追加設計が必要 |
| **C: 管理用設定ファイル＋CLI（推奨）** | workspace直下の`castloop-admin.toml`に既定zoneを記載する | 表示・入力設定だけを変更でき、配備不要。サービスの厳密なconfig hashを変えない | ファイルが1つ増える。安全な読取と入力schemaを追加する必要 |

推奨案Cの例:

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

- ファイルも`timezone`も省略可能。秘密・サーバーの公開設定は入れない。
- workspace単位とし、初版ではユーザーglobal設定やShow別設定、独自の環境変数は追加しない。
- strict schema、通常ファイル、UTF-8、サイズ上限、symlink拒否を適用する。不正な指定を黙ってUTCにfallbackしない。

### 3.3 `published_at`と予約日時の関係

| 案 | メリット | デメリット |
| --- | --- | --- |
| **A: 別項目として管理（推奨）** | RSS上の公開日時と実行制御を分離でき、既存Episode更新・RSS由来identityを壊さない | 初回Episodeで両日時を揃えたい場合はmetadataの準備が必要 |
| B: 初回公開は両日時の一致を必須にする | 予約時刻とRSS日時のずれを防げる | 予約変更時にmetadataの再stage・再承認も必要。公開済みEpisodeの更新には別ルールが要る |

推奨案Aでは、`scheduled_at`は「公開処理を開始してよい最早時刻」、`published_at`はRSSのidentityとする。

- 新規Episodeで同じ日時にしたい場合は、`published_at`を編集してからstage・予約previewする。`create-episode`の生成日時を自動で予約日時へ変換しない。
- 公開済みEpisodeの予約更新でも`published_at`を維持する。
- 両日時が異なる場合はpreviewに両方と注意を出す。予約変更でmetadataやGUIDを黙って変更しない。
- 遅延しても`published_at`を実際の処理完了時刻へ書き換えない。

### 3.4 管理用設定の責務と既存設定の棚卸し

管理者の追加レビューに基づき、`castloop-admin.toml`は**workspace内のCLI入力・表示の好み**に限定する。配備設定、公開コンテンツ、秘密、処理中の事実、実行承認は保存しない。

| 既存項目／保存先 | 移動 | 理由 |
| --- | --- | --- |
| `castloop.toml`のaccount・service・Worker・bucket・origin・protocol・layout | しない | 管理者個人の好みではなく、サーバーと照合する配備先identity。既存config hashの契約を維持 |
| Cloudflare認証の環境変数 | しない | tokenは秘密。accountも配備先との照合が必要であり、管理設定で別の既定値を増やさない |
| `.castloop/`の管理鍵・client ID・journal・receipt・lock | しない | ユーザーが編集する設定ではなく、正確な要求・観測結果・所有者を保存する運用状態 |
| Showの`language`・owner・email・site URL等 | しない | 公開metadataであり、管理画面の表示言語や管理者連絡先ではない |
| `--workspace`・`--show` | しない | 操作対象の明示性を維持。設定による暗黙の対象選択や誤公開を避ける |
| `--json`・`--non-interactive`・preview hash・確認flag | しない | 呼出元の出力契約と操作ごとの承認。設定で承認や対話制御を持続させない |
| HTTP timeout・retry・poll回数／時間・page size・容量／サイズ上限 | しない | 現在はコードで定義する安全・資源予算。入力・表示の好みと一緒に可変にしない |
| 一時的なaudio・import・Skill出力path等 | しない | コマンド入力としての意味と既存の相対path基準を維持 |

調査対象は`workspace-config.ts`、`sqlite-service.ts`、`index.ts`、`sqlite-management-http.ts`、`sqlite-draft.ts`、`sqlite-operation-client.ts`、`verified-r2-put.ts`、`doctor.ts`等。**既存項目で今回移すべきものはない。**

将来候補はCLIの表示言語、色、進捗表示等。ただし現在は対応機能・利用要求がないため予約keyも実装も追加しない。日付書式のカスタマイズも、承認時のISO日時・offset・UTC表示を省略する用途には使わない。

初版は`schema_version = 1`と任意の`timezone`のみ。省略可能な設定のため`init`が自動生成・上書きする必要はない。`template admin-config`、`schema admin-config`、`validate admin-config FILE`、`doctor`で発見・検証できるようにする。未知keyは拒否する。管理設定はサービスhashやWorker bundleへ組み込まず、予約済みUTC時刻へ遡及しない。

## 4. 日時入力とタイムゾーンの仕様案

### 解決規則

1. `--at`に`Z`または`+09:00`等のoffsetがある場合、その絶対時刻を使う。
2. offsetのない日時は、`--timezone` → 管理用設定の`timezone` → サーバー基準UTC、の順で解釈する。
3. 明示offsetと`--timezone`を両方指定した場合は、そのzoneの当該日時のoffsetと一致することを検証する。不一致は拒否する。
4. 設定由来zoneは表示にも使用するが、明示offsetが決めた絶対時刻を変更しない。表示の出所と入力offsetを区別する。
5. zoneは`Asia/Tokyo`、`America/New_York`等のIANA名と`UTC`を受け付ける。曖昧な略称`JST`、`CST`等を仕様上の入力名にしない。

### 境界条件

- 入力は日付と時刻を含むISO形式に限定する。初版は秒まで、小数秒・自然言語・相対時刻・繰り返し予約は対象外。
- 夏時間開始で存在しない現地日時は拒否する。
- 夏時間終了で二重に存在する現地日時は、明示offsetがなければ拒否し、どちらかを勝手に選ばない。
- 不正日付、未知zone、過去・現在の予約を拒否する。承認中に予定を過ぎた場合も即時公開へ変換せず再previewを求める。
- 過去判定の正本はサーバー時刻。CLI時計による事前診断だけで受付可否を決めない。
- 承認した入力、zone、offset、UTC、解決元を保存する。実行時にzoneからUTCを再計算しない。
- 独自のDST変換を実装せず、Temporal相当の検証済み変換ライブラリを利用する方針。候補は`@js-temporal/polyfill`。P0でBun 1.4.2・単体バイナリ・Worker bundle・ライセンスを確認し、依存追加を確定する。

例:

| 入力 | 適用zone | 確定UTC |
| --- | --- | --- |
| `2026-11-01T09:00:00`、設定なし | UTC（サーバー） | `2026-11-01T09:00:00Z` |
| 同じ入力、設定が`Asia/Tokyo` | Asia/Tokyo | `2026-11-01T00:00:00Z` |
| 同じ入力、`--timezone Asia/Tokyo` | Asia/Tokyo（CLI） | `2026-11-01T00:00:00Z` |
| `2026-11-01T09:00:00+09:00` | 入力offset | `2026-11-01T00:00:00Z` |

## 5. 推奨構成と永続identity

```text
CLI: TOML編集 → updateで素材保存・検証 → 予約preview → 対象・内容・日時を明示承認
Show DO: 予約と素材の使用保護、凍結要求、次回Alarmを同じtransactionで保存
         → 到来時に条件照合 → 同じtransactionで公開FIFOへ一度だけ投入
         → 既存Alarm executor → 保存・purge → 同じjobのsucceeded
```

### データモデル

- `publication_schedules`: `schedule_id`、単調な`version`、Show／Episode、UTC期限、現在の予約状態、承認版への参照、公開job／request参照。
- 承認履歴: 変更前の内容を上書きせず、版ごとの要求hash、対象base・世代、runtime／config／window、素材receipt、日時解釈を保存する。
- 変更要求履歴: create／reschedule／cancel／reapproveごとのrequest ID、hash、期待version、結果を保持する。
- 索引は`(state, scheduled_at_ms, server_sequence)`。到来順・同時刻順はサーバー側sequenceで固定する。
- 同一Episodeには未投入の有効予約を1つだけ許可する。既存の同対象queued／running jobとも原子的に競合検査する。
- 予約時に公開job IDとrequest IDを確定する。既存staging keyがdraft job IDへ束縛されるため、到来時に別jobを採番しない。
- 凍結要求本文を診断履歴へ重複コピーしない。本文・素材参照と、allowlist診断を分けて保存する。
- 予約・承認履歴・素材に一律の自動有効期限／物理削除を追加しない。

### 予約と公開jobの状態を分離する

| 予約状態 | 意味 |
| --- | --- |
| `scheduled` | 承認済み・未投入。FIFOの順番を占有しない |
| `needs_approval` | Pause／runtime変更等で旧承認を使えない。自動復帰しない |
| `dispatched` | 対応する公開jobをFIFOへ耐久保存済み。公開完了ではない |
| `cancelled` | FIFO投入前の取消を原子的に確定済み |
| `failed` | FIFO投入前の確定的な対象／素材不正。公開jobは未作成 |
| `blocked` | 保存済み予約の破損等、実行判断を安全に続行できない。勝手に要求を再生成しない |

`publication_job.state`は既存の`queued / running / succeeded / failed / blocked`をそのまま返す。予約が`dispatched`でもjobが`blocked`なら公開成功ではない。

### 原子的な投入と競合

- 予約承認・変更・取消は期待version付き。重複request IDは同じhashなら同じ結果、異なるhashなら拒否する。
- 到来時は公開job保存、Feed世代予約、操作記録、予約の`dispatched`化、次回起動を同じShow DO transactionに入れる。通常HTTP submitを自己呼び出ししない。
- 取消と投入は同じtransaction境界で競合させる。取消が先ならjobは作られず、投入が先なら取消は拒否する。
- **初版の取消期限は「実行開始前」ではなく「FIFO投入前」。** 既存queued jobを取り消す機能は追加しない。
- SQLite内の未投入→投入遷移だけを再確認でき、外部公開IOが始まったjobは既存方針どおり再実行しない。
- CLIはmutation送信前に要求をprivate journalへfsyncする。応答不明は同じrequest／scheduleのGET照合だけを行い、404や経過時間で再POSTしない。

### 素材・draftの保護

- 予約中は同じdraftの再upload・即時publish・upload取消・staging cleanupを拒否する。CLIだけでなくサーバーで原子的に守る。
- `hasPublication()`相当の判定を、予約と保存済みjobの参照・保護まで含めて見直す。別途の非原子的な予約marker確認にはしない。
- 取消済みでjobがなく、他の有効参照もないことを確定できた素材だけ、既存の明示cleanup候補へ戻せる。取消自体では削除しない。
- 内容変更は、未投入予約の取消→編集・再stage→新しい予約の承認とする。旧予約／要求は保持し、暗黙に差し替えない。
- 同内容の再承認は、旧承認を失効させた履歴と「未投入」を同じtransactionで確認して新しい承認版を作る。旧公開要求を書き換えない。

## 6. Alarm調停と通常FIFO

Cloudflareでは1 DOにつきAlarmは1つ。`setAlarm()`は既存予定を上書きし、実行中の`getAlarm()`は後続予定がなければ`null`を返す。この条件を前提にする。

1. Show内の起動計画を共通helperへ集約し、runtime setup／domain保守／実行可能な公開FIFO／最も近い有効予約の最早期限を選ぶ。
2. 未来のAlarmがあっても、即時公開jobを受け付けたら即時へ前倒しする。未来予約の追加で既存の即時起動を後ろへ動かさない。
3. setup・保守の優先度、既存running／blockedの保全を維持する。未来予約だけを理由に公開処理をsleepさせない。
4. 到来予約を期限・server sequence順に、上限付きbatchでFIFO末尾へ投入する。既存queued jobを追い越さない。
5. 公開処理は既存どおり1 invocationにつき1 job。到来予約の残件と通常jobから次回を耐久予約し、大量到来で全件を一度に処理しない。
6. 完了・確定失敗・予約変更／取消・Pause・保守遷移でも再計算する。Alarm設定失敗時は関連する受付／完了transactionをrollbackする。
7. 実行できない期限超過予約で即時Alarmを回し続けない。停止理由を確定し、再承認待ち等の非実行状態へ移す。
8. 再起動・再配送で公開runningが残れば既存の`execution_interrupted`扱いを維持する。予約機能をそのjobの再送・blocked解除に使わない。

長い将来待機は保存済みAlarmに任せ、CLIのpollや`setTimeout`を使わない。コンストラクターから無条件にAlarmを上書きしない。

## 7. 停止条件・遅延・保守の扱い

### 停止後の方針比較

| 案 | メリット | デメリット |
| --- | --- | --- |
| **A: 旧承認を停止し、明示再承認を要求（推奨）** | 古いwindow／runtime／内容を自動採用しない。Resumeが予約の追いかけ公開にならない | 一時Pauseやcode-only更新の後も再承認が必要 |
| B: 条件復帰後に自動実行 | 管理作業が少なく、遅延公開しやすい | 新window／runtimeへまたがる承認と遅延許容範囲を新たに定義する必要。意図しない一斉公開の危険がある |

推奨案Aの具体的な扱い:

| 条件 | 扱い |
| --- | --- |
| サーバー遅延／同一Showの通常job待ち | 同じ承認・runtime・window・baseが有効なら、予定より遅れて実行。最長遅延は保証しない |
| Showがpaused | 未投入予約を`needs_approval`にする。暗黙Resumeしない。既にFIFO投入済みjobのdrainは現行契約を維持 |
| Resumeでwindow変更 | 旧承認を新windowへ自動付け替えしない。Resumeだけでは再予約しない |
| Showがunpublished／lifecycle世代変更 | 未投入予約を停止。復元しても自動実行しない |
| Worker／domain保守 | 原子的な保守準備で未投入予約を停止。予約が何か月先でもdrainを待たせない。既投入job／blockedは従来どおり保守を妨げる |
| runtime／config変更 | 旧承認を停止し、現在の正確な条件で再preview・再承認する。未知配備・別namespaceを採用しない |
| Show metadata／対象Episodeのbase変更 | staleとして停止。最新baseへ自動rebaseしない。無関係な別Episodeの公開だけでは止めない |
| 素材のidentity不一致 | 公開書込前なら確定失敗。読取障害等で検証できない場合は停止理由を残し、公開しない |
| Show FIFOがblocked | 新たに投入・実行しない。予約を再承認してもblockedを解除できない |
| 公開書込／purge後の失敗・不明結果 | 同じjobを`blocked`で保全。別jobへ差し替えず、他Showの予約は独立して扱う |

- 未投入予約は公開queueの`queued`数へ含めない。healthには予約数・再承認待ち数・次回期限を別表示する。
- `drained`は公開jobの状態を表すままとし、保守prepare時の予約失効も同じShow内で原子的に行う。
- domain変更後も旧承認の履歴を読めるstatus契約を設ける。現在の観測runtimeと承認時runtimeを分け、読取可能であることを再実行許可にしない。
- 再承認時点で予定時刻が過去なら新しい未来日時を指定する。即時公開は別途明示操作とする。
- 通常の遅延は自動継続するが、Pause等の安全条件変更は自動継続しない、という違いをhelpに明記する。

## 8. CLI・APIの利用像

コマンド名・pathは提案。既存の`--workspace`、`--show`、`--non-interactive`、JSON外枠に合わせる。

```sh
castloop preview-episode-schedule first --workspace /path/to/service --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-episode first --workspace /path/to/service --show daily \
  --at 2026-11-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH

castloop schedule-list --workspace /path/to/service --show daily --json
castloop schedule-status SCHEDULE_UUID --workspace /path/to/service --show daily --json

castloop schedule-reschedule SCHEDULE_UUID --workspace /path/to/service --show daily \
  --at 2026-11-02T09:00:00 --timezone Asia/Tokyo --expect-version 1 --expect-preview REVIEWED_HASH
castloop schedule-cancel SCHEDULE_UUID --workspace /path/to/service --show daily \
  --expect-version 2 --expect-preview REVIEWED_HASH
castloop schedule-reapprove SCHEDULE_UUID --workspace /path/to/service --show daily \
  --expect-version 3 --expect-preview REVIEWED_HASH
```

- `schedule-episode`はstage済み素材だけを使う。create／uploadを暗黙に行わない。
- previewは読取専用。変更・取消・再承認も対応するpreviewを提供し、操作種別・期待version・内容・日時・停止条件をhashへ束縛する。
- 対話時は対象・metadata要約・素材hash・`published_at`・予定現地日時／UTC・設定元を表示して確認する。非対話時はレビュー済みhashを必須とする。
- 予約受付後は長期間pollせず、`scheduled`とschedule IDを返してCLIを終了する。
- listはShow指定のkeyset pagination。初版は既存一覧に合わせ20件／pageで、全Show横断索引は追加しない。
- 詳細／JSONは予約状態・承認版・停止理由・予定時刻・FIFO投入時刻・実行開始／完了時刻・遅延時間・公開jobの状態を分ける。
- 期限超過はGET時にも計算表示できるようにし、遅延の検出をAlarm内ログだけへ依存させない。
- 管理APIはShow DOへrouteする`/admin/sqlite-schedules/...`を想定。認証、Show header、bounded input、no-store、strict responseを維持する。
- 通知連携用に固定event名・schedule ID・承認版・job ID・reason code・時刻を保存／出力する。メール・Webhook配信や秘密の設定は本Issueの初版に含めない。

### 未来の`published_at`で即時公開する場合

独立した先行改善として、`publish-episode`で未来の`published_at`を使うときは「これは予約ではなく今すぐ公開する」と表示する。実装済み。

- 対話時は追加確認、非対話時は専用flag（`--allow-future-published-at`）による明示承認を必要とする。
- 通常の`--yes`や予約用hashをこの確認の代用にしない。`preview-episode`の`warnings`にも`future_published_at`を含める。
- 初回送信前だけ確認し、既に凍結した要求のstatus読取を妨げない。
- `publish-rss-import`でもfuture日時を検出し、同じflagがなければ送信前に拒否する。

## 9. 開発の段階

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| P0: 選択・詳細契約 | 本書の選択肢を確定。日時変換依存、状態遷移、DDL、preview／API／journalのサイズとidentityを定義 | 管理者レビュー完了。採用案・対象外が明確 |
| P1: 日時・先行警告 | 任意管理設定、日時解決、DST検証、現地／UTC表示、未来`published_at`の即時公開確認 | 単体テストと正式CLIで未指定UTC・明示zone・警告を確認 |
| P2: 予約永続化 | shared schema、予約／承認／要求履歴、version付きCRUD、素材参照保護、private journal | transaction rollback、重複、競合、応答喪失で予約や素材を失わない |
| P3: Alarm・FIFO統合 | 共通起動調停、到来時の原子的投入、既存executor接続 | 未来予約が通常jobを止めず、再配送でも同じ予約からjobが増えない |
| P4: 運用統合 | Pause／Resume、lifecycle、runtime／domain保守、再承認、status／JSON／観測 | 暗黙再開なし。保守のprepare／releaseと予約が矛盾しない |
| P5: 配布・文書・回帰 | CLI help／schema／管理者Skill、利用ガイド、設計・能力識別、全体回帰、単体binary確認 | 下記受け入れ条件と未確認範囲を記録 |
| P6: 任意の実機検証 | 別途承認されたfresh隔離環境だけで、端末不在・Alarm再起動・配信gateを確認 | native確認結果と欠測・未試験範囲を分けて報告 |

### 主な変更先

- shared: `packages/shared/src/sqlite-schedule.ts`等を新設。公開要求・サービスAPIの能力識別と運用reasonを必要範囲で更新。
- Worker: `src/sqlite-publication-schedules.ts`、共通起動調停helper、専用HTTPを新設し、queue／Alarm／Show service／operation records／保守処理へ接続。
- CLI: `packages/cli/src/sqlite-schedule*.ts`、管理用設定と日時helper、`index.ts`／`sqlite-commands.ts`／draft journal／preview／help／agent schemaを更新。
- 文書: `README.md`、`design/initial_design.md`、`docs/sqlite_sequential_development.md`、操作回復・domain・agent利用ガイド、同梱管理者Skillを更新。

### 形式と互換性

- サービスschema 2、`sqlite-sequential-v1`、`show-v1`のfresh環境だけを対象とする。共有metadataのschema 1と混同しない。
- 予約表と素材保護等の永続契約が変わるため、現在の内部6/7形式への単なるcode-only追加として扱わない。影響する内部形式番号を進め、予約能力識別（案: `episode_scheduling="show-alarm-v1"`）をCLIの事前検査へ追加する。
- 正確な形式番号はP0でDDL確定後に決める。旧形式の移行・兼用・採用・fallbackは作らない。
- DO／cache class名、binding名、compatibility dateは変更しない。本Issue対応済みの同一形式間で行う将来のcode-only更新は、予約停止・明示再承認を含めてテストする。

## 10. テストと受け入れ条件

| 分野 | 必須ケース |
| --- | --- |
| 日時 | 未指定UTC、管理設定、CLI上書き、offset優先と矛盾拒否、PCの`TZ`に非依存、日付境界、存在しない／二重のDST日時、過去、承認中の時刻到来、設定変更後のUTC不変 |
| 明示承認 | create／update／uploadだけでは予約・公開0件。未来`published_at`の即時公開警告。preview後の内容／日時／version変更拒否 |
| 永続性 | 受付＋Alarm失敗のrollback、同ID同hash／別hash、取消／変更と到来投入の競合、同Episodeの二重予約・即時publish競合 |
| FIFO／Alarm | 遠い未来予約の後でも即時公開が進む。最早予約の前倒し・取消・後ろ倒し、同時刻順、既存backlog優先、batch上限、実行中に追加された予約のwake-up保持 |
| 再起動 | 投入transactionの前後、running保存後、R2書込後、purge後、SQL完了前後で中断。重複Alarmでもjob／副作用が増えず、不明IOはblockedで保全 |
| 素材 | 予約後のupload／cleanup拒否、取消との原子性、receipt／ETag／version／hash不一致、metadata-onlyの音源再PUTなし、300,000,000 bytes制限維持 |
| base／運用 | Show編集、対象Episode更新、unpublish→restoreのABA、Pause／Resumeのwindow変更、保守開始競合、runtime／config変更、再承認、blocked Showと他Showの独立 |
| 配信 | 予定前・公開中・purge待ちで新Feed／新音源を返さない。予約更新では旧Feed／旧音源を維持。成功後のGET／HEAD／Range／304・履歴保持・独自originとredirectのgate |
| CLI／観測 | 端末終了後の予約継続、一覧20件pagination、予約とjobのJSON分離、遅延／停止／failed／blocked、未知POSTのGET照合、任意例外・本文・秘密の診断非出力 |

実装時には`bun test`、`npm run check`、Linux単体CLI build、正式entrypoint walkthroughを行う。新しいlint／formatterは導入しない。

ローカルfixtureは実DOのAlarm配送、output gate、実Cache purge、精密な時刻保証の実証ではない。指定時刻は最早実行時刻であり、その瞬間の公開完了・最大遅延・障害後の必達を保証しない。Alarm retry枯渇や永続書込障害も無視せず、期限超過／起動予定不整合をstatusで可視化し、未知IOを再送する自動復旧は追加しない。

初回の文書作成ではコード検査を省略した。承認後のコード変更には上記のテスト・型検査を適用する。

## 11. 管理者レビューによる採用事項

次の4点と4節の日時解決規則を採用する。比較表は採用理由を説明するため残す。

1. **scheduler: 3.1のA** — Show内の予約表＋既存Alarm、到来時にFIFOへ投入。
2. **タイムゾーン: 3.2のC** — 任意の`castloop-admin.toml`＋`--timezone`。両方なければサーバー基準UTC。
3. **日時identity: 3.3のA** — `published_at`と予約実行日時を分離。勝手に同期・変更しない。
4. **停止後: 7節のA** — Pause／保守／runtime等の変更後は明示再承認。単なる通常遅延は、同じ承認条件が有効なら遅れて実行。

併せて、初版は「新規Episode公開と既存Episode更新の単発予約」「日時変更・取消・再承認」「通知連携用の状態・eventまで」を対象とし、繰り返し予約、queued job取消、通知送信、blocked解除、既存環境移行は対象外とする提案。

## 12. 参照

- [現行設計](initial_design.md)、[Show分離契約](do_show_separation_options.md)
- [SQLite公開契約](sqlite_sequential_publication_implementation_plan.md)、[運用ガイド](../docs/sqlite_sequential_development.md)
- [Worker更新の検証続行](sqlite_worker_update_recovery.md)、[操作記録schema](sqlite_operation_records_schema.md)
- [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) — 単一Alarm、上書き、実行中の`getAlarm`、at-least-onceと有限retry。
- [Cloudflare local development: Defaults](https://developers.cloudflare.com/workers/local-development/#defaults) — 本番と一致するUTC runtimeの説明。
- [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)

## 13. 現在の実装範囲

2026-10-24のCLI基盤に続き、2026-10-26に**サーバー側の予約公開本体**を実装した。fresh環境専用の内部queue/content形式は**9/9**（予約表の追加でqueueを8から9へ更新。contentはIssue #70/#71の9のまま）。旧8/9を含む環境の変換・移行・互換配備は提供しない。

### 実装したもの

- Show DO内の`publication_schedules`と変更履歴`publication_schedule_events`。`schedule_id`、単調な`version`、UTC期限、状態、承認hash、凍結した公開要求、素材参照を保存する。
- 状態は`scheduled / needs_approval / dispatched / cancelled / failed / blocked`。公開jobの`queued / running / succeeded / failed / blocked`は別項目`publication_state`で返す。`dispatched`は公開成功ではない。
- 予約作成・一覧・詳細・日時変更・取消・再承認。期待versionとプレビューhashを必須にし、同一対象の未投入予約を1つに限定する。変更・取消はFIFO投入前だけ許可する。
- 到来時に予約を同じShow DOの既存FIFOへ原子的に投入する。予約表だけではFIFO順を占有せず、既存queued jobを追い越さない。1回のAlarmで処理する到来予約は最大10件。
- Pause／受付停止／保守準備では、未投入予約を`needs_approval`へ原子的に移す。Resumeや保守解除だけで自動再開せず、現在のruntime・window・baseで新しい公開要求を凍結して再承認する。
- 実行時のruntime／config／window／Show state version／Episode base／素材identityを再照合する。base変更は`base_conflict`、素材不正は`target_unavailable`としてFIFOへ入れない。Alarm予約失敗はjob・予約状態の更新をrollbackする。
- 予約中のupload、draft編集、即時publish、upload取消・cleanupをサーバー側で拒否する。取消・失敗後も素材を自動削除しない。
- CLI: `preview-episode-schedule`、`schedule-episode`、`preview-show-schedule`、`schedule-show`、`schedule-list`、`schedule-status`、`schedule-reschedule`、`schedule-cancel`、`schedule-reapprove`。`preview-schedule-time`は引き続きオフライン変換専用。
- `schedule-episode`／`schedule-show`は既存のstage済みdraftとアップロード済み素材だけを使い、`--expect-preview`の承認hashが一致しなければ送信しない。予約受付後はCLIを待機させず、`scheduled`とschedule IDを返す。
- 未来の`published_at`と予約実行日時は別identityのまま。予約実行で`published_at`を書き換えない。
- 未来`published_at`の即時公開警告を追加した。`preview-episode`は`warnings[].code=future_published_at`を返す。非対話の`publish-episode`は`--allow-future-published-at`がなければ送信前に拒否し、対話時は`publish now`の入力で確認する。`publish-rss-import`はfuture日時のEpisodeを含む場合に同じflagを要求する。既に凍結したjobのstatus読取は妨げない。

### 未実装・未確認

- 通知送信、blocked解除、繰り返し予約、queued/running jobの取消、既存環境の移行は対象外。
- Alarm再配送・中断、blocked、同時刻予約、複数Showの同時予約、性能・Free枠はCloudflare実機で未確認。

ローカル回帰はBun 1.4.4で`bun test`: **857 pass / 0 fail**（96 files）。`npm run check`とLinux単体CLI buildも成功した。これはBun SQLiteとmemory R2 fixtureによる検証であり、DO runtimeの永続性・native Alarm再配送・実Cache purgeの証明ではない。

fresh隔離環境で3 Episodeを約3分間隔に予約し、各予定前のFeed未配信と予定後の追加、`publication_state=succeeded`、予約時刻+2msのdispatchを確認した。同じ環境で追加確認を行い、Pause→`needs_approval`→Resume→再承認→公開、日時変更→取消、約3時間後の予約を残したまま別Episodeの即時公開、予定前の直リンク404と公開後の200/206・SHA-256一致を確認した。環境・結果・未確認範囲は[実機検証記録](issue65_scheduled_publication_live_20261026.md)に保存した。CLI基盤の実データ検証（指定サンプル3＋36 Episode、約1.50GB、162コマンド）は[別記録](issue65_cli_real_data_verification_20261024.md)に保持する。これは予約本体の実機検証ではない。
