# コード全体レビュー（2026-10-21）

## 1. 結論

**最優先は、公開後のデータ量を検査していないため、正常な公開を契機にShowの後続処理が停止する問題（R1）の修正。** 認証回避や未公開素材の取得につながる脆弱性は今回の調査では確認しなかった。ただし、これは安全性の保証や侵入試験の完了を意味しない。

既存の549テストと型チェックは成功したが、公開容量の境界、RSSの編集後入力、現行のエラー診断にはテストで拾えていない問題があった。実装・既存テスト・Cloudflare環境は変更していない。本書と文書索引のみを変更した。

### 指摘一覧

「再現済み」はローカルの合成入力・SQLite・模擬transportによる確認。「改善候補」はコード上の構造に基づく提案で、実機性能や攻撃成立を実証したものではない。

| ID | 優先度 | 分類 | 内容 | 根拠の強さ |
| --- | --- | --- | --- | --- |
| R1 | 高 | 可用性・上限管理 | 容量境界を超える公開が成功し、次の操作がblockedになる | 再現済み |
| R2 | 中 | 入力検証・無駄な副作用 | RSS公開の事前検証が編集後メタデータの項目別上限を確認しない | 再現済み |
| R3 | 中 | 記録増加・処理停止 | upload記録数の上限に永続lockファイルまで数える | 再現済み・コード確認 |
| R4 | 中 | 試験・監視の信頼性 | 観測ヘルパーが現行管理APIの失敗を正常扱いする | 再現済み |
| R5 | 中 | セキュリティ運用文書 | SECURITY.mdの緊急停止コマンドが廃止済み | 文書・CLI照合 |
| R6 | 低 | 状態表示 | list-showsが常にサービスをpausedと表示する | 再現済み |
| R7 | 低 | 効率・障害切り分け | ローカル単一操作の照会でも全family・全記録を読む | 再現済み・コード確認 |
| R8 | 低 | 重複・保守性 | 上限付きレスポンス収集処理と素材マージ条件が重複 | 改善候補 |
| R9 | 低 | 効率 | サービス集約照会が全Showへ逐次RPCし、制御側healthも反復生成する | 改善候補 |
| R10 | 低 | サプライチェーン | リリース用GitHub Actionsがcommit SHAに固定されていない | 強化候補 |

優先度は本リポジトリの運用への影響であり、CVSS評価ではない。R1～R3は管理者の正規操作で発生する問題で、未認証の第三者による攻撃経路を確認したという意味ではない。

## 2. 対象・方法・検証結果

- 対象commit: `2b82614cc736ee3121de3b36778055ec2ffb92af`、package version: `0.7.0`。
- 対象: `src/`、`packages/cli/src/`、`packages/shared/src/`、`scripts/`、関連設定・CI・現行設計文書。
- TypeScriptは製品・build用83ファイル、テスト63ファイル、`test-support`の補助11ファイルを対象に構造・責務を調査。境界処理と状態遷移を重点精査した。すべてのテストに対するmutation testingや、全分岐の網羅証明ではない。
- CodeGraphによる呼び出し関係の調査、ソース確認、既存テスト実行、既存コンパイラによる未使用宣言の追加確認、合成入力での再現を実施。
- `dist/`、依存ライブラリ本体、生成型定義を製品ソースと同じ粒度で監査したわけではない。配布済みバイナリの解析・再ビルドは実施していない。

| 確認 | 結果 |
| --- | --- |
| `bun test` | **549 pass / 0 fail**、63ファイル、8,957 assertions、59.15秒 |
| `npm run check` | 成功 |
| `npm run check -- --noUnusedLocals --noUnusedParameters` | 成功 |
| `npm audit --omit=dev --json` | 登録済み脆弱性0件。開発依存・未登録脆弱性の安全性までは示さない |
| 12行連続・空白正規化によるファイル間の完全一致比較 | 300文字超のブロックでは抽出なし。変数名違い等の論理重複は別途R8で確認 |
| ローカル再現 | R1～R4、R6、R7を確認。実Cloudflareへの要求なし |

テストログと再現スクリプトは `/tmp/opencode/castloop-review-*-20261021.*` に保存した。これらは一時的なローカル証跡であり、恒久的な仕様や実機検証の証拠ではない。再現条件と観測結果は以下に記載する。

### 領域別の確認観点

