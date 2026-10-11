# 独自ドメイン受け入れ試験 run4 — 修正後の実機合格

2026-10-11、修正commit `da6b6ea8309a87508dc7e7d0b4b70d84bba040d8`の正式CLIをビルドし、新規サービスで手順全体を完了しました。

- [結果・操作ID・version・保持状態](run4/result.md)
- [活動・判断記録](logs/test-20261011.log) / [前日の記録](logs/test-20261010.log)
- [run4計画と実施状況](logs/test-plan-run4.md)
- [ビルド・自動検証](run4/build-summary.md) / [937 pass・0 fail](run4/unit-tests-summary.txt)
- [使用した固定commitの手順書](run4/custom_domain_live_acceptance.md)
- [削除結果](run4/remove-result.json) / [receipt・pending・正しいlock名の最終確認](run4/remove-journal-final-check.json)
- [削除後domain状態](run4/removed-domains.json) / [workers.dev復帰配信](run4/removed-public-checks.json)
- [最終停止状態](run4/final-service.json) / [最終domain状態](run4/final-domains.json)
- [1.1.1.1直接DNS確認](run4/add-dns-direct.json) / [旧hostnameの切断確認](run4/removed-runtime-probe-check.json)
- [HTTP証跡（許可header・status・本文hash/lengthのみ）](run4/http/)
- [ファイル一覧・加工方法・公開版SHA-256](manifest.json)

## Issueの判断

- **#6**: 温めた公開cacheを含め、pause中の配信503を両hostで確認。run3に続きrun4でも回帰なし。close可能。
- **#7**: domain remove一回で正常完了、receipt保存、pending/token/lock解消、workers.dev復帰、データ不変、最終停止まで合格。close可能。

run3の旧操作は復旧していません。完了receiptがない既存tokenの扱いは別の保持・復旧判断であり、今回の新規試験成功を理由に再送・強制解放・resumeしていません。必要なら将来の復旧課題を別Issueで管理してください。

## 試験経路と途中の判断

DNSは試験process限定CONNECT proxyで対象hostnameだけを1.1.1.1に明示解決し、PC通常DNSの反映待ちを回避しました。OS/ルーター設定変更なし、TLS検証維持、proxyは終了済み。最初のaddは明示DNS/TLS待ちとなり、準備確認後に同じoperation IDで続行しました。未知変更要求の再送はしません。

読み取りstatus pollでは一時的な照会失敗17件がありました。[stderr](run4/read-only-status-errors/)を保存し、従前の承認どおり読み取りだけを続け、各処理の明示完了と所有権解放を確認しました。原因はこの試験では断定しません。補助scriptの誤ったfield参照・証跡label衝突も記録し、証跡を上書きせず検証から続行しています。

## 公開範囲

これは選別・匿名化した開発用snapshotです。完全な原本ではありません。

- account/Zone/接続ID・実行token値・email・ローカル絶対pathは匿名化。
- workspace/`.castloop/`/secrets/API token/binary/画像/音源/RSS・metadata本文は含めない。
- HTTP本文とR2 TOMLはhash/lengthだけ。R2各snapshotのhashを比較可能。
- verbose unit-test出力は集計のみ。途中のstatus poll全量はローカル保持、完了結果と非空エラーstderrを選別。
- CLI createや待機時のstdoutはJSONではないため`.json.stdout.txt`として保存。
- 本文省略・匿名化によりGUID/execution token等の原値検査はローカル原本で実施した結果を参照。

Worker/bucket/Queue/DLQと全操作記録を保持し、試験hostnameのみ削除済み。run1〜3は変更していません。
証跡ブランチは削除せず、Issueから固定commitリンクで参照する運用です。PRは作成しません。
