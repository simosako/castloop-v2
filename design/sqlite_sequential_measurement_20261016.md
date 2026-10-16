# SQLite逐次公開: 実機受け入れ・性能測定

2026-10-16。管理者から動作テストと性能測定の実施指示を受けた。既存環境は変更せず、新規の隔離サービスだけを使う。

## 範囲

- 元sourceはpush済み`4365092`。正式Linux単体CLIを凍結し、tmuxと既存trial supervisorで起動した。証跡・鍵・素材・runnerはGit管理外の`.local-test-data/`に保存する。
- 小容量3件で初期化・公開・配信・更新・非公開化/復元・互換更新を確認し、通過後に36件の実metadata＋短尺MP3へ進む。約1.5GBの原本再転送はしない。大容量転送試験とは区別する。
- CLI wall、DO Alarm CPU/wall、外側gatewayとcache-owner HTTPのCPU/wallを分ける。job/probe identityと収録欠落を明示する。socket接続だけで測定完備とはしない。
- 既存環境の変更、削除、移行、強制解放、権限・課金・CPU上限の変更はしない。subscription参照は403だったため、実planを推測せず有効設定と観測値を報告する。

## 初回初期化で検出したCLI不具合

隔離サービス`sqlite-668cbdfa`で、bucket/Worker作成、設定upload、配備、workers.dev有効化は応答を確認して完了した。
初期化は`access_enabled`で停止し、content公開は**0件**。supervisorは停止を検出し、同じOpenCode sessionへの通知確認まで完了した。

原因はCloudflare REST応答のモデル化不足。実際の`GET .../settings`には`exports`がなく、固定したversionの`resources.script_runtime.exports`にのみ存在した。ローカルfixtureは誤ってsettings側にもexportsを返していた。

修正では、固定versionの**必須exports**を使って設定とversionを照合する。ローカルの期待metadataを実証の代わりに使わず、version ID/ETag、単一100%配備、binding、cache、namespaceのWorker/class/SQLite backendを引き続き検証する。実機の読み取りでこの照合が通ることを確認した。

配備済みWorkerは`ab97ab6b-776e-4ed5-9cb7-6ce7678e1760`。native healthはpaused/drained、setupなし、publication_ready=falseを返した。これはDO constructor/SQLiteの初回読取が動く確認であり、Alarm/cache readinessや公開成功ではない。

## 再送しない検証継続

既知の配備receiptとaccess成功が保存され、setupをまだ送っていない場合だけ、明示的な`init-continue-verification`でREST検証と**初回のsetup**を続けられるようにした。
対象phaseは`access_enabled`/`verified`だけ。source/config/metadata hashを元journalへ照合し、nativeのsetup不在・paused/drainedを確認してから送信前に`setup_requested`を保存する。

- resource作成、設定PUT、配備、access変更は一切繰り返さない。
- 既に`*_requested`や`setup_requested`なら継続しない。blocked probeも再実行しない。
- 既に完了したsetupの照合は、従来どおりread-onlyの`init-reconcile`を使う。
- CLI側の応答解析修正後もWorker bundle SHA-256は元journalと一致しており、この修正のためにWorkerを再配備していない。
- 応答形と限定継続の回帰を含む全体テストは1,341 pass / 0 fail（145 files、90.14秒）。型検査・Linux単体CLI buildも成功した。

後続の実機試験結果は、各gateの完了確認後に追記する。現時点でIssue #13恒久解消、Free適合や36件性能目標の達成は示していない。