| 領域 | 主な確認対象 |
| --- | --- |
| Worker入口・管理HTTP | 認証のawait、origin・Show経路、body上限、エラー応答、秘密の扱い |
| SQLite・公開・更新 | 受付/完了のtransaction、FIFO、世代/base照合、未知IO、Alarm、共有更新の途中状態 |
| 公開配信・キャッシュ | 許可path、最新gate、世代別object、header除去、Range/条件付き要求、purge-before-completion |
| CLI・ローカル状態 | 設定拒否の順序、symlink/通常ファイル検査、排他、fsync、凍結要求、PUT receipt/readback |
| RSS・共有schema | SSRF、redirect/DNS固定、DTD/XML、サイズ、GUID/日時、編集後入力、feed全体の上限 |
| テスト・補助・CI | 単体/統合の責務、故障注入、観測の誤判定、重複候補、release権限と依存関係 |

## 3. 優先修正事項

### R1［高］公開後の容量境界を超えた状態を作れてしまう

**箇所**

- `src/sqlite-publication-content.ts:129-136` — `episodes()`の現在値に対する上限。
- `src/sqlite-publication-executor.ts:161-162, 238-240` — 現在の一覧を検査してから新revisionを追加。
- `src/publication-inputs.ts:9-12` — 別の32,000,000 bytes換算によるrender上限。
- `src/sqlite-publication-alarm.ts:57-62` — 通常のErrorを`validation_unavailable / blocked`へ分類。

`episodes()`は現在の公開済みrevision JSONに対し、`SUM(length(revision_json)) * 4 <= 8_000_000`を要求する。一方、新規公開の検証は**追加前**の一覧にこの条件を適用し、追加後には異なるrender予算しか確認しない。このため、次回の`episodes()`が読み出せない状態を正常にcommitできる。

**再現条件・結果**

1. 合成した公開済みShowへ、descriptionが各10,000文字の有効なrevisionを190件配置。JSON合計は1,994,620文字で、`episodes()`は成功した。
2. 同程度のEpisodeを実際のexecutor/Alarm経由で1件追加。結果は`state: succeeded`。
3. 続いてShowのunpublishを同じ経路へ投入。結果は`state: blocked, reason_code: validation_unavailable`、queueは`drained: false`。

既存190件はテストDBへの直接投入で準備し、境界を超える1件と次の操作は製品executorで実行した。191件を実Cloudflareへ連続公開した測定ではない。

**影響**

- 正常な管理操作だけで、対象Showの以後の公開・非公開化が止まる。
- blockedの解放は未提供であり、共有Worker更新のdrain条件にも影響する。
- Showの明示Pauseは別経路だが、既存blockedの復旧にはならない。

**改善案**

- 外部書込前に、追加・置換・復元を反映した**処理後の一覧**へ一貫した予算検査を行う。確定的な入力超過は既存の入力失敗として扱い、未知IOの例外を一括して`failed`へ格下げしない。
- CLIのRSS事前検証とWorkerで同じ予算定義を使う。
- ShowのunpublishはFeedを生成しないため、不要な全Episode読取を避けることも検討する。
- 境界直前・ちょうど・直後、新規追加・metadata更新・復元を回帰テストする。

上限を単に撤去したり、blocked jobを再送・直接修正する提案ではない。

### R2［中］RSS事前検証が編集後メタデータの入力上限を検証しない

**箇所**: `packages/cli/src/rss-import-preflight.ts:29-33, 43-46`、`packages/cli/src/sqlite-rss-publication.ts:52, 69-116`。

元のRSSには`parseRssImportFeed()`経由の項目別検証があるが、管理者が編集したTOMLには保存用の`parseShowMetadata()` / `parseEpisodeDraft()`しか適用していない。保存用schemaが過去snapshotを無制限に読めること自体は正しいが、**新規公開のpreflight**では項目別上限の追加確認が必要。

**再現**: 模擬downloadで作った正常なRSS importのShow/Episodeタイトルを各256文字へ変更。`prepareRssImportPublication()`は両方を含むPrepared結果を返した。同じ値は`assertShowMetadataInputLimits()` / `assertEpisodeDraftInputLimits()`で拒否された。

後段のstage/Workerが拒否するため、不正入力を公開できる認証・検証回避ではない。しかし、その時点までにShowの永久予約・Resume・操作記録・import入力hashの凍結が進む。入力を直すと凍結hashが変わるため、単純な再実行では継続できず、不要な部分状態を残す。

**改善案**: 編集後Showは音源走査前、各Episodeはその音源解析前に項目別上限を確認する。保存・復元用schemaは変更しない。256文字等で拒否したとき、Cloudflare用transport・Show作成・公開journal作成が一度も開始されないことをテストする。

### R3［中］upload記録の件数上限がlockファイルを含む

