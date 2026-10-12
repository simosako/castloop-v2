# Issue #10 再試験 a19efb4

- 修正commit a19efb4cfc95507787fa54c335c67b5722de414b。最新docs/rss_migration.mdに従う。
- 同じservice/workspace/import/hostnameを維持。旧ホストを変更しない。
- npm ci/check、全bun test、正式Worker同梱CLI build。私有証跡は evidence/rss-import-retest-a19efb4/。
- 設定と.castloopを別ディレクトリへバックアップするだけで、削除・復元・cursor編集はしない。取り込み全ファイルhashを前回と照合。
- 全Show一覧、service、停止対象を読み取り。pause/drain、全Show unfinished=false確認後deploy、新runtime/domain/config確認、明示resume。
- 元publish-rss-importを一度実行。step25の旧command_requested復旧判定はCLIに任せる。journal/lock無し、TOML一致、Episode未登録、Show active/open/所有者無しをCLIが検証する。確認失敗なら停止。
- target_status_changedのみ最大3回、publication_status_changedのみ最大120回/2分のCLI内再照会を許容。他のエラーで停止し、reason_code/http_status/cursor/journalを保存。手動再送・強制解除はしない。
- 完了時全36件RSS情報/GUID/日時、カバーと全音源HEAD/GET/Range/hash、R2 revision/重複を照合。DNSは1.1.1.1をプロセス限定で利用。OS設定変更なし。
- 続行に判断が必要またはエラーなら停止報告。証跡push/Issue closeは今回自動実施しない。

## 速度調査後の優先順位変更

- 管理者の指示により、速度調査/追加回帰より元の動作検証を優先。まず同じ取り込みの全36件公開完了を確認する。
- 初回は18件目waitingで120秒上限に達したが、読み取りでpublished/releasedを確認済み。既知job確認から同じコマンドを一度続行する。
- 製品CLI内の安全確認/全量readback/逐次公開は試験側で省略しない。内部待機120秒は変更しない。外側のツール実行時間制限は設けない。
- 今回の完了判定では新Show作成やunpublish/restore、UUID更新回帰、全36音源の追加再ダウンロードを先行させない。全件公開後、まず独立RSS照合と代表音源/カバーの配信確認。全音源独立GET/hash等は未実施ならその旨を明記し、移行全項目合格とは混同しない。
- 新エラー/再タイムアウトは自動的な反復再実行をせず停止報告。
