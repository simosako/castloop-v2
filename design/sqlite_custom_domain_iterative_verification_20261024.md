# 独自domainのログ付き再試験と修正

Issue #68、2026-10-24。管理者は、同じCloudflare accountの新規環境と任意の`castloop-domain68-*` subdomainで、実機調査・修正・再試験を繰り返すことを明示承認した。各試行はShow 0件・公開0件の最小診断とし、接続が完全に検証できた場合だけ切断する。未知mutationの再送・採用、旧環境の解除・削除、無関係なDNS・証明書・権限・課金設定の変更は対象外。

本書はR4〜R8の最小診断の記録。後続の別途指示による[第9環境の2 Show総合実機確認](sqlite_custom_domain_two_show_verification_20261024.md)は別記録とし、旧unknown/残存lockの扱いは変えない。

## R4: 元PUTの不一致をログで特定

ログ実装済みcommit `22be0c7`、Linux CLI SHA-256 `431599c4c06d7509eaf56a84df38019c04375010f1c0db630729b2d7b5fac808`で、fresh init後にdomain addを1回実行した。

- service: `i68r4-83555fca`
- hostname: `castloop-domain68-r4.otftalk.com`
- stdout: `domain_connection_unverified`、`environment / invalid_value`
- stderr: `api_operation=domain_attach`、`method=PUT`、`http_status=200`、`reason_code=connection_schema_unverified`、**`environment_kind=empty_string`**
- local phase: `connection_requested`、成功connectionなし。

HTTP・完全本文読取・JSON・成功envelopeは通過している。**元PUTのenvironmentが空文字なのに、CLIがproductionだけを要求した**のが今回の停止原因である。PUTの通信失敗やWorker実行失敗ではない。過去3試行の欠測値を復元したとは主張しない。

R4は再送・切断・後続配備をせず保持した。Show 0、paused/drained、ready false、remote prepared、workers.dev設定、initのversionのまま。既存3環境のhealthと、今回追加分を除くDNS/domain/routes/Worker/bucket一覧が試行前と同じことを読取確認した。私有証跡は`.local-test-data/results/20261024/i68r4-83555fca/`に保持する。

## 修正した契約

Cloudflareの[現行Attach仕様](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)では、応答のenvironmentはdeprecatedなstringで、入力にはenvironment指定がない。未記載の入力を追加するのではなく、観測した応答差を扱う。

1. PUTは1回だけ。HTTP/envelope/容量/完全読取と、ID・cert_id・hostname・service・Zone・enabled true・previews falseの型および凍結要求との一致を検証する。
2. **PUT acknowledgementだけ**environmentの空文字またはproductionを許容する。欠落/null/他文字列/不正型/未知keyは許容しない。保存するのもこのallowlist済みreceiptだけ。
3. `attachment_acknowledged`をfsync付きで保存する。これは完全接続ではなく、設定書込・配備・activation・切断へ進む根拠にはしない。
4. 保存済みIDへのGETでproduction固定の完全connectionを検証し、environment以外の全field（cert_idも含む）がPUT acknowledgementと一致することを要求する。GETからIDを探したり、PUTの空文字をproductionへ書き換えたりしない。
5. ここで初めて`connected`を保存し、従来のZone/membership/TLS/元配備検証と後続操作へ進む。GET待ちは同じ凍結入力でcontinueできるがPUTは再送しない。

ローカルjournal schema 1に専用fieldとphaseを追加する。addは新phase以降acknowledgement必須、connected以降は完全connectionも必須で、両者の正確な対応を検証する。removeにはこのphase/fieldを許容しない。旧unknownの`connection_requested`は変更せず、continueもIO前に拒否する。変換・移行・外部資源採用は追加しない。shared/nativeのproduction gate、queue/content形式、Worker runtimeは変更しない。

## ローカル検証

- PUT空文字→durable保存→production GET→add/removeを、単体・操作統合・独立CLI processで確認。
- GET transport・environment・ID・証明書・routing・Worker/hostname/Zone不一致で停止。後続設定は未変更、元source照合前のIOなし、GETのみの再観測後も接続PUTは1回。
- acknowledgement保存失敗でGET未開始・unknown保持、旧unknown非再送、phaseとreceiptの整合、秘密非出力を回帰。
- `bun test`: **654 pass / 0 fail、76 files、80.32秒**。`npm run check`、Linux単体CLI build成功。

修正版の新規実機試験は別のfresh環境で行う。ローカル成功を実機合格や公開/redirect/性能の確認へ読み替えない。

## R5: 接続完了と切断試験runnerの中断

修正commit `e15b863`で`i68r5-1e52c78f` / `castloop-domain68-r5.otftalk.com`をfresh initした。addは`attachment_acknowledgement.environment=""`を保存し、同IDのGETで`connection.environment="production"`を確認できた。元のPUT検証問題は解消した。

