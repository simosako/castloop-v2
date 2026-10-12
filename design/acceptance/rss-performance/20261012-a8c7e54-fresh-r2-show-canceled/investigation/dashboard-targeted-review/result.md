# 再取得Dashboardログ: 必要な対象jobログを確認

`logs-2026-10-12T12_14_27.128Z.json` の1,757 records、UTC11:34:00.095〜11:35:59.181は必要な時間帯を含む。

原本4,249,830bytes、SHA-256 `d7a389696fe139a5e62b5d72f1320cb0dcc101ec3fefa19459f3a9cf3470cc23`。原本変更なし。

同じrequestIdを用いて、job `69a619df-9115-42e8-87db-e98947635863` のpublication_deliveryとQueue invocation/例外を照合した。

| attempt | delivery UTC | 終了 UTC | outcome | wall / CPU |
| --- | --- | --- | --- | --- |
| 1 | 11:34:29.732 | 11:35:03.794 | canceled | 34,982ms / 146ms |
| 2 | 11:35:20.503 | 11:35:23.845 | exception | 3,781ms / 9ms |
| 3 | 11:35:24.984 | 11:35:28.342 | exception | 4,026ms / 9ms |

再試行2・3の例外本文はどちらも **Another invocation still owns this lifecycle execution**。対象jobのexecution token残留により再試行が拒否されたことを、推測ではなく実機ログで確認できた。両再試行にはservice invocationの返却成功ログがある。

初回にはconsumer終了とservice invocation返却の独自timingログがなく、Queue invocationのoutcomeはcanceled。CLI待機上限300秒より前に、初回consumerが約35秒で取り消されていたことが分かる。ただし **なぜcanceledになったかは、この確認だけでは未確定**。同じexport内のspanをさらに解析する余地がある。

UTC11:35:34.769には同サービスDLQ Queue invocationのok終了がある。このinvocation自体にはjob IDがないため、単独ではjobへの直接相関を主張しない。以前のR2読取で当該commitに一致するDLQ markerを確認済みという別証拠と整合する。

今回の依頼は必要ログの有無確認。原本を保持してローカル解析／allowlist抽出のみ実施。API照会、再送、deploy、トークン解除、設定・権限変更、GitHub共有なし。raw export／stack／認証header／アカウント情報はここへ複製していない。
