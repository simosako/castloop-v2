# 独自ドメイン受け入れ試験（2026-10-11 再開）

## 最新の読み取り専用確認（10:50 JST）

中断したgone jobはcommit_requested、lock_present=true、ownership=held、status/progress=null、marker_present=false、authorizes_recovery=falseのまま。
execution_active=falseだが、未知の管理IO終了の証明とはしない。ローカルlockは空ファイルとして残存。
Show unfinished_show_operation=trueのため、既存サービスで安全に続行できると判断できない。
serviceは同pause IDでpaused、invocations=[]、domains=[]、設定/接続一致。読み取りのみ実施し停止状態と記録を保持した。
証跡: recovery-readonly-20261011T105049-{service,domains,gone-job,show,episode}.json。
再送・強制解放・resume・新規サービス作成は行っていない。

## 最新状態：CLI実仕様で続行後、公開要求の中断で停止

管理者承認により手順のEpisodeコマンド形式をCLI実仕様に読み替えて続行した。
domain-a/keepとhiddenは公開完了（published/released）。draftはローカル作成のみ、domain-b/domain-idleはShow作成のみ。
hiddenはまだunpublishしていない。goneのmetadata/audio stagingは成功した。

goneのpublish実行中、複数操作をまとめたshellの300秒実行制限で中断（実行側の時間設定ミス）。
job IDは`e4d22094-70ab-45fa-a19c-b58b4b183549`。
照会結果はclient phase=commit_requested、lock_present=true、ownership=held、marker_present=false、status/progress=null、authorizes_recovery=false。
未知IO/残留lockとして第9節に従い停止し、要求再送・強制解放・自動復旧を行っていない。

- 最終状態: paused、invocations=[]
- 最終pause ID: f9d098ff-70a6-44b0-aa03-7a36c178ed60
- 公開処理の所有権、全remoteリソース、workspace/.castloopを保持
- 第3節未完了、第4〜8節未実施、Custom Domain/DNS変更なし
- 証跡: timeout-final-service.json、timeout-final-domains.json、timeout-final-gone-job-status.json、timeout-domain-a.json、timeout-pause-result.json
- 公開完了証跡: publish-domain-a-keep-completed.json、publish-domain-a-hidden-completed.json、fixture-hidden-published.json

以下は各時点の経過記録。最終状態はこの節を参照。

- hostname: castloop-test.otftalk.com
- Zone: otftalk.com。account/Zone IDはpreflight-zone.jsonに保存。
- service予定: domtest-1010-685cd81c
- bucket予定: castloop-domain-20261010-685cd81c
- commit: 685cd81c0287d7c82204eeb4773d16f2f5c63c1c
- binary SHA-256: 6ab45ca24be4059d7697b4214b5b6ab839aced2e8b3a5ab77771aa51fa92a93d（local-hashes.txt）

## 結果

| 項目 | 結果 | 証跡 |
| --- | --- | --- |
| 同accountのactive/full Zone、非停止 | 合格（読み取りAPI。Dashboard目視未実施） | preflight-zone.json |
| hostnameのDNS競合確認 | 実行失敗: HTTP 403 / Cloudflare code 10000 | preflight-failure.json, preflight-output.txt |
| 第2〜4節 サービス・素材の公開・変更前保存 | 未実施 | — |
| 第5節 domain addと停止中の確認 | 未実施 | — |
| 第6節 両hostの配信・lifecycle | 未実施 | — |
| 第7節 domainを保持したdeploy | 未実施 | — |
| 第8節 domain remove・workers.dev復帰・最終停止 | 未実施 | — |

第1節の事前確認で停止。使用中tokenのDNS読み取り権限またはZone対象指定、変更したtokenとの一致を要確認。
remote変更なし、Worker/bucket/Queue/DLQなし、操作ID/pause ID/version未生成、workspace未作成。
前回の一時証跡は消失していたため、過去結果はtest-20261010.logを参照。今回の証跡はプロジェクト内へ保存。

## token更新後の再確認

先のHTTP 403は解消。読み取りAPIの事前検査はすべて合格（preflight.json、preflight-after-token-update-output.txt）。
Zone/DNS、Custom Domains/Worker Routes、workers.dev subdomain、R2 buckets、Worker scripts、Queuesを取得できた。
hostnameは競合なし、subdomainはsimosako、service/bucket名は未使用。
書き込み権限は未検証。今回の権限確認ではremote変更を行っていない。第2〜8節は引き続き未実施。

## API token権限設定変更

管理者が既存のAccount API Token `castloop-v2-dev` を編集し、以下の構成で更新成功した（画面と管理者報告に基づく）。

| ポリシー | 対象 | 権限 |
| --- | --- | --- |
| 1 | アカウント全体 | Workers Admin / Workers R2 Storage Write / Account Settings Read |
| 2 | 指定ドメイン otftalk.com | DNS Read / Zone Read / Workers Routes Write |

変更点は、ポリシー1の対象を「すべてのドメイン」から「アカウント全体」に変更し、
DNS Read / Zone Readをポリシー2へ追加、既存Workers Routes Writeをポリシー2へ移動したこと。
対象変更前はWorkers Adminに対するcommon permission checkエラーで保存できなかったが、変更後に保存成功し、DNS APIの403も解消した。
独自ドメイン有無でtokenの切替は不要。token値は記録していない。詳細はtest-20261011.logを参照。

