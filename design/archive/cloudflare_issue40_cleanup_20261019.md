# Issue #40試験環境の削除（2026-10-19）

管理者の指示により、今回の試験専用サービス`i40-d3a0cacd`だけを削除した。

| 削除対象 | 識別情報 |
| --- | --- |
| Worker | `castloop-i40-d3a0cacd-36baef52` |
| private R2 bucket | `castloop-i40-d3a0cacd` |
| SQLite DO namespace | `9bfc3be6b01f49148501a15dbfe93490` |

## 照合と退避

- Worker一覧・全Workerのbindings・bucket一覧・namespace一覧を取得し、対象への共有参照がないことを確認した。設定と実機versionも試験記録と一致した。
- 元の強制終了試験の2プロセスが存在しないことを確認し、新しいuploadは起動しなかった。
- R2の全18オブジェクト、4,755,045 bytesを非公開退避した。全量のサイズ・MD5と一覧ETagを照合し、退避前後の一覧不変と保存後の内容一致を確認した。
- 管理APIから操作記録10件を退避した。これはDOのSQLite DB全体のexportではない。元のworkspace・journal・実行バイナリ・音源・試験証跡も保持した。

## 削除と最終照合

1. 記録済み一覧と現在の設定・オブジェクトが一致することを再確認した。
2. 対象Workerを`force`なしで削除し、対応namespaceが一覧からなくなったことを確認した。
3. 書き手のWorker削除後にR2一覧を再照合し、列挙済みの完全一致キー18件を削除した。空の一覧を確認してから専用bucketを削除した。
4. 各DELETEは送信前にfsync付きjournalへ保存し、3要求すべての成功応答を確認した。未知応答・同じ要求の再送・prefix削除・削除用Workerの配備はなかった。
5. 別のGET-only照合でも、削除対象のWorker・bucket・namespaceの不在を確認した。

保持環境`castloop-sq16r-6ec01dc6-f65ca2ec`とそのbucket・namespaceは残っている。保持Workerの設定とbucket一覧は削除前と同一、保持bucketの458オブジェクトも全key/size/ETagが不変だった。他環境、DNS、証明書、権限、課金・CPU設定、ローカル原本・操作記録・証跡は削除・変更していない。

今回の操作は明示承認された試験環境全体の廃棄であり、結果不明のPUTを成功・取消済みと認定したものではない。

非公開証跡は`.local-test-data/results/20261019/i40-d3a0cacd/cleanup/`に保持する。退避内容と操作記録を含む27ファイルのmanifest SHA-256は`445511ff48964ba343779a4b6b12455488dd633a1bf67b149c66362c1d9d2663`。
