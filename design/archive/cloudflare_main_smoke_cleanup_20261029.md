# main-head実機テスト環境の削除（2026-10-29）

利用者の明示指示を受け、main headの実機テストで作成したCloudflare環境だけを削除した。対象は作成日時・Worker binding・Access hostnameが今回のテストと一致する資源に限定した。

## 対象

| 資源 | 削除対象 |
| --- | --- |
| Worker | `castloop-main-smoke-20261029-777480cf` |
| private R2 bucket | `castloop-main-smoke-20261029` |
| SQLite Durable Object namespace | `0da239ff77414d24b9e6ad2148db2327` |
| Cloudflare Access application | `Castloop main-head smoke private trial` (`bf2dcbc3-aa18-4d6e-b8d8-2021c3ce5f39`) |

## 削除前の照合

- Workerの設定bindingが上記bucketとnamespaceを参照し、service IDは`main-smoke-20261029`だった。workers.dev subdomainは有効、preview URLは無効、Worker routesはなかった。
- Access applicationは当該Workerの`/podcasts/*`だけを対象としていた。
- bucketには3音源、cover、`system/service.toml`の計5 objects、合計104,582,851 bytesがあった。R2 custom domainはなく、`r2.dev`公開は無効、bucket jobsは0件だった。Event Notification設定の照会は「設定なし」の404だった。
- 他のWorkerは別bucket・別namespaceを参照していた。DNS・custom domain・共有証明書の変更は対象に含めなかった。

## 実行結果

1. Workerをforce指定なしで削除した。Workerとともに対象SQLite namespaceが一覧から消えたことを確認した。
2. 削除前に列挙した5 objectを完全一致keyで削除し、bucketが空になったことを確認してからbucketを削除した。
3. 対象Access applicationを削除した。
4. 最終一覧で対象Worker・bucket・namespace・Access applicationがいずれも不在であることを確認した。他の試験用Worker・bucket・namespace・Access applicationは一覧に残っていた。

R2 objectの別backupおよびDurable Object SQLite databaseのexportは行っていない。ローカル素材・workspace・journal・既存証跡はこの操作では削除・変更していない。`sq16r-6ec01dc6`、`otftalk.com` DNS、共有証明書、権限・課金・CPU設定にも変更を加えていない。