## 実機試験再開結果（上記の未実施状態から更新）

service IDは21文字だったためローカル検証で拒否された。remote IO前の拒否をソースで確認し、15文字の`domtest-685cd81c`へ訂正した。

- Worker: castloop-domtest-685cd81c-7ce82b9c
- bucket: castloop-domain-20261010-685cd81c
- workers.dev: https://castloop-domtest-685cd81c-7ce82b9c.simosako.workers.dev
- init operation/pause ID: fac53423-624e-449b-b0d3-dd727b6dadde
- Worker version: 3655e932-7198-495c-84cc-9a33eb807d0e
- domain-a publication job: 10b6aa3c-f18f-4f8f-b50e-a929a327a5dc
- 最終停止pause ID: 930d4f47-04e6-45fa-bcea-8b01d5ab4cb5
- add/deploy/removeの操作ID: 未作成

| 項目 | 結果 | 証跡 |
| --- | --- | --- |
| 第2節 初期化・停止状態・version一致・resume | 合格 | initialized-service.json, initialized-domains.json, init-resume.json |
| 第3節 domain-a Show公開 | 合格（中断後は同jobの照会のみ） | publish-domain-a-after-restart-completed.json |
| 第3節 Episode作成 | 手順とCLI仕様の不一致で停止 | create-episode-help.txt、index.ts 144–152行 |
| 第4〜8節 | 未実施 | — |
| 停止状態の確認 | paused、invocations=[]、unfinished_show_operation=false | final-observed-service.json, final-observed-domain-a.json |
| ドメイン状態 | domains=[]、設定/接続一致、ローカル操作/url_changeなし | final-observed-domains.json |

手順の`create-episode domain-a keep`は引数エラー。CLIはShowディレクトリ内から`create-episode keep`を要求する。
同様にupdate-episode/update-episode-audio/publish-episodeの例もCLI仕様と整合するか訂正が必要。
手順第9節に従い後続試験は停止した。Episode未作成、独自ドメイン接続・DNS登録なし。
停止後、別pause IDで追加のpauseを誤って要求し、応答未検証エラーとなった。再試行・強制解放はせず、GETによる最終確認で既存pause IDの停止状態を確認した。
Worker/bucket/Queue/DLQとworkspace/.castloop、操作記録は保持。秘密情報やmetadata本文は本報告へ転載していない。

## 実機試験の進行と最終結果

上の「未実施」は権限確認時点の記録。試験再開後の結果は以下のとおり。

- service IDは文字数誤認（旧IDは21文字）を訂正し、`domtest-685cd81c`へ変更。最初のinitは入力検証で拒否されremote IOなし。
- Worker/Queue: `castloop-domtest-685cd81c-7ce82b9c`
- bucket: `castloop-domain-20261010-685cd81c`。DLQもinitで作成、workspace設定とともに保持。
- init operation/pause ID: `fac53423-624e-449b-b0d3-dd727b6dadde`
- Worker version: `3655e932-7198-495c-84cc-9a33eb807d0e`
- 最終pause ID: `930d4f47-04e6-45fa-bcea-8b01d5ab4cb5`

| 項目 | 結果 | 証跡 |
| --- | --- | --- |
| 第2節 init・停止状態・readiness確認 | 合格。その後再開 | init-corrected-result.json, initialized-service.json, initialized-domains.json, init-resume.json |
| 第3節 domain-a Show公開 | 合格。published/released確認 | publish-domain-a-after-restart-completed.json |
| 第3節 Episode作成 | 手順とCLI不一致で実行拒否 | create-episode-help.txt, test-20261011.log |
| 第4節 変更前データ保存 | 未実施 | — |
| 第5節 domain addの全確認 | 未実施 | — |
| 第6節 両host配信・lifecycleの全確認 | 未実施 | — |
| 第7節 domain保持deployの全確認 | 未実施 | — |
| 第8節 domain remove・復帰の全確認 | 未実施 | — |

停止理由: 手順の `create-episode domain-a keep` は引数エラー。実際のCLIはShowディレクトリで `create-episode keep` を要求する（index.ts:144-152）。ローカルエラーにreason_codeフィールドはない。
サーバー再起動時にpublish要求は再送せず、保存済みjob ID `10b6aa3c-f18f-4f8f-b50e-a929a327a5dc` を照会して公開完了を確認した。
第9節に従って試験停止。最後はpaused、invocations=[]、domain-aのunfinished_show_operation=false、domains=[]、configuration_matches/connections_match=true、local_operations=[]。
domain add/deploy/removeの操作IDは未発行。試験hostnameへのDNS/Custom Domain変更なし。
最終状態の証跡: failure-service.json, failure-domains.json, failure-domain-a.json, failure-pause-result.json。
Worker/bucket/Queue/DLQとworkspace/.castloopを保持。手順のEpisodeコマンド形式の修正またはCLI実仕様に合わせた続行判断が必要。
停止済みサービスへの別pause IDの追加要求は「Service administration response was not verified」で拒否された。自動再試行や強制解放は行わず、final-observed-service.json / final-observed-domains.json / final-observed-domain-a.jsonの読み取りで同じ安全な停止状態を再確認した。
