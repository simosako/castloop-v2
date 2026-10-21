# Issue #48試験環境の削除と私有証跡の保持（2026-10-21）

## 承認と対象

ユーザーはPR #51のmainマージ後、今回の実機試験で作成した資源の削除と、未コミット証跡の保存・削除可否の検討を指示した。資源名のprefix一致による一括操作はせず、試験記録と一致する次のallowlistだけを環境全体の廃棄対象とする。

| 環境 | Worker | Private R2 bucket | SQLite DO namespace |
| --- | --- | --- | --- |
| 初回probe停止 | `castloop-i48-dc48db43-d91763ff` | `castloop-i48-dc48db43` | `c4c989c1f2ca40a6a7cf18769b1f929c` |
| 2 Show公開・共有更新試験 | `castloop-i48-0147da37-00c35208` | `castloop-i48-0147da37` | `e96c1e880730415f8b25ffeec6ec5d43` |
| 空cache診断 | `castloop-i48diag-2d815560` | なし | なし |

保持環境`castloop-sq16r-6ec01dc6-f65ca2ec`、そのbucket/namespace、DNS、共有証明書、他資源、権限、課金・CPU設定、ローカル原本・journal・私有証跡は削除対象外。

## 削除前の照合・退避

- アカウント、全Worker設定とbindings、bucket/namespace一覧、Custom Domain、2 zoneのWorker Routeを照合した。今回の対象に他Workerの共有参照はなく、Custom DomainとWorker Routeは0件。
- 2サービスの配備receipt/version/ETag/namespaceを照合した。公開試験環境は制御DO・両Showとも新versionでready/paused/drained・保守拘束なし。初回環境はShow 0・paused/blockedのままで、状態を成功・取消済みへ読み替えていない。
- 旧試験runnerのプロセスは残っていない。新しいupload・公開・再配備・probeを開始していない。
- 初回bucketの1オブジェクト418 bytesと、公開試験bucketの45オブジェクト11,916,266 bytes、計**46オブジェクト / 11,916,684 bytes**を非公開退避した。全量サイズ・MD5と一覧ETag、保存後SHA-256、退避前後の一覧不変を照合した。
- Show別の操作記録26件と要求・イベントを管理GETで退避した。元workspace・journal・既存ログも保持する。**DOのSQLite DB全体のexportではない**ため、完全な再構築backupとは扱わない。
- 保持bucketの全key/size/ETagと保持Worker設定を比較用に保存した。
- `otftalk.com`のDNS 8件は読取できたが、別zoneのDNSは403で未照合。Worker Routeは両zoneとも取得して0件。DNS・証明書の変更APIは呼ばず、権限拡張もしない。
- DELETEの完全一致allowlistをオフライン検査し、保持Worker/bucket、`force=true`、直接namespace削除、無指定・空・未知のobject key等8ケースを拒否した。

## 削除結果

**削除は完了した。** 2026-10-21 02:08:46 UTC（11:08:46 JST）までに、対象Worker 3件をforceなしで削除し、対象namespace 2件が一覧からなくなったことを確認した。書き手のWorkerを削除してからR2一覧を再照合し、列挙・退避済みの完全一致キー46件を削除した。空の一覧を確認した後、専用bucket 2件を削除した。

- fsync付きjournalのDELETE 7要求すべてに成功応答がある。未知応答・要求の再送・prefix削除・直接namespace削除・削除用Worker配備はない。
- 別のGET-only確認でも、3 Workerのsettingsと2 bucketは404、対象namespaceは一覧に存在しなかった。
- 残るWorkerは`castloop-sq16r-6ec01dc6-f65ca2ec`、bucketは`castloop-sq16r-6ec01dc6`、namespaceは`ea16615b38a94698805758bf18bb0458`の各1件。保持Worker設定とbucketの458オブジェクトの全key/size/ETagが削除前と同一だった。
- 他資源の一覧、Custom Domain、Worker Route、取得できたDNS 8件も削除前と同一。403のzone DNSと証明書の内容は未照合であり、不変を観測したとは主張しない。これらの変更APIは呼んでいない。
- 初回blockedを成功・取消済みに昇格したものではなく、明示承認された環境全体の廃棄である。

非公開原本は`.local-test-data/results/20261021/issue48-cleanup/`に保存する。退避object 46ファイルはobject-backup manifestにsize/ETag/SHA-256と保存先を記録し、削除journal・操作記録・最終照合等の51ファイルは`final-manifest.json`にまとめた。同manifestのSHA-256は`be2e600f0ac8595ef24a5e321d990c0b995b0320f64e87e195ccaaf9caf90a61`。

## 未コミット証跡の保存方針

実機試験・初回purge未確認・native反映待ち・既知配備からの続行の要約はPR #51で既にGit管理されている。未コミットの主な証跡は、Git対象外の生ログ・workspace/journal・試験script・今回の退避内容であり、未反映の製品コード修正とは異なる。

1. **Gitに残す**：秘密値を含まない観測要約、再現・非再現条件、code/artifact hash、試験範囲、停止・続行・削除結果と限界。
2. **非公開で保持する**：初回`i48-dc48db43`の凍結要求・receipt・health・保存ログ、cache診断、再試験と共有更新のjournal・配信hash・native照合、cleanupの要求前journal・退避manifest・payload。初回purgeの根本原因は未確定なので、生の一次証拠は現時点で消さない。
3. **Gitへ入れない**：管理キー、操作IDを含むjournal、本文・メール・IP等を含み得る生ログ、元MP3/cover/TOML。私有原本は権限制限されたGit対象外ディレクトリで保持し、長期保管先へ複製するなら暗号化・アクセス制限を行う。
4. **後日削除を検討できるもの**：同一hashの一時ビルド・ログの重複、取得済み生ログから再生成できる集計やcache。保存対象への取り込みとhash照合、対象範囲の明示承認を済ませた後だけ削除する。

今回、ローカル証跡・原本の削除や置換は行わない。既存の未commit `opencode.jsonc`はユーザーの設定変更として保持し、障害証跡や廃棄対象へ含めない。

### 実際の保全状態

初回停止・空cache診断・2 Show再試験・Worker更新・cleanupの各ディレクトリと関連scriptを目録化した。`/tmp/opencode/`の今回の一時ログ19件も、削除せず私有保存先`issue48-cleanup/local-evidence/temporary-logs/`へコピーし、コピーのhash一致を確認した。

`local-evidence-catalog.json`は**674ファイル / 60,575,581 bytes（約60.6MB）**のパス・サイズ・SHA-256を記録する。catalog自体のSHA-256は`90533e9e957e6158b60a590f3766a5c917e7e18e0c0996fee9020e326eaf6c1a`。保存ディレクトリは他ユーザーアクセス不可、コピーしたログとcatalogは0600。失敗を含む過去の中間ログは最新の成功結果と区別して保持する。

この容量では削除による便益は小さく、purge障害未確定の一次証拠を失う不利益が大きい。したがって現時点では全件の非公開保持を推奨する。**同一ディスク内の保全であり、暗号化済み・外部backup済みではない。** 長期保管では別の安全な保存先への暗号化コピーを検討し、照合後にのみ重複削除の要否を判断する。今回、原本の除去やGitへの生データ追加は行っていない。
