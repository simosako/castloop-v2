# 状態照会エラーの原因調査

## 結論

最有力原因は、公開consumerによる更新と状態照会が重なった際の、意図的なsnapshot競合拒否。
ローカル再現で実機と同じCLIメッセージまで確認できた。ただし実機失敗時の生応答が未保存のため、実機原因を断定はできない。

## エラーの経路

1. `src/publication-inspection.ts:16-39` がcontrolとjob記録を取得し、control再読とR2 HEADでetag/sizeを再確認。
2. 読み取り途中の更新を検出すると `Publication records changed during their read-only inspection` で拒否。
3. `src/publication-admin.ts:53-56` がHTTP409、`publication_operation_blocked`を返す。
4. `packages/cli/src/m6-admin-json.ts:83-97` が非200応答を一般的な検証エラーへ変換。
5. `remote-operation-status.ts:46-47` が最終的に `Operation status could not be verified` へ変換する。

## 検証

- `diagnostics/status-read-race.ts`：fake R2で読み取り中更新を起こし、上記経路と同じCLIメッセージを決定的に再現。
- 安定前後の照会は成功。
- Cloudflareリクエスト0。実機状態変更0。対象ソースの変更0。
- 既存の競合拒否テストは1 pass / 0 fail（diagnosis-concurrent-status-test.txt）。
- 再現出力：diagnosis-status-read-race.json。HTTP409とreason_codeはローカル再現結果であり、実機失敗の採取値ではない。
- 実機の成功応答では、失敗前はprocessing/validating、失敗後はprocessing/purgeまたはpublishedに進んでおり、競合仮説と整合。

## 継続方針案（まだ適用していない）

変更要求の再送、lock削除、所有権解放は行わない。
状態照会の失敗は証跡保存し、独立した読み取り照会を続ける。完了の明示的証拠が揃うまで次の変更へ進まない。
生HTTPのstatusとallowlistされたreason_codeを採取できれば、実機の409と通信/認証/別の検証失敗を区別できる。
現行CLIは原因を包括catchするため、メッセージだけで一律に競合とみなしてはならない。
この扱いは手順第9節の厳格な停止条件の読み替えとなるため、管理者判断が必要。
現状はrun2停止、新旧リソースと証跡保持のまま。
