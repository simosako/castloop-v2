# Issue #24試験環境の廃棄（2026-10-18）

## 承認と対象

管理者が、試験終了後の提案を承認し、次の2環境に限った棚卸し・記録退避・Cloudflare資源削除を指示した。

| 環境 | Worker | private R2 bucket | SQLite namespace |
| --- | --- | --- | --- |
| 中断した初回試験 | `castloop-i24-20261018-4bc9485d` | `castloop-i24-20261018` | `5358feb40a744914bb1748873782e41b` |
| 成功した再試験 | `castloop-i24r-20261018-8f638a69` | `castloop-i24r-20261018` | `c4488fa6c37f43dc9ea1b4c567a5fb05` |

保持環境`sq16r-6ec01dc6`は対象外。今回の操作は環境全体の廃棄であり、初回の未知PUTを成功・取消済みへ昇格したり、公開途中の操作を復旧したものではない。[試験結果・CPU確認](schema_v1_removal_live_test.md)の合格判定も変更しない。

## 削除前の確認と退避

- accountとWorker全3件のbindingsを照合し、各bucket/namespaceの参照が専用で、保持環境との共有参照がないことを確認した。Queues・Custom Domainは0件。両試験環境は正式CLIの読取でready/paused/drainedだったが、これを未知upload収束の証拠にはしていない。元CLI processも終了済みで、新たなuploadは起動しなかった。
- 対象R2の全key/size/ETagを保存し、metadata・RSS等の**195 objects / 668,287 bytes**を退避した。取得bodyのsize/MD5と一覧ETag、保存後SHA-256を照合し、取得前後の一覧不変を確認した。音源・画像を含む完全backupやDO SQLite DBのexportではない。
- 最初の退避処理でREST一覧の配列形式とRSS GETのweak ETag表記に試験用scriptが停止した。削除開始前に入力処理を修正し、既存退避ファイルを上書きせず内容一致を確認して退避を完了した。
- 削除APIの完全一致allowlist・要求前fsync journal・同一要求の非再送を用い、保持Worker/bucket/namespace、foreign key、`force=true`、prefix削除の拒否をoffline検査した。

## 結果

**承認された削除は完了した。** DELETE要求開始は2026-10-18 **06:55:40.904〜06:55:48.837 UTC**。06:55:51.827 UTCに最終照合を完了した。

1. Worker 2件を`force`なしで削除し、両専用DO namespaceの不在を一覧で確認した。削除用Worker配備やDO migrationは行っていない。
2. 書き手のWorker削除後、両bucketの全key/size/ETagが保存一覧と一致することを再照合し、列挙済みのexact keyだけをDELETEした。空の一覧を確認してからbucketを削除した。
3. **R2 bucket 2件、323 objects / 4,413,335,659 bytes（約4.41GB）**を削除した。DELETE全6要求にacknowledgementがあり、不明結果・同一DELETEの再送はない。prefix job・期限ルール・強制解除は使っていない。

### 最終状態

| 資源 | 確認 |
| --- | --- |
| Worker | 保持用`castloop-sq16r-6ec01dc6-f65ca2ec`のみ。設定と一覧metadataは削除前と同一 |
| R2 | 保持用`castloop-sq16r-6ec01dc6`のみ。458 objects / 35,481,838 bytes、全key/size/ETag不変 |
| SQLite namespace | 保持用`ea16615b38a94698805758bf18bb0458`のみ |
| Queue/DLQ・Custom Domain | 0件のまま |
| ローカル | 元86素材ファイルのSHA-256不変。両workspace・journal・試験/CPU証跡・退避記録を保持 |

別processのGET-only一覧でも削除対象の不在と保持資源の存続を確認した。DNS・証明書・権限・課金・CPU上限・既存保持環境の配備/公開/受付状態は変更していない。

非公開証跡は本作業worktreeの`.local-test-data/issue24-cleanup-prepared/`。manifest SHA-256は`986aba4ba24b2a28056f44444818fe003b30c4b19141730ee9271c3567ce6e04`。途中停止した退避の記録も保持し、ローカル証跡のcleanupは行っていない。本承認は他環境やローカル原本・証跡の削除許可ではない。
