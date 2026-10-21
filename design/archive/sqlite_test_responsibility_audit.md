# SQLite単独化後のテスト責務監査（Issue #34）

## 対象と判断基準

2026-10-18、基準commit `a500ba5`（v0.6.0）。[Issue #24の削除結果](../schema_v1_removal_plan.md#9-ローカル実装結果2026-10-18)を前提に、残存テストの責務を監査する。Queue専用テストの削除は完了しており、旧`validated-local-journal.ts`と旧family wrapper、Queue署名用HMAC helperは現行対象ではない。[旧共通化記録](v050_redundancy_refactor.md)は意図的に分けた契約の参考資料として扱う。

同じ失敗入力でも、primitiveの拒否、clientへの接続、journal保全、公開副作用の抑止は別責務とする。同じ条件・同じ責務の反復だけを統合し、固有条件を残存テストに対応付けられない候補は採用しない。新しいテストフレームワーク・汎用fixture・production実装の変更は行わない。

## 採用する整理と残存テストの対応

| 変更前の候補 | 同じ条件・責務を検証する残存テスト | 固有条件・境界の保持 |
| --- | --- | --- |
| `sqlite-draft.test.ts`末尾の管理応答異常系4件が、設定しか使わないのにSQLite・素材・draft journalを準備 | `sqlite-management-clients.test.ts`のpublication capability応答試験へ4件を移設。固定configと専用transportだけで`describe()`を呼ぶ | 不正JSON、16,385 bytes、no-store欠落、HTTP 206をそのまま維持。拒否と秘密非出力に加え、GET先・管理鍵・request回数を明示。低層HTTP試験へ置換せずclient接続の検証を残す |
| `local-journal-path.test.ts`の10 family × 同じ3種の障害試験 | `sqlite-uploads`（service階層）と`rss-import-downloads`（flat）の各3試験。familyごとの差は全10 familyの独立した期待値表による保存先・初期化・読取・排他置換試験で保持 | symlinkはroot/state/familyとservice階層を網羅。dangling lock、parent差替え、別owner lockの非削除は両構造で維持。全familyのservice ID要否・不正identity拒否も検証。family表は実装からimportしない |
| `workspace-config.test.ts`の旧設定3形状 × CLI入力14種（42子process） | 通常の旧設定は全14入力を維持。最小設定・任意項目付き設定は各`init`／`service-status`／`publish-rss-import`を維持（計20子process）。reader単体試験では全3形状を維持 | `index.ts`の既存workspace init、通常dispatch、RSS公開の3入口を各形状で確認。protocol明示init、保持入力変更、deploy alias等は通常設定で維持。全ケースでfetch/build禁止、config・保持journal・directory不変、v0.5.x案内を検証 |

`local-journal-path.ts`のfamily依存処理はallowlistとflat/service構造選択であり、parent検査・lock所有確認は共通。CLIの設定拒否は`loadWorkspaceConfig()`が担当し、各入口がその後に実行runnerへ進む。この実装上の境界を根拠に組み合わせを縮小する。family固有のdomain処理やCLI入口の削除はしない。

## 残す試験と理由

| 試験群 | 異なる検証責務 |
| --- | --- |
| local journal storage/readとSQLite draft/init/update/RSS等の統合試験 | private mode、原子的置換、reader上限、lock管理と、凍結要求・receipt・phase遷移・復旧境界は別。domain側を汎用storage試験で代替しない |
| `bounded-http-read.test.ts`、`sqlite-management-http.test.ts`、`trial-read.test.ts`、management client試験 | byte収集とreader解放、caller別envelope/retry/期限/cancel/診断、要求identity照合・POST非再送を分離して検証 |
| `verified-r2-put.test.ts`、`staging-sources.test.ts`、`sqlite-draft.test.ts` | receipt/hash/size/object identity・秘密非出力、EOF/active IO settlement、未検証uploadのjournal保全・submit抑止・非再送をそれぞれ保持 |
| public assets、lifecycle cache、SQLite gateway/purge/executor/Alarm/queue | path許可、Range/HEAD/条件付き応答、最新DOの公開可否・cache世代、purge-before-success、FIFO・原子的受付と未確定IOを分離して検証 |
| `sqlite-rss-publication.test.ts`とexecutorの36件公開 | import GUID/permalink/date・音源・checkpoint続行と、purge throttling・重複media書込防止では故障条件が異なる |
| `sqlite-service-update.test.ts`と`sqlite-update-recovery.test.ts`、Worker runtime更新試験 | 通常更新・native反映待機と、PUT成功checkpoint・未知配備・旧SQLite journal・namespace/ETag照合、server側の原子的activationは別責務 |
| shared/CLI hash、admin auth、metadata/feed試験 | 独立hash/HMAC・既知値oracle、native認証、schema検証とschema迂回時のXML描画拒否を維持。期待値をproduction helperへ統一しない |
| `worker-tail.test.ts`とsource completion回帰・正式CLI子process試験 | #29/#30はclosedだが回帰は現行SQLiteにも必要。heartbeat state machineとnative socket、EOF境界と実HTTP経由の接続は別責務。削除・skip・timeout延長をしない |

Issue #29の元CI障害の原因を確定したとは扱わない。本監査はcoverage計測や全故障条件の網羅性証明ではなく、採用候補の責務対応と、重点箇所を残す判断の記録である。

## 検証・測定

変更前後を同じLinux x86_64 checkout（kernel 6.8.0-147-generic、glibc 2.39）、Bun 1.4.2（744846f84）、Node v24.22.0、同じlockfileの`npm ci`後に測定した。対象4ファイル（draft、management clients、journal path、workspace config）を3回、その後`bun test`を3回、最後に`npm run check`を実行した。各processは直列起動、stdout/stderrはファイルへ保存し、Python `time.perf_counter()`によるprocess wall秒を比較した。warm-up専用runは設けず、全3値と中央値を記録する。変更後の測定前には、別途対象試験と型検査の疎通確認を1回実施した。

対象試験のコマンド：

```sh
bun test packages/cli/src/sqlite-draft.test.ts packages/cli/src/sqlite-management-clients.test.ts packages/cli/src/local-journal-path.test.ts packages/cli/src/workspace-config.test.ts
```

| 範囲 | 変更前のwall秒（3回） | 変更後のwall秒（3回） | 中央値 前 → 後 |
| --- | --- | --- | --- |
| 対象4ファイル | 7.900 / 7.747 / 7.480 | 4.932 / 5.310 / 5.193 | 7.747 → 5.193 |
| 全体 `bun test` | 33.954 / 34.036 / 33.766 | 31.064 / 31.283 / 30.251 | 33.954 → 31.064 |

- 対象試験：変更前75 pass、変更後52 pass。各3回とも0 fail。
- 全体試験：変更前439 pass、変更後416 pass。各3回とも0 fail、56ファイルを維持。
- 差分23件はjournal pathの30件を、構造別6件＋全family対応1件へ整理したもの。既存のread-only/不正identity試験も維持した。管理応答異常系4件は移設であり削除ではなく、CLIの42 → 20は1テスト内の子process組み合わせ数の差である。
- 全体中央値は2.890秒（約8.5%）短縮したが、局所変更ごとの時間寄与は分離測定していない。共有環境の負荷・filesystem/cacheの影響は排除しておらず、性能保証やCI時間の見積りには使わない。
- `npm run check`は変更前後とも成功。`git diff --check`も成功。production実装・lockfile・依存version・試験timeout・skipは変更していない。
- Issue #34の対象説明を更新した。このローカル検証の記録時点では、commit/push・PR・merge・Issue closeは未実施。取り込み状況はIssueと対応PRを参照する。

測定用runnerは`/tmp/opencode/issue34-measure.py`。生ログと環境情報を含むJSONは`/tmp/opencode/issue34-before-7tvp23hf/`と`/tmp/opencode/issue34-after-u2_7ld_h/`に保存した。一時領域の保持は保証しないため、判断に必要な測定条件・全wall値・集計は本書に記録した。生ログはGitへ追加しない。

ローカル時間はCloudflare native性能、Free適合や永続的なCI安定性を保証しない。Cloudflareへの配備・公開・資源操作、保持環境／原本／journal／private証跡の変更・削除は行っていない。