**箇所**: `packages/cli/src/sqlite-upload.ts:52-65`、`packages/cli/src/local-journal-storage.ts:62-69`、`packages/cli/src/process-journal-lock.ts:4-24`。

`requireNoPendingSqliteUpload()`は、JSONを選別する**前**の`readdirSync()`全件数を10,000と比較する。一方、schema version 2の処理では各JSONに永続的な`.json.lock.sqlite`が作られ、正常終了後も保持される。

したがって、通常の「JSON＋lock」だけでも5,001操作で10,002 entriesとなり、新規stageを拒否する。完了済みuploadも同様に数える。さらに各stageが全upload JSONを読み直すため、蓄積に伴って一回あたりO(M)、連続処理では累積O(M²)の走査になる。

**再現**: 一時workspaceにlock sidecarを多数配置すると、未完了のupload JSONを検査する前に`Inspect retained uploads before adding more local records`で停止した。通常運用の5,001組という境界は、件数判定とlock生成コードから確認した値。

**改善案**

- 操作記録数とdirectoryの物理entries数を分ける。lock/tempにも防御予算が必要なら、別の上限・診断とする。
- 対象draft/jobのpending記録へ絞る探索方法を検討する。検索用情報を追加しても、再開可否は元journalとサーバーの最新状態で照合する。
- 大量の完了記録＋lockがあっても、少数の未完了記録を正しく見つける試験を追加する。

lock削除や既存journalの自動期限切れで回避してはならない。

### R4［中］現行管理APIの失敗を観測ヘルパーが正常扱いする

**箇所**: `scripts/test-support/sqlite-observability.ts:5-15, 98-105, 127-138`。

診断allowlistには`sqlite_service_http`等がある一方、現行Workerの`sqlite_service_control`（`src/sqlite-control-http.ts:30-32`）や`sqlite_operation_http`（`src/sqlite-operation-http.ts:47-49`）が含まれない。未認識ログは件数だけになり、classifierは`outcome === "ok"`ならHTTP status 409でも`ok`を返す。

**再現**: `outcome: "ok"`、HTTP 409、上記いずれかのエラーeventを持つ合成frameを渡すと、両方とも`unrecognized_logs: 1, classification: "ok"`となった。`SqliteObservationGuard`もこの分類だけでは失敗状態へ遷移しない。

**影響**: 製品の認証・公開gateの回避ではないが、試験中の停止判断や測定の信頼性を損なう。既存の実機結果すべてが誤りだったと断定できる証拠ではない。

**改善案**: 現行event/reasonのallowlistを追随させ、管理要求の失敗statusとruntimeの`ok`を区別する。期待した404等を許す場合も、正確な照会文脈に限定する。未知ログの原文を保存するのではなく、安全な件数・固定コードを維持する。409/503、未知event、既知の正常イベントを組み合わせた試験を追加する。

### R5［中］SECURITY.mdの緊急停止手順が実行不能

**箇所**: `SECURITY.md:38`、`packages/cli/src/help.ts:82-98`、`packages/cli/src/help.test.ts:35-56`。

セキュリティポリシーは不正利用を疑う際に`castloop service-pause`を案内しているが、このコマンドは廃止済みで、CLIの拒否テストもある。現行は`show-pause SHOW_ID PAUSE_UUID`で、サービス全体のPauseは存在しない。

**影響・改善案**: インシデント時の封じ込めを遅らせる。Show単位で対象を確認し明示Pauseする手順と、停止は侵害された資格情報の失効・未知IOのsettlementを意味しないことを記載する。旧layoutへ新CLIを使わせるような一般的な「最新版へupgrade」の記述も、現行の移行非対応方針と整合させる。文書内の運用コマンドが実在することを小さな回帰チェックで確認する。

## 4. 状態表示・効率・重複の改善

### R6［低］list-showsが常にpausedを返す

**箇所**: `src/sqlite-service-control.ts:122-124`、`packages/cli/src/sqlite-catalog.ts:4-5`。

制御DOのcatalog応答が`state: "paused"`を固定で返し、formatterがそのまま`Service: ... (paused)`と表示する。模擬サービスでShowをResumeしたところ、`service-status.state`は`open`、`list-shows.state`は`paused`だった。

安全な更新可否は別途サーバーが検証するため、これだけで更新ロックを回避できるわけではない。それでも管理者には停止済みと誤解させる。全体Pauseがない現行仕様に合わせて一覧の表示・応答契約を整理し、単に表示のために全Showへ追加fan-outしないことを推奨する。

