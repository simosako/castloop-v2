# Issue #48: Show分離のローカル検証

2026-10-20。[採用設計](do_show_separation_options.md)のShow単位DO/Pause/Resume、所属・共有更新の制御DOを対象とする。Cloudflareへの配備・資源変更・公開・既存環境や私有証跡の変更は行わない。

本書は初期実装のローカル試験の記録。後続の[初回実機試行](do_show_separation_live_verification_20261020.md)は初期化のcache purge確認でblockedとなった。[診断改善と再試験](do_show_separation_live_retest_20261021.md)では459テストと、2 Show・6 Episodeの実機機能確認が成功した。失敗段階・型分類の追加補強では461テスト成功。その後の[共有Worker更新](do_show_separation_worker_update_live_20261021.md)で補強を配備し、native反映待ちからの明示verify、全DOのprobe・解除・既存データ保持と更新後公開を確認した。初回purge障害の根本原因は未確定。

## 結果

- `bun test`: **458 pass / 0 fail**、62 files、57.74秒。以下の故障注入と正式source CLI walkthroughを含む。
- `npm run check`: 成功。
- `npm run build:cli -- linux-x64`: 成功。生成した`dist/castloop-linux-x64`のversion、`show-pause`/`show-resume` helpも確認した。
- `git diff --check`と変更したMarkdownのローカルリンク・空白・改行検査: 成功。
- 実装・ローカル検証のみ。Cloudflare nativeの機能・性能・Free適合の受け入れ結果ではない。

## 検証構成

- `packages/cli/src/test-support/sqlite-service.ts`は、制御DO用と各Show用に独立したBun SQLite storageとAlarmを持つ。productionと同じ`SqliteShowService`、`SqliteServiceControl`、HTTP handler、公開executorを接続し、R2/Cloudflare REST/cache purgeだけを模擬する。
- `packages/cli/src/sqlite-show-separation.test.ts`は、複数Showの公開・停止範囲、遅延と応答喪失、保守途中状態を検証する。待機中のShow Aを解放する前にShow Bの公開成功を確認し、単なる逐次成功を並列性の証拠にしない。
- 既存の公開・queue・Alarm・content・操作記録・upload・lifecycle・RSS・初期化・Worker更新の回帰を維持する。初期公開中/blockedの配信判定も対象Showに対して503とする。
- `src/sqlite-show-routing.test.ts`は、public pathからShow DOへ直接到達すること、管理要求のShow指定、異常なscope・public header注入を検証する。
- `packages/cli/src/sqlite-cli-entrypoint.test.ts`は、独立processの正式CLIをloopback専用transportへ接続する。init→Show作成→個別Resume→upload/公開→一覧→非公開化/復元→操作照会/取消/未公開素材削除→個別Pause→共有更新を実行し、外部通信を拒否する。
- `npm run check`は実platform型との接続、Linux CLI buildはWorker browser bundleの生成と単一実行ファイルへの埋め込みを検証する。生成したCLIの`show-pause`/`show-resume` helpとversionも確認する。

## 安全条件のケース

| ケース | 検証する結果 |
| --- | --- |
| Aのfeed書込後に応答不明 | Aはblocked/503。Bの公開・配信と新Show Cの登録・公開は進む |
| A/Bを個別Pause後、Aにblockedが残る | Aはdrainedにならず、Bだけ新windowでResumeできる。共有更新は配備前に拒否する |
| Aが外部IOを待機 | Bの独立Alarmが完了する。Aの途中payloadは配信しない |
| Show/受付windowの混同 | 別Showの公開要求、別Showのwindow、異常な経路を拒否する |
| 共有prepareとResumeが競合 | 既に準備したShowのResumeを拒否。未準備Showが先にResumeした場合はprepareを拒否し、配備しない |
| 制御DOとAのprobeだけ完了 | Bのprobeまで保守拘束を解除せず、全体readyや新Show登録を許可しない |
| 全probe成功 | 全対象の保守拘束解除を確認し、公開payload/ETagを保持。Showは個別にpausedを維持する |
| 制御DOだけ新native version、Bは旧version | activationを一件も送らず有限観測で停止。全対象の反映後に明示verifyで初回activationを続行し、再配備しない |
| Show別prepare/activation/保守解除の応答喪失 | 対象集合と`requested`記録を保持。Alarm・同じCLI再実行でmutationを再送しない |
| Show初期化RPCが応答不明 | 永久予約をrequestedで保全し、不確かな登録journalを昇格・再送しない。別のShow登録は可能 |
| fan-out前の耐久確認失敗 | Showへの変更要求もWorker配備も送らない |
| 旧layoutの設定 | 通信・bundle生成・鍵/journal作成前に拒否し、元の設定・既存記録を保持する |

## 制限と残る停止

この構成はBun SQLiteと模擬Alarm/R2/REST/cacheを用いる。Cloudflare nativeのoutput gate、RPC/Alarm配送、実purge、段階的rollout、Freeの利用量・CPU・300MB公開を実証したものではない。正式source CLIのprocess walkthroughと、生成した単体CLIのhelp smoke testも区別する。

共有更新の途中失敗・未知応答は安全側に停止する。全体Pauseはないが、既に準備したShowの保守拘束が残る場合がある。自動rollback・未知prepare/activation/解除の再送、blocked jobのretry/releaseや汎用復旧は提供しない。後続Alarmはprobe状態の読取確認だけを行い、probeがblockedならポーリングを続けない。通信障害等で確認Alarm自体が止まった場合も、GET照会だけで保守手順を再実行することはない。

Show単位の独立は共有Worker/R2/cache/アカウント枠の障害まで分離するものではない。新layoutの実機機能・並列負荷・配信遅延の確認は、対象と範囲を別途承認して行う。保持環境`sq16r-6ec01dc6`や過去の測定結果を、新layoutの受け入れ済み環境・性能証拠へ読み替えない。
