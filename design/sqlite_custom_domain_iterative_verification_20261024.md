# 独自domainのログ付き再試験と修正

Issue #68、2026-10-24。管理者は、同じCloudflare accountの新規環境と任意の`castloop-domain68-*` subdomainで、実機調査・修正・再試験を繰り返すことを明示承認した。各試行はShow 0件・公開0件の最小診断とし、接続が完全に検証できた場合だけ切断する。未知mutationの再送・採用、旧環境の解除・削除、無関係なDNS・証明書・権限・課金設定の変更は対象外。

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