### R7［低］単一のローカル操作照会が無関係な全journalへ依存する

**箇所**: `packages/cli/src/sqlite-operation-commands.ts:29-60`。

`operation-status upload ID --local`でも、全familyの全JSONを読み・parseし、最後に対象をfilterする。不要なIOだけでなく、無関係な壊れたdraft記録や他familyの件数上限が、調べたいuploadの診断まで妨げる。

再現では、uploadの単一status照会が、別familyの不正な`target.job_id`のparseエラーで停止した。対象を一覧探索する必要があるfamilyと、IDからファイルを直接指定できるfamilyを分ける。複数候補を持つ場合も対象familyへ絞り、読取専用・破損記録の保全は維持する。

### R8［低］論理的な重複を限定的に整理できる

**候補A: 上限付きレスポンス収集**

- `packages/cli/src/sqlite-cloudflare.ts:37-45`
- `packages/cli/src/verified-r2-put.ts:10-36`
- 共通化済みの比較対象: `packages/cli/src/bounded-http-read.ts:14-40`

reader取得、累積サイズ確認、chunk保持、結合、cancel/releaseの骨格が重複している。CLI内の既存collectorへ低レベルのbyte収集を寄せ、receiptの同一性、UTF-8/JSON、HTTP status、固定の診断への変換は呼び出し側に残す余地がある。

ただし、stream完了後のcancelと中断時のcancelには既存テスト上の意味があり、機械的に同一化しない。音源の全量readbackはhash計算用streamであり、byte配列へbufferする共通helperへ置き換えない。WorkerからCLI helperをimportする依存逆転も避ける。

**候補B: draft素材の置換条件**

`packages/cli/src/sqlite-draft.ts:112-114, 128-129, 136-138`には、同一assetまたはjpg/png coverを相互置換する条件が繰り返されている。純粋な小関数へまとめれば条件の更新漏れを減らせる。一方、base照合・再開時の所有確認は責務が異なるためまとめない。

今回、大規模な完全コピペ群や、削除してよいと判断できる製品側の未使用宣言は確認しなかった。過剰な汎用framework化は不要。

### R9［低］サービス集約照会の逐次RPCとhealth再生成

**箇所**: `src/sqlite-service-control.ts:60-64, 83-93, 107-120`。

`health()`は全Showへ逐次RPCするので、応答時間は概ね各Showの待ち時間の和になる。`verifyHealth()`も各回で制御側`runtime.health()`を複数回生成し、SQL snapshot・update要約・invocation UUIDを再取得する。catalogもページ内で逐次RPCする。

実機の遅延・CPUは未測定。少数Showで問題になると断定はしない。読取専用照会に限って、固定の小さい並列数と全開始済みIOのsettlementを守る実装を検討し、不変のservice/config/version identityは一回取得した値を使う。Showの失敗を不存在として落とさない。通常配信の最新gateをTTL cacheしたり、共有更新のprepare/activate/releaseを同じ要領で並列化する提案ではない。

### R10［低・強化候補］リリース用Actionsの不変参照

**箇所**: `.github/workflows/build-binaries.yml:19-25, 45, 59-60, 117-118`。

`actions/checkout@v4`等と`oven-sh/setup-bun@v2`が可変tag参照である。release jobは成果物を公開する`contents: write`権限を持つため、第三者Actionをレビュー済みの完全commit SHAへ固定すると、tag差し替えに対する供給網リスクを下げられる。

攻撃や侵害を確認した指摘ではない。現行workflowの既定read-only権限と、release jobに限定したwrite権限は適切。SHA更新の保守方法とセットで検討し、依存の自動更新・権限追加を今回勝手に導入しない。

## 5. セキュリティ上、維持すべき実装

以下は確認した防御であり、R1等の改善時にも削らない。

