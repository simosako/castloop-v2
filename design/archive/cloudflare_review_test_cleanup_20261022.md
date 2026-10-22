# レビュー実機試験環境の削除（2026-10-22）

## 承認と対象

v0.7.1リリース後、管理者は[実機試験](code_review_fixes_live_verification_20261022.md)で作成した次の環境について、現状・未完了操作を確認した上でWorker・R2全内容・bucket・DO保存データを削除することを承認した。prefix一括操作ではなく、完全一致allowlistだけを対象とした。

| 資源 | 対象 |
| --- | --- |
| サービス | `rv22-8988de53` |
| Worker | `castloop-rv22-8988de53-465c75c2` |
| Private R2 bucket | `castloop-rv22-8988de53` |
| SQLite DO namespace | `7748108bfabc453dbe1f3c1044b590dd` |
| 削除前Worker version | `2902b44c-f5e0-41f2-9061-8a1c05f1df85` |

保持サービス`sq16r-6ec01dc6`、DNS・共有証明書、他資源、権限・課金・CPU設定、ローカル原本・journal・私有証跡は対象外。この環境での追加調査はできなくなったが、[観測調査](review_observation_investigation_20261022.md)の未解決事項を解消済みへ変更しない。

## 照合と退避

- サービス・両Showは元のversionのまま**ready / paused / drained、active=null、queued=0、保守拘束なし**。全17操作は`succeeded`で、未完了操作はなかった。旧試験runnerも動作していなかった。
- 全Workerのbindingsと資源一覧を照合し、他Workerからの共有参照がないことを確認した。対象にCustom Domain・Worker Routeはなかった。
- R2の**全39オブジェクト、522,522 bytes**を非公開退避した。サイズ・MD5と一覧ETag、保存後SHA-256、退避前後のkey/size/ETag一致を確認した。
- Show別操作17件の詳細・要求・イベントを管理GETで退避した。**DO SQLite DB全体のexportや完全な再構築backupではない**。元workspace・鍵・journal・binary・合成素材・生ログも別途保持した。
- 元のmanifestにある証跡220ファイルのサイズ・SHA-256一致を削除前後に確認した。保持サービス設定・資源とbucketの全458オブジェクトのkey/size/ETagも比較用に保存した。
- DELETEガードをオフライン検査し、保持資源・force指定・直接namespace削除・空/未知key等8ケースを拒否した。

## 削除と最終確認

**2026-10-22 07:57:38 UTCまでに削除を完了した。**

1. 専用Workerを`force`なしで削除し、そのDO namespaceが一覧からなくなったことを確認した。直接namespace削除・削除用Worker配備はしていない。
2. 書き手のWorker削除後もR2一覧が退避済み一覧と一致することを確認し、完全一致の39キーを削除した。空の一覧を確認してからbucketを削除した。
3. fsync付き要求前journalにDELETE **3要求すべての成功応答**を記録した。未知応答・同じ要求の再送・prefix削除・所有権強制解除はなかった。
4. 07:58:09 UTCの別GET-only確認でも、Workerのsettingsとbucketは404、対象namespaceは一覧に存在しなかった。退避39ファイルと元証跡220ファイルのhash一致も再確認した。

最終一覧には保持Worker `castloop-sq16r-6ec01dc6-f65ca2ec`、bucket `castloop-sq16r-6ec01dc6`、namespace `ea16615b38a94698805758bf18bb0458`が各1件残った。保持Worker設定、全458オブジェクトのkey/size/ETag、他資源の取得済み一覧は削除前と一致した。

取得できた`otftalk.com` DNS 8件も不変。別zoneのDNSは403で内容未照合、証明書内容も未照合であり、不変を観測したとは主張しない。DNS・証明書の変更APIは呼んでいない。公開・Resume・Pause・再配備・移行も行っていない。

## 証跡

私有原本はgit-ignoredな`.local-test-data/results/20261022/rv22-8988de53/cleanup/`へ保持する。`object-backup-manifest.json`に全39件のsize/ETag/SHA-256と退避先、`delete-journal.jsonl`に要求と応答、`independent-verification.json`に別GET確認を保存した。

`final-manifest.json`は退避payload・操作記録・実行script・前後一覧等**76ファイル**を記録する。manifest SHA-256は`c7c30165722596b263964756262a908881d7339406c5ab4ef64e717dd4f7b62d`。管理鍵・未公開job ID・任意ログ原文・内容本文はGit/PRへ転載しない。同一ディスク内の非公開保全であり、外部backup済みという意味ではない。
