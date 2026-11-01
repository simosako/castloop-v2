# 実機試験環境2件の削除(2026-11-01)

管理者の明示指示を受け、2026-11-01に実施した2つの非公開実機試験環境だけを削除した。対象はWorker binding・Accessアプリのドメイン・オブジェクト構成が各試験と一致する資源に限定した。

## 対象

| 環境 | 資源 |
| --- | --- |
| `rev-ea502a6-8a63`(手順書検証、[記録](live_trial_runbook_verification_20261101.md)) | Worker `castloop-rev-ea502a6-8a63-b779c0e4`、private R2 bucket `castloop-rev-ea502a6-8a63`、SQLite Durable Object namespace `5e752ffe9c404ae2bdf959bfea3e8865`、Access application `Castloop ea502a6 Private Trial` (`b2449c55-e06c-42e4-a3e0-4148bf74259b`) |
| `rev-ebaf516-d09bb9`(v0.8.5リリース試験、記録は作成しない) | Worker `castloop-rev-ebaf516-d09bb9-c5ee344c`、private R2 bucket `castloop-rev-ebaf516-d09bb9`、SQLite Durable Object namespace `ab50268611cd42f8baee34da1cc2ce9b`、Access application `Castloop ebaf516 Private Trial` (`d0a1027e-110b-4149-b911-8a383c76e40f`) |

## 削除前の照合

- 各Workerの設定bindingは上記bucketとnamespaceを参照し、worker名は各service IDと一致した。workers.dev subdomainは有効、preview URLは無効だった。
- 各Access applicationは当該Workerの `/podcasts` だけを対象とし、ドメイン一致するアプリは各1件だけだった。
- 各bucketは音声3件・cover・`system/service.toml`の計5 objects(各178,315,016 / 178,315,026 bytes)。R2 custom domain・`r2.dev`公開はなく、他のWorkerは別bucket・別namespaceを参照していた。
- DNS・共有証明書・権限・課金設定の変更は対象に含めなかった。

## 実行結果

各環境で同じ順序で実行した。

1. Workerをforce指定なしで削除した。対象SQLite namespaceが一覧から消えたことを確認した。
2. 削除前に列挙した5 objectを完全一致keyで削除し、bucketが空になったことを確認してからbucketを削除した。
3. 対象Access applicationを削除した。
4. 最終確認で対象のWorker・bucket・namespace・Access applicationがいずれも不在(404または一覧に不在)になった。`castloop-issue65sc11-f93cd6-e5e0231f` とそのAccessアプリケーションは残存した。

R2 objectの別backupおよびDurable Object SQLite databaseのexportは行っていない。ローカル素材・workspace・journal・既存証跡(`.local-test-data/results/20261101/` の両ディレクトリに削除時の応答を `cleanup-*.json` として追加保存)はこの操作で削除・変更していない。

## 関連

- 手順書検証の記録: [実機試験手順書の実機検証](live_trial_runbook_verification_20261101.md)
- 前回の廃棄手順の参照: [2026-10-29 mainスモーク環境の削除](cloudflare_main_smoke_cleanup_20261029.md)