その後、設定書込前のconnectedで一度停止した。元stderrは空なので停止理由をTLS等と断定しない。後の読取検査では完全connection/membership、TLS、元配備照合がすべて通った。成功receiptと同じsource/hashを使う明示continueでaddはcompletedとなり、独自origin設定・native ready・保守解除・ローカル同期・接続一致を確認した。Showは0件のまま、公開/Resumeなし。

removeを開始したが、**エージェントが指定した実行ツールの120秒上限がCLIの全体所要時間より短く、runner/CLIが終了**した。切断不具合が実証されたわけではない。remove journalはverified、成功配備receiptあり、DELETE未開始だがlocal lockが残ったため、強制解除・続行・再送はしない。ローカルは独自origin、配備済み設定はworkers.devという途中状態を保持した。nativeはpaused/drained・ready false・prepared保守中で、Show 0件、queued 0、active null。接続/DNSは残し、R2/namespace/Worker/証跡を削除しない。

R5 Workerは`castloop-i68r5-1e52c78f-3d35f246`、private bucketは`castloop-i68r5-1e52c78f`。読取で現在runtimeに一致する既知のtarget configを使い、旧4環境のhealth、今回追加分を除くDNS/domain/routes/Worker/bucket一覧の不変を確認した。観測runnerのconfig選択とservice/registration healthの違いも修正し、失敗した読取試行の記録は保持した。私有証跡は`.local-test-data/results/20261024/i68r5-1e52c78f/`。

次の試行は新規環境で実行ツールの上限を600秒にし、CLI自身の有限待機後の正常終了を待つ。成功checkpointのないmutationや残存lockを回避するために旧環境を使い回さない。

### TLS診断の追加

connectedでの停止を次から特定できるよう、資格情報なしのTLS HEADにも固定ログを追加した。`api_operation=tls_probe`、`reason_code=tls_transport_unverified/tls_status_unverified`、`domain_tls_pending`を返す。URL・任意例外・応答本文を記録せず、404以外やredirectを受け入れない。新しいretryや検証緩和はない。

追加回帰後は`bun test` **655 pass / 0 fail、76 files、78.34秒**、型検査・Linux CLI build成功。CLI SHA-256は`bbef27619257d916a8f9d5da89ce3f5cf5ae0fd65e5542968caaf6a4aef74a37`。

## R6: TLS待ちを識別、切断の応答形式で停止

commit `f6fe243`で`i68r6-6928816f` / `castloop-domain68-r6.otftalk.com`を新規作成した。addはconnectedで`domain_tls_pending` / `tls_transport_unverified`として終了し、後の読取でTLS成功を確認した。同一成功receiptからの明示continueでadd completed、設定・接続・native ready・保守解除を確認した。TLS伝播待ちはPUT再送や新しい接続を必要としない。

600秒の実行枠でremoveを実行し、workers.devへの配備/native確認・Feed probe・ローカル同期まで完了したが、**DELETEのHTTP 200応答をJSON parseできず**、detach_requestedで停止した。元本文の形はログにないため空本文と断定しない。DELETE成功の耐久acknowledgementはなく、再送・GETの不在による成功昇格・finalizeはしない。Show 0件、paused/drained・ready false、保守拘束と全資源/証跡を保持した。既存5環境と無関係な一覧が試行前と同じことを読取確認した。私有証跡は`.local-test-data/results/20261024/i68r6-6928816f/`。

次の切り分けのため、JSON失敗ログに固定の`body_kind=empty/whitespace/nonempty`、本文byte数、`content_length_kind=missing/zero/positive/invalid`を追加する。本文やheaderの任意値は保存せず、応答の受け入れ条件はまだ変更しない。[現行Detach仕様](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/)は成功envelopeの例を掲載しているが、今回の実応答がそれと異なる理由は未確定。

ログ追加後の`bun test`は**656 pass / 0 fail、76 files、80.39秒**。型検査・Linux CLI build成功。

## R7: 元DELETEの空本文を特定、限定修正

commit `e702ceb`で`i68r7-5ab503e8` / `castloop-domain68-r7.otftalk.com`を新規作成した。addはTLS pendingの後、同じ成功receiptからcontinueしてcompleted。removeはverifiedの有限待機で2回正常終了し、その後の読取でREST/nativeのversion・config hashが一致し、targets_native_ready trueであることを確認した。再配備せず、保存済み配備から続行した。

切断DELETEの応答で次の固定ログを保存できた。

```json
{
  "api_operation": "domain_detach",
  "method": "DELETE",
  "reason_code": "json_unverified",
  "http_status": 200,
  "body_kind": "empty",
  "body_bytes": 0,
  "content_length_kind": "zero"
}
```

**元DELETEはHTTP 200・Content-Length 0・完全読取0バイトなのに、CLIがJSON本文を必須とした**のが今回の停止原因である。未知結果はdetach_requestedのまま保持し、不在GETから補完・finalizeしない。R7もShow 0件・paused/drained、ready false・保守拘束付きで保持した。既存6環境のhealthと無関係な一覧は不変。私有証跡は`.local-test-data/results/20261024/i68r7-5ab503e8/`。

