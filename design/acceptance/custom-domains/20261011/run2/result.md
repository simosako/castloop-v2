# 独自ドメイン実機試験 run2（2026-10-11）

停止中公開配信の不具合はIssue登録済み: https://github.com/simosako/castloop-v2/issues/6
本文控え: issue-paused-delivery.md。

## 最新結果：第5節の停止中配信で不合格

管理者は状態照会失敗の記録・読み取り継続を承認。変更要求の再送や強制解放なしで第3〜4節を完了した。

| 項目 | 最新結果 | 証跡 |
| --- | --- | --- |
| 第3節 全fixtures、公開/非公開化/削除の完了条件 | 合格 | publish-domain-a-hidden-completed.json, publish-domain-a-gone-completed.json, hidden-completed.json, gone-completed.json, publish-domain-b-keep-completed.json |
| 第4節 RSS/画像/音源保存・音源hash/length照合 | 合格 | before-service.json, before-domain-{a,b}.json, before-domain-{a,b}-{feed,cover,audio}.* |
| 第4節 R2 metadata/revisionキー・TOML保存 | APIで確認済み（Dashboardは未実施） | r2-before/ |
| 未公開コンテンツの公開R2キーなし | 確認済み | r2-before/unpublished-check.json |
| 第5節 add前の共通停止確認 | 合格 | add-paused-service.json, add-paused-domains.json, add-paused-domain-{a,b,idle}.json |
| 第5節 停止中feedが503 | **不合格：200/HIT** | add-paused-feed.status, .headers, .body |
| 第5節 domain add・以後の確認 | 未実施 | — |
| 第6〜8節 | 未実施 | — |

最終pause ID: `75c97a30-a20d-4fb1-9208-fde02a144b4d`。停止状態とinvocations=[]は確認済み。
domain addは実行していない。操作IDは生成のみ（add-operation-id.txt）、Worker versionは初期化時から変更なし。
全リソース/記録を保持。独自ドメイン/DNSは未変更。

### 原因調査（ソースとローカル再現）

同じURLの再照会、nonce付URLでも200/HIT。Cache-Control:no-cacheの追加照会は未実行。
`m6-routes.ts:59-65`がreadiness確認を通し、`service-admission.ts:32-39`はopenとpausedの両方を許可する。
その後のlifecycle gatewayはShow/Episode visibilityのみを確認してcachedFetchへ進むため、pausedを公開配信停止条件として扱っていない。
`diagnostics/paused-public.ts`でpaused/invocations=[]に対して200/cache呼出1をローカル再現した（Cloudflareリクエスト0）。
証跡: paused-public-local-repro.json、pause-recheck-feed.*、pause-nonce-feed.*。
これは状態照会のsnapshot競合とは別の公開配信不一致であり、管理者の照会継続許可を拡張せず第9節で停止した。
修正やWorker deployは行っていない。paused-delivery-final-service.json / paused-delivery-final-domains.jsonが最新の状態証跡。

以下はそれ以前の経過記録。

既存環境は停止状態/lock/所有権/全リソースを変更せず保持し、管理者承認で新規環境を作成した。

- commit: 685cd81c0287d7c82204eeb4773d16f2f5c63c1c
- binary SHA-256: 6ab45ca24be4059d7697b4214b5b6ab839aced2e8b3a5ab77771aa51fa92a93d（binary.sha256）
- account/Zone: otftalk.com。同account active/full（preflight-zone.json）。Dashboard目視の代わりにAPIで確認。
- hostname: castloop-test.otftalk.com（未接続）
- service: domtest-1011-r2
- Worker/Queue: castloop-domtest-1011-r2-a42a0a3e
- DLQ: castloop-domtest-1011-r2-dlq-a42a0a3e
- bucket: castloop-domain-20261011-run2
- init operation/pause ID: c57962d8-70b4-4495-87c1-5cf503f2d1b8
- Worker version: 29af13fd-8487-48da-abb0-15ec7c280745
- 最終pause ID: 124b4afd-f16a-4ad2-a681-21fb138024f0
- add/deploy/remove操作ID: 未発行

## 結果

| 項目 | 結果 | 証跡 |
| --- | --- | --- |
| 第1節 API事前確認・未使用名/hostname | 合格（API確認） | preflight.json |
| 第2節 init・paused・invocations=[]・version一致・resume | 合格 | init-result.json, initialized-service.json, initialized-domains.json, init-resume.json |
| 第3節 domain-a Show公開 | 公開完了。ただし状態照会2回失敗 | publish-domain-a.json, failure-job-current.json |
| 第3節 domain-a/keep公開 | 公開完了。ただし状態照会失敗で停止 | publish-domain-a-keep.json, final-keep-job.json |
| 第3節 その他fixtures | 未完了 | create-domain-a-*.json, create-domain-b.json, create-domain-idle.json |
| 第4節 変更前RSS/media/R2比較 | 未実施 | — |
| 第5節 domain addの全項目 | 未実施 | — |
| 第6節 両host配信・lifecycleの全項目 | 未実施 | — |
| 第7節 domain保持deployの全項目 | 未実施 | — |
| 第8節 domain remove・復帰の全項目 | 未実施 | — |
| 最終停止・空invocations | 確認済み | final-service-recheck.json, final-domains-recheck.json |

## 停止理由

job-statusで `Operation status could not be verified; preserve records, locks and ownership without automatic retry or recovery` が再発。
CLIが元の例外を一般エラーへ変換するため、元HTTP status/reason_codeは不明。
公開要求は再送していない。後続照会は公開要求とは別の読み取り診断として実行した。
Showはf6a71932-3fa9-45dc-b575-9c535731a71f、keepはdafb76fc-9dd2-4a6e-85f9-69b1a927af12。
どちらも最終的にpublished/finished/released、keepのpurge_confirmed=trueとlock_present=falseを確認した。
実行ツールのtimeoutは0（無制限）で、前回の時間制限による中断とは別問題。

第9節に従い停止。新旧両環境のWorker/bucket/Queue/DLQ/workspace/.castloopと操作記録を保持。
hidden/gone/draftはローカル作成のみ、domain-b/domain-idleはShow作成のみ。独自ドメイン/DNS未変更。
状態照会失敗を許容して続行するか、原因診断を先行するかの判断が必要。
手順書のEpisodeコマンドミスは管理者承認でCLI実仕様へ読み替え済み。API tokenの権限変更経緯はtest-20261011.log参照。秘密情報は転載していない。
