# a8c7e54 性能追試 — Worker更新中のAPI timeoutで停止

## 結果

性能測定はまだ開始していない。無改変CLIのbuildと自動試験は成功したが、正式Worker更新中にCloudflareの読み取りAPIがtimeoutとなり、変更操作を停止した。初回カタログ構築・次の通常更新jobは双方未実施で、性能改善の判断はできない。

## 準備・確認した改修

- Issue #10のcomment-6121979331と `docs/rss_migration.md` を確認。EpisodeカタログによるGUID/feed個別取得削減、staging finishでの不変記録再利用。
- 固定commit: `a8c7e54e8c326ef238a2fcd9d672a27b002bec66`。
- 新detached worktree: `build/castloop-v2-rss-a8c7e54`。製品sourceは無改変、cleanを確認。
- CLI: `bin/castloop-linux-x64-a8c7e54`。
- SHA-256: `cf2a3756eb2cae8e237817fc39d106ec4674dde2983843cd11df8244595eb97a`。
- npm ci / npm run check / Linux単一CLI build成功。
- bun test: **977 pass / 0 fail、111 files、14810 expects、20.26秒**。
- 計測待機helperのunit test: **6 pass**。正式CLI/Workerではなく、この環境のローカル試験補助プログラム。
- 試験計画: `test-plan-rss-performance-a8c7e54.md`。既存36件Show/同じEpisode/同一metadata-onlyの初回構築と通常更新を別々に計測する計画。

## 更新操作と停止

既存 `workspaces/rss-20261012-run1` を私有copyとしてbackup。completed import/cursor、元素材、ローカルTOML、設定のhashが前回と同一。事前にservice open/drained・全Show未完了なし、Worker version `6d3d011d-e720-42b6-80b0-41f2830128ff` を確認。

1. service-pause成功、paused / invocations=[]を確認。
2. `deploy`を1回だけ実行。コマンド全体は **81.348秒**でexit1（この時間すべてが失敗GETの時間という意味ではない）。stderr:

   ```text
   Cloudflare GET /workers/scripts/castloop-rsstest-1012-r1-acb1fbca/settings could not connect: The operation timed out.
   ```

3. 変更操作を止め、service-statusを1回だけ読み取り。**state=updating / invocations=[]**、live Worker versionは前回の4781fadと同じ。
4. target-showの読み取りはHTTP409 `management_http_rejected` で拒否された。更新中という状態と整合するが、Showの停止後状態はこの照会では検証できない。追加live照会を止めた。

## 保存されている更新状態

- update operation: `3ad4f8af-7552-40a2-9525-8bf434a6146e`。
- ローカルjournal: `phase=deploy_requested`。
- **upload receiptあり**: 新Worker version `846ac0df-94dc-4c26-af27-7d189c7f159b` のupload受付は確認済み。
- **deployment receipt / targetなし**。新versionの稼働完了とは扱わない。
- sourceの `cloudflare-api.ts` はupload receipt保存後、activation前にsettings等を再照合する。この経路のGET timeoutで止まり、live versionが旧版のままであることと整合する。一般的なネットワーク/Cloudflare側timeoutの原因は未確定。
- `resumeM6UpdateDeploymentVerification` はupload receiptとdeployment receiptの両方を要求する。今のjournalでは標準 `update-service-verify` の前提を満たさず、安易に実行しない。
- deployの再送、新operationの作成、resume、journal編集/復元、owner/lock強制解除、Workerの手動activateは実施していない。

## 保持状態と次の判断

元入力/completed cursor/全ローカルTOML/設定hashは停止後も不変。公開更新job・tail sessionは作成していない。旧ホスト、旧環境、音源・履歴・カタログの削除/手動編集はなし。サービスはopenに戻しておらず、updatingを保持しているため配信可用性の正常復帰を保証しない。

停止時journalとreceipt、stderr、CLI応答、workspace backupを保持。ユーザーにこの停止を報告し、既知upload受付済み・activation未確認の状態からの安全な復帰方法を調査する判断を求める。GitHub push/Issue追記は今回まだ行っていない。

主な証跡: `build-identity.json`、`bun-test.stderr`、`harness-tests.stderr`、`install-deploy.stderr`、`install-deploy.elapsed.json`、`stopped-service-status.stdout`、`stopped-target-show.stderr`、`stopped-summary.json`、`stopped-private-update-journals/`、`private-workspace-backup/`、root活動log。秘密を含み得る原本であり、公開には選別・秘密除去が必要。

## 続報: 管理者承認の読み取り調査

`update-investigation/findings.md` に調査結果を保存。設定取得は約0.420秒で成功し凍結意図hash一致、deploymentsも旧version100%を確認したが、versions一覧GETが30秒timeoutで停止。製品の更新関連コードは4781fadから無変更。ローカル模擬試験2件成功で、GET停止とactivation POST応答不明が同じupload-only journalになること、標準CLIが両方を拒否することを確認した。更新受付のみからの安全な続行は現CLIに未提供であり、一般的な自動activation再送は不可。Cloudflare timeoutの根本原因は未確定。既存資源/記録/updatingを保持し、実際の復帰やGitHub報告はまだ行っていない。
