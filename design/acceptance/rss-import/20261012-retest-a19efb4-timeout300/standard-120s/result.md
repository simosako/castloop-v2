# Issue #10 a19efb4 再試験 — 待機上限で停止

- 修正commit: a19efb4cfc95507787fa54c335c67b5722de414b。CLIと正式Workerの両方を更新。
- npm ci/check/build成功。bun test: 965 pass / 0 fail、108 files、14705 expectations。
- 既存workspace/.castloopをバックアップのみ実施。記録削除/復元/手動cursor編集なし。同じimport/service/hostnameで続行。
- CLIが旧command_requested step25の未開始状態を確認し復旧。cursorにreconciled_unstarted_update_step=25。前回停止箇所を通過。
- publish-rss-importはstep76、18件目の既知job待機でexit1:

```text
RSS publication is still pending; rerun this import only to inspect its acknowledged job
```

- CLI既定の公開待機上限で停止。前回のtarget inspection拒否とは異なる。具体的な遅延原因は未確定。
- 停止cursor: phase=waiting / step=76 / job=9c26524d-d0d1-4d2d-85eb-024f2a5ccf01。
- 停止後、一度の読み取り照会で当該jobはpublished / phase=finished / ownership=released。
- Episode一覧は18件、next_cursor=null。service open / invocations=[]。全36件の公開は未完了。
- 取り込み全116ファイルhash/size不変。停止時cursor、秘密journal copy、stderr/exit、読み取り結果を保持。
- エラー時停止の指示に従い再実行なし。変更要求再送/強制解除/rollback/旧ホスト変更なし。
- 全件配信/R2照合・後続回帰・最終pause未実施。証跡push/Issue追記も今回未実施。
- 次工程は管理者承認後に同じpublish-rss-importを続行。保存した既知jobの確認から進み、公開済み分は再送しない仕様。新しいimportやjobによる置換はしない。

## followup-1（管理者が動作検証優先を指示した後）

- 同じpublish-rss-importを一度続行し、18件目の既知job確認から進行。
- step88 / 21件目job ba010ab3-c35c-4a1c-b47e-6b61249daeb0の公開待機で同じpendingエラー、exit1。CLI内部120秒/120回上限は未変更。
- 停止後の一度のjob照会でpublished/released、service open/invocations=[]。Episode一覧は2ページをすべて読み取り21件、末尾next_cursor=null。
- 入力hash/size不変。followup専用cursor/journal/出力を保存、既存証跡を上書きしない。
- 全36件未完了、独立配信照合未実施。エラー時停止方針に従い追加再実行なし。速度調査/Cloudflare設定変更もなし。
- 今後の候補は製品側で公開待機上限を設定可能にするか、明示承認の試験用buildで上限のみ延長（回数制限も併せて考慮）。未知変更再送拒否/owner確認は維持。現時点でsource/Worker変更は行っていない。
