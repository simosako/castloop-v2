# Issue #67 観測コマンドの実機確認（2026-10-25）

Issue #67の`diagnose`/`progress`/`verify`/`watch`を実環境で確認した記録。開発実装はcommit `193f9c6`（PR #81としてmerge、rebase後は`00290d7`）。本記録は実装・本地試験に続き、実機での読取観測・公開・外形確認が仕様どおり動作した範囲を示す。検証後、管理者の明示承認（2026-10-25）により本環境は削除済み（末尾の「環境削除」を参照）。

## 環境

新規隔離環境。既存の保持サービス`sq16r-6ec01dc6`と非テストDNSは変更していない。

- service: `i67live`（workspace: `.local-test-data/workspaces/issue67-live`）
- Worker: `castloop-i67live-1e3b39ec`（namespace `34d3d31ef744499b821efed05b5036de`）
- bucket: `i67live-c04076-private`
- 素材: `.local-test-data/minimal/`（cover 2,173,207 bytes、音源3本 80,501 / 240,579 / 480,488 bytes）
- 証跡: `.local-test-data/results/20261025-issue67-live/`

## 実施内容と結果

1. **init**: 新規作成・probe完了、phase `ready`（paused開始）。
2. **Show公開**: `otftalk-minimal`（sampleのshow.toml・coverを使用）を登録・resume・upload・公開。job `55349743-5bc6-44f7-9837-f3457983cd74` succeeded。
3. **diagnose**: 15 pass / 0 warn / 0 fail / 0 not_checked。`cf-credentials`は`GET /accounts/{id}`でtoken有効性と当該account読取をpass確認（操作権限の主張なし）。`consistency`は凍結公開要求とremote job記録の一致をpass。
4. **progress（Show job）**: 全フェーズ表示。`cache_purge`は`unknown`（succeededはpurge完了gate通過の注記付き）で、観測不能を完了扱いにしていない。
5. **Episode公開×3**: `ep-10s`（通常）、`ep-60s`（publishをbackground起動し`watch`を同時実行）、`ep-30s`（通常）。すべてsucceeded。
   - **watch（ep-60s）**: 公開と並行して`running`（poll 1）→`succeeded`（poll 2）を観測、終了0。stderrのJSON linesに状態遷移、stdoutの最終報告に`next_actions`として`castloop verify otftalk-minimal`連鎖を確認。
   - progress（ep-10s）: `upload:episode_metadata`は「attached (upload journal not retained)」、`upload:audio`は「attached after a verified full readback」と、記録の有無どおり正直に表示。
6. **verify**: Show指定でfeed 200（構造・3 EpisodeのGUID・enclosure origin・cover全部pass）。`--episode ep-10s`でaudio 200・Content-Length 80,501（stagedと一致）pass。`processing`（local journalのsucceeded）と`delivery`（外形）は別blockで報告。
7. **diagnose --external**: 16 pass。`delivery`集約検査pass。
8. **最終状態**: Showを明示pause。`show-status` = paused / drained / queued 0、`service-status` = paused_shows 1 / show_count 1。**環境・workspace・証跡は保持**（削除は別承認）。

## 観測上の付記

- **error 1042の誤帰属**: 当初、公開pathのcurlが`error code: 1042`となった。これは実装不具合ではなく、確認者がCLI生成の実Worker名（`castloop-i67live-1e3b39ec`）を誤った仮定のhostname（`castloop-i67live-c04076`）で指定したため。1042は「workers.dev URLにservingするWorkerがない」場合にも返る公式errorであり、管理APIが同hostで正常だったことと整合する。正しいURLでは全path正常。CLI自体は設定内の正しいURLを使っており問題なし。
- **audio revision id == 公開job id**: 公開audio URL `/podcasts/{show}/episodes/{episode}/{revision}.mp3`のrevisionは公開job idと一致した（例: ep-10s → `7baec045-...mp3`）。設計書§7.2の「local記録から構成できない」という記述は訂正済み。verifyは引き続きfeed宣言URLを使う（server側採番に依存せず購読者視点のURLを検証するため）。
- **ETagの透過観測**: feed・cover・audioの公開応答はすべてquoted MD5形式のETagを返した（例: audio `"cbb3ee24446b1342b477e53c7ba0bfb5"`、content-length 80,501、accept-ranges bytes）。upload journalのreceipt etagとの照合可能性の参考記録とする（検査には使用していない）。

## 確認済みの範囲と限界

- 確認したのは観測コマンドの実機動作（分類・進捗・待機・終端・外形確認・終了code）と通常の公開経路。通信断・blocked・job消失・SIGINT等の異常系は本地回帰で担保しており、実機では意図的に発生させていない。
- CPU時間・課金行数・大規模Show（normal/36件級）・Free枠の長期運用は未測定。watchの長時間実行（既定600秒を超える待機）も未確認。
- 本環境の実資源（Worker・bucket・namespace）は検証時は保持していたが、PR #81のmerge後に管理者の明示承認を受けて2026-10-25に削除した（次節参照）。

## 環境削除（2026-10-25）

管理者がPR #81のmainへのmergeと実環境削除を承認したため、`issue67-cleanup.ts`（`.local-test-data/`内、証跡: `results/20261025-issue67-live/cleanup/`）により削除した。手順は従来の環境削除（issue48/rv22）と同じ規律である:

- 事前検証: workspace設定と対象3資源の一致、保護環境（`sq16r-6ec01dc6`のWorker・namespace・bucket）の存在、他Workerからの参照なし、custom domain・routeなし、service healthがpaused・drained・queued 0・setup readyであることをraw応答で確認（配備Workerが#66前の旧世代のため、当時のmain CLIの3値schemaではparseできない点に注意）。
- backup: bucket内24 object（5,962,473 bytes）を全量downloadし、size・ETag(MD5)・sha256を検証の上`objects/`に保存。
- 削除: allowlist検証付きのDELETE 3件（object一括 → bucket → Worker。namespaceはWorker削除で消滅）。journalに要求と応答を記録。
- 事後検証: Worker settings・bucketが404、namespace一覧から消失、保護環境の3資源がすべて残存、旧管理endpointが応答なし、旧公開URLが404。

削除結果（`disposal-result`）: worker `castloop-i67live-1e3b39ec`、bucket `i67live-c04076-private`、namespace `34d3d31ef744499b821efed05b5036de`、object 24件を削除。資源名の再利用はしない。workspace・証跡・backupは保持する。
