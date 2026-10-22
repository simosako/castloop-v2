# コード全体レビューへの対応（2026-10-22）

[レビュー](code_review_20261021.md)の推奨順に修正を作成し、指摘ごとのcommitと5件の依存PRに分けた。**提出済みであり、マージ・リリース・Cloudflareへの配備は行っていない。** レビュー本文は調査時点の記録として保持する。

## PRと修正範囲

| 順 | PR / branch | 対応 | commit |
| --- | --- | --- | --- |
| 1 | [#54](https://github.com/simosako/castloop-v2/pull/54) / `fix/review-publication-budget` | レビュー保存、R1: 処理後inventoryの容量検査・shared予算定義・Show非公開化の不要読取除去 | `4df64e7`, `83e69de` |
| 2 | [#55](https://github.com/simosako/castloop-v2/pull/55) / `fix/review-preflight-observability` | R2: 編集後RSS入力検証、R4: 現行エラーevent/status・未知ログの停止判定、R5: 緊急手順の修正 | `bc25dbb`, `fc00a49`, `34358a6` |
| 3 | [#56](https://github.com/simosako/castloop-v2/pull/56) / `fix/review-local-status-catalog` | R3: JSON件数とlock等の物理件数を分離、R6: catalogの架空paused表示を除去、R7: 単一ローカル照会を限定 | `d502089`, `d94b5c9`, `6297216` |
| 4 | [#57](https://github.com/simosako/castloop-v2/pull/57) / `refactor/review-bounded-reads` | R8: bounded collectorとasset slot判定の共通化、R9: 読取専用Show RPCの最大4件batchとhealth再生成削減 | `ece768b`, `bf70c98` |
| 5 | [#58](https://github.com/simosako/castloop-v2/pull/58) / `ci/review-pin-release-actions` | R10: 既存majorの公式Actionを完全SHAへ固定、更新方針・形式回帰テスト | `e7046ce` |

baseは`main → #54のbranch → #55のbranch → #56のbranch → #57のbranch`。上から順にレビュー・取り込みを行う。親PRをmergeしたら後続のbase/diffを確認し、squash等を使う場合は依存commitの整理も確認する。後続PRはbaseがmainでないため、現行workflowの`pull_request.branches: main`では自動CIが開始されない場合がある。ローカル検証とGitHub CIの結果を混同しない。

## 回帰テスト・検証

- 全体: `bun test` **571 pass / 0 fail**、66ファイル、9,464 assertions。
- 型・未使用宣言: `npm run check -- --noUnusedLocals --noUnusedParameters`成功。
- `git diff --check`成功。
- production Workerをbrowser bundle化し、それだけを埋め込むLinux x86-64単体CLIをビルド。version/helpと全command helpの**35件**が成功。`scripts/build-cli.ts`と同じbundle/compile設定を一時スクリプトで使い、既存`dist/`を上書きせず`/tmp/opencode/`の新規directoryへ出力した。
- R1: 追加・metadata更新・復元の処理後容量超過を、公開PUT/purgeなしの`failed`で拒否し、後続Show非公開化の成功を確認。shared予算の直前・一致・超過とUnicode文字数も確認。
- R2: 編集後の256文字titleを音源検査より前に拒否し、remote IO・公開journal・Show登録が0件であることを確認。
- R3/R7: 5,001完了JSON＋永続lockの保全、未完了upload検出、対象外の破損を読まない単一照会、対象破損時のエラーを確認。
- R4/R6: HTTP 409/503・未知event・正常operationログ、Showのopen/混在/pausedでのcatalog契約を確認。
- R8/R9: receipt上限超過・cleanup失敗/待機・reader解放、JPEG/PNG相互置換、最大4件の並列数・順序・失敗時の全開始済みIO settlementを確認。共有更新の既存回帰も成功。
- R10: 公式upstreamのgit ref/tagとcommitの対応を読取確認。SHA形式テストはprovenanceや全Action依存の完全監査ではない。

ログ: `/tmp/opencode/castloop-review-fixes-{full-test,check,build}-20261022.log`。一時的なローカル証跡であり、native性能・永続性の証明ではない。

## 残る制限と維持した境界

- **R3の反復走査コストは残る。** lock誤算入による早期停止を修正したが、stage前のupload検査は既存journalを読むO(M)のまま。永続検索indexや別の正本を追加せず、保持履歴の自動削除もしない。
- draft・show-registration・cleanupの単一ローカル照会はファイル名が操作IDではないため、対象family内の走査を維持する。4つのID指定可能familyだけ直接読取とした。
- `list-shows.state = null`は未集約を意味し、サービス停止・更新許可を意味しない。全体集約は`service-status`、個別状態は`show-status`を使う。
- R9は読取待ちを重ねる実装改善であり、実機wall/CPU改善を測定していない。共有更新のprepare/activate/releaseは逐次のまま、通常配信gateもcacheしない。
- 不要と確定した既存テストはないため削除しなかった。保存形式・compatibility date・binding/class名・認証・世代/base/owner照合・不変音源/履歴・purge-before-completionを維持する。
- blocked解放、未知要求の再送、旧layout移行、journal/lock/資源の削除、実環境試験は行っていない。U1の未検証性、300MB・Free適合・native DO特性の未確認範囲は残る。

運用上の詳細: [SQLiteガイド](../docs/sqlite_sequential_development.md)、[操作記録](../docs/sqlite_operation_recovery.md)、[入力上限](show_episode_input_limits.md)、[Show分離契約](do_show_separation_options.md)、[CIの固定・更新方針](../docs/ci_security.md)。
