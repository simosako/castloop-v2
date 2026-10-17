# Cloudflare旧試験環境の廃棄（2026-10-17）

## 承認範囲

管理者は[現状調査と推奨](cloudflare_cleanup_inventory_20261017.md)を確認し、推奨に従った削除と、試験用`castloop-`サブドメインの削除を指示した。それ以外の`otftalk.com`のドメイン・サブドメインは削除禁止。

- 最新SQLite環境`sq16r-6ec01dc6`は保持する。
- それ以外のWorker 20、bucket 18、Queue/DLQ 34、旧SQLite namespace 1、試験用Custom Domain 3を対象とする。
- 未完了owner・updating・blockedの旧環境も、復旧やtoken強制解放ではなく、環境全体の廃棄として扱う。旧要求を成功へ読み替えず、再送・migration・新Worker配備をしない。
- ユーザーの`otftal.com`という表記は、前の調査対象`otftalk.com`の誤記と解釈することを実行前に明示した。対象hostnameは調査で確認した次の3件に固定した。
  - `castloop-rss-r1.otftalk.com`
  - `castloop-rss-perf-r2.otftalk.com`
  - `castloop-rss-perf-r3.otftalk.com`

## 削除前の照合・退避

- アカウント、Worker/bucket/Queue/DOの参照、DNS一覧が、承認対象の調査時点と一致することを再照合した。
- 最新環境が旧bucket/Worker/namespaceを参照していないことをbindingsで確認した。
- R2の全objectについてkey/size/ETagを再照合し、削除対象の管理記録・TOML・commit marker・feed等**4,190 objects / 4,080,802 bytes**を非公開退避した。本文のMD5と一覧のETagを照合し、別途SHA-256 manifestを保存した。取得後の一覧も不変だった。
- 退避ファイル全件について、保存後のサイズ・SHA-256をもう一度照合した。
- 退避は音源・画像を含む完全な復旧backupではない。既存ローカル素材、workspace/journal、過去の証跡は削除しない。
- 旧SQLite環境は削除前も`open / active=blocked / queued=0 / drained=false`、最新は`ready / paused / active=null / queued=0 / drained=true`だった。旧SQLite DB全体をexportしたものではなく、native状態・namespace/binding情報と既存試験証跡を保持する。
- API削除は完全一致のallowlistと要求前journalを用い、自動再送・`force=true`・DNS recordへの直接DELETEを許可しない。最新資源・他用途DNS・同一削除要求の再送を拒否するガードを、Cloudflareへアクセスしないmockで確認した。

非公開の原本は`.local-test-data/results/20261017/cloudflare-cleanup/`に保持する。鍵や内容本文を含み得るためGit/Issueへ追加しない。

## 実行結果

**承認対象の削除は完了した。** 削除APIの実行区間は2026-10-17 07:32:18〜07:35:45 UTC（16:32:18〜16:35:45 JST）。145件の削除要求すべてにacknowledgementがあり、結果不明や同じ要求の再送はなかった。その後、最終一覧と保持資源をGETで照合した。

- R2通知17接続とQueue/DLQ consumer 34接続を削除した。
- 試験用Custom Domain 3接続を削除し、対応する管理DNS 3件も一覧からなくなったことを確認した。
- 残る8 DNS recordは削除前と完全一致。直接DNS DELETE・Zone設定変更はしていない。
- 旧Worker 20件を`force`なしで削除し、旧SQLite namespaceの不在と最新namespaceの存続を照合した。DO削除用のWorker配備は行っていない。
- producer/consumerが残っていないことを照合してQueue/DLQ 34件を削除し、一覧が空になったことを確認した。
- この後のR2削除中に対話のtransportが中断したが、元の削除processは継続していた。新しい削除processや同じ削除要求は起動せず、元のjournal・processを確認した。
- 書き手のWorkerとQueueを削除した後、bucketごとに保存済み一覧とkey/size/ETagが一致することを再確認し、完全一致のobject keyを最大1,000件ずつDELETEした。空の一覧を確認してからbucketを削除した。prefix一括削除jobや期限ルールの追加は行っていない。
- **R2 bucket 18件、4,795 objects / 11,072,988,266 bytes（約11.07GB）**を削除し、対象bucketが一覧にないことを確認した。

### 最終状態

| 資源 | 最終確認 |
| --- | --- |
| Worker | `castloop-sq16r-6ec01dc6-f65ca2ec`の1件のみ。設定・一覧上のmetadataは削除前と同一 |
| R2 | `castloop-sq16r-6ec01dc6`の1 bucketのみ。458 objects / 35,481,838 bytesの全key/size/ETagが削除前と同一 |
| Queue/DLQ | 0件 |
| DO namespace | `ea16615b38a94698805758bf18bb0458`の1件のみ。旧`d22285ad685b4504830949500a5ac9fb`は不在 |
| Custom Domain | 0件。対象3件は不在 |
| Worker Route | 0件のまま |
| `otftalk.com` DNS | 対象3件のみ不在。apex A、www CNAME、Google確認用CNAME、MX 3件、SPF/DKIM TXTの8件は削除前と完全一致 |
| 最新native runtime | version `8ace6fc5-aa21-49f5-ac88-f9d3c50ef82e`のままready/paused/drained、active null、queued 0 |

旧環境の所有権を解放したり、blocked jobを成功へ変更したりしたものではない。旧環境の恒久データを承認に基づいて廃棄した。最新環境の再開・追加公開・配備・migration、ローカル素材/証跡の削除や権限/課金/CPU上限変更は行っていない。完了通知は追加変更の許可を与えない。

## 残る確認範囲

証明書一覧は既存token/MCPとも403で取得できない。証明書の削除や権限変更は実施しない。Custom Domainの削除後も証明書が残る場合があるため、Dashboardで対象hostnameと共有関係を確認する作業は別に残る。
