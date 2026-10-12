# 1ジョブのローカル限定精密計測

- base a19efb4、別detached worktree `build/castloop-v2-rss-local-timing`。計測source/binaryはcommit/pushしない。
- 現行試験serviceの全Showがidleであることを確認し、私有backup作成。正式CLIでpause/drain→計測Worker deploy→verified/paused確認→resume。
- 元importのcompleted cursor・入力・既存公開内容を保持。otftalk-rssの既存Episode1件の同一メタデータを正式CLI update-episode→publish-episode（MP3引数なし）で再公開。履歴revision/管理generationの追加は正常な更新として記録し、旧revisionを削除/上書きしない。
- 36件を保持した状態のGUID走査/feed全件走査を含め、CLI HTTP往復・metadata PUT/全量GET検証、Queue到着/配送timestamp、Worker R2操作/本文読取、公開各段階/キャッシュ無効化/Show解放/service invocation解放を測定。
- Worker管理APIの計測結果は認証済み応答headerでCLIへ返す。Queueの計測結果だけ、処理終了後waitUntilでprivate R2 `system/diagnostics/local-timing/` に保存。正常処理の安全確認・CAS・所有権・再送条件は変更しない。計測保存失敗は本処理を再送しない。
- Worker Date.now/performance.nowはI/Oで進む時計。測定はwall time/IO回数でありCPU時間の精密測定とは呼ばない。nested spanの二重加算・Promise.allのR2重複時間を区別する。
- 公開commit済み1jobだけを300秒以内で照会。エラー/未知状態では止める。強制解放/新jobの自動再送なし。
- 成功後、feed全体とGUID/音源URLが変更前と一致、completed cursor/入力不変、service open/drained、未完了Showなしを確認。
- 全てidleなら同じ正式pause/deploy/resume手順でa19efb4の無計測Workerへ戻す（journalやデータのrollbackではない）。未知状態では戻さず止める。
- 制限: metadata-onlyの1jobであり、音源アップロード/公開音源コピーの精密計測は今回含まない。初回公開との相違を報告する。