### 現行のDELETE成功条件

- 正確な既知ID/全connectionの事前照合と、workers.dev復帰の全検証・ローカル同期は従来どおり必須。
- domain_detachのDELETEだけ、HTTP 200・Content-Lengthが正確に0・Content-Rangeなし・完全読取0バイトを、本文なしの成功acknowledgementとして受け入れる。架空のJSON成功envelopeは生成しない。
- HTTP 200の正常な従来JSON成功envelopeも引き続き扱う。
- 他APIの空本文、長さ未指定の空本文、空白/非空本文と長さ0の不一致、204、不完全読取、失敗envelope、未知DELETEは受け入れず、再送しない。
- 新規成功応答からのみdetach_acknowledgedを保存してfinalizeする。R6/R7のunknownを後付け補完しない。

合わせてnativeの有限rollout待機を`domain_rollout_pending`という固定診断で返し、一般的なcommand_failedとの区別を可能にした。待機回数・検証条件・再送規則は変えない。

回帰では空DELETEのstream/null-body、各不正形式、旧JSON envelope、PUT空文字→production GET、TLS/native待機の独立CLIと操作継続を確認した。native待機mockでno-store headerを落とした試験自身の不備を修正後、全体を再実行し、**666 pass / 0 fail、76 files、83.56秒**。型検査・Linux CLI build・diff検査も成功。

## R8: 修正後の接続・切断が完了

| 項目 | 結果 |
| --- | --- |
| 実行commit | `4fcb398e5326b657852abcbbea04faf659c521fd` |
| Linux単体CLI SHA-256 | `e5ae7af9e647a755637ef2cf5c4662e06d8081b9ccba1befad15e197622d8199` |
| service / hostname | `i68r8-9b028f6a` / `castloop-domain68-r8.otftalk.com` |
| Worker / private bucket | `castloop-i68r8-9b028f6a-a9a106ea` / `castloop-i68r8-9b028f6a` |
| SQLite namespace | `257c14ca4a644daea2b2d99826b898ae` |
| add | completed。PUT acknowledgementは空文字、完全connectionはproduction。設定・接続一致、ready、保守解除を確認 |
| remove | completed、detach_acknowledged true。workers.dev復帰、既知connection null、Cloudflare接続0件 |
| 最終状態 | Show 0件、paused/drained、publication_ready true、maintenance null、queued 0、active null、local_pending空 |
| 最終version | `4218140d-6303-4c60-833d-d64cfac089dc` |
| 最終読取確認 | 2026-10-24 10:15:29 UTC |

addはTLS pending、次の続行は配備PUT成功checkpoint（deploy_acknowledged）後の読取検証で一度停止したが、同じ配備から再度明示continueして完了した。removeは有限native待機の`domain_rollout_pending`で一度正常終了し、後の読取で正確なversion/configとtargets_native_readyを確認してからcontinueし、切断とfinalizeが完了した。未知mutationの再送・現在値からの採用や、待機回避の再配備はしていない。成功checkpointがある読取待ちと未知mutationを区別している。

12 CLI操作の送信前記録とstdout/stderr、add/removeのjournal・native/REST証拠、前後のDNS/domain/routes/Worker/bucket一覧を私有保存した。以前の7環境のversion・paused/drained・ready/保守状態が保存状態と一致し、R8追加分を除く一覧も不変だった。既存DBやbucket全objectの完全backupを行ったという意味ではない。R8は元々Show 0件で、素材upload・公開・Resumeは行っていない。過去2環境の4 Showもpausedのまま。

私有証跡は`.local-test-data/results/20261024/i68r8-9b028f6a/`。R4〜R8のSHA-256 manifestはそれぞれ30/58/47/57/64ファイルを記録し、保存後に再照合した。失敗ログも残し、秘密・未公開操作ID・本文をGitへ入れていない。Worker/bucket/namespace、共有証明書、旧未知journalとR5残存lockはすべて保持し、cleanupはしていない。

### 今回の結論と未確認範囲

**Show 0件での実Cloudflare接続・限定続行・切断・workers.dev設定復帰は合格**。元PUT空文字と元DELETE空本文という2つのCLI応答検証不具合を、実測を根拠に修正できた。TLS/native伝播待ちは無効化せず、明示照会・成功receiptからの続行で処理した。

この最小試験で、2 Showの公開Feed切替、旧workers.devの301/307、正規domainでの音源/画像配信・Range/ETag、履歴保持、通常publish/restore/RSS/code-only deploy、性能/全Free適合を実証したとは扱わない。[2 Show受け入れ案](../docs/sqlite_custom_domain_live_acceptance.md)の残りと区別する。既存unknown/lockの修復・旧環境切断・削除を次の通常作業として実施しない。