- **管理認証**: `src/admin-auth.ts:1-20`は固定長SHA-256とnative比較/標準Web Crypto検証を用い、暗号処理失敗時は拒否する。管理HTTPは認証をawaitする。
- **公開境界**: `src/sqlite-gateway.ts:10-28`と`src/sqlite-publication-content.ts:241-277`が許可path、最新のShow状態、承認済み音源、世代を検査する。認証header/cookie/queryをcache ownerへ転送しない。
- **SQL**: 値はbindingへ渡し、可変のSQL断片は固定の分岐・内部column定義に限定されている。確認範囲では利用者の任意SQL文字列の連結は見つからなかった。
- **SSRF**: `packages/cli/src/rss-import-download.ts:25-105`でpublic IP判定、全DNS結果の検証、接続先の固定、redirectごとの再検証、HTTPS downgrade拒否がある。
- **XML**: `packages/cli/src/rss-import-feed.ts:17-45`でDTD拒否・構造/byte上限があり、`src/feed.ts:5-9`でXML文字検査とescapeを行う。
- **ローカル状態**: bounded read、最終要素の`O_NOFOLLOW`、通常ファイル・変更検出、private modeでの新規作成、fsync、排他、要求前checkpointを確認した。これをファイルシステム全体に対するTOCTOU耐性の証明とはしない。
- **音源と未知IO**: 300,000,000 bytes上限、凍結source、EOF、全量hash/readback、object identityの検証を保持している。音源はWorkerでもstreamとして扱い、未知PUT/POSTを自動再送しない。
- **公開完了**: immutable payload、purge、SQLite確定の順序と、`failed`/`blocked`の区別を維持する。世代別feed/coverと小さい配信判定は合理的である。
- **秘密・診断**: 本番secretはbinding/local stateを使い、製品の運用診断は固定コード中心。fixture中の`private-token`等は実credentialの発見ではない。

依存脆弱性0件、静的確認、ローカルテストのいずれも、Cloudflare nativeの安全性・性能・永久的なFree適合の保証にはならない。U1の未検証性も本レビューで解消していない。

## 6. テストコードの評価

### 削除すべき不要テストは今回確定しなかった

テストの多さや見た目の類似だけを削除根拠にしない。

| 似て見える試験 | 保持する理由 |
| --- | --- |
| shared/CLIのSHA-256試験 | 既知vectorと、awaitを入れないjournal用同期実装との一致を別々に確認する |
| publication queue/alarm/executor/integration | transaction・再配送・副作用順序・CLIとの接続という異なる責務がある |
| 正式CLI entrypointと模擬サービス統合 | argv/cwd/preload/終了codeを含む実入口と、関数単位の故障注入は代替関係ではない |
| schema 1/旧layout/廃止コマンドの拒否 | 旧版の動作互換ではなく、副作用前の拒否という現行の安全契約 |
| source EOF、lock強制終了、purge障害、blocked継続配信 | 低頻度でもデータ・公開境界を壊す故障の回帰を守る |
| source-modeと配布バイナリのhelp smoke | build時の埋込・配布物の不具合はsource-modeだけでは検出できない |

テストコードには`test/it/describe.skip/only/todo(...)`の指定を確認しなかった。近似fixtureや失敗ケースは、共通化しても入力と期待される安全条件を各ケースから読み取れる形にとどめる。

### 増やす価値がある試験

1. R1: 正常commitの後も次の操作が実行可能であるという容量境界の連続試験。
2. R2: 編集後TOMLの項目別上限と、拒否までremote IOを始めない試験。
3. R3/R7: 大量の完了記録・lock、無関係な破損記録と、単一対象の診断。
4. R4: 現行Workerが出す固定エラーeventとHTTP statusに対する観測classifierの試験。
5. R6: Showがopen/paused/混在のときのcatalog表示契約。

既存のBun SQLite/模擬R2テストは有効だが、native DOのoutput gate、Alarm再配送、cache purge、300MB経路の実機特性を証明しない。新たなテストframework導入や実環境の再試験は本レビューでは行っていない。

## 7. 推奨する対応順

1. **R1と回帰テスト**。処理後容量の検査を外部書込前へ置き、既存の未知IO保全を崩さない。
2. **R2・R4・R5**。不要な部分状態、試験の誤判定、誤った緊急手順を先に解消する。
3. **R3・R6・R7**。記録蓄積時の停止と管理診断・表示を改善する。
4. **R8～R10**。実測と差分の小さい共通化・強化を個別に検討する。

修正時も、保存形式の無断変更、旧layoutの移行追加、journal/lockや世代snapshotの削除、blocked解放、未知IOの再送を行わない。実Cloudflareの配備・公開・資源変更は、別途対象と範囲の明示承認を要する。

## 参照

- [現行構成](../initial_design.md)、[Show分離契約](../do_show_separation_options.md)
- [項目別入力上限](../show_episode_input_limits.md)、[SQLite実装契約](sqlite_sequential_publication_implementation_plan.md)
- [管理認証](../admin_authentication.md)、[セキュリティポリシー](../../SECURITY.md)
- Cloudflare公式: [streaming](https://developers.cloudflare.com/workers/runtime-apis/streams/)、[Workers Caching](https://developers.cloudflare.com/workers/cache/)、[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。現行ドキュメントを参照し、cache keyのprops/version分離とstreaming方針を確認した。
