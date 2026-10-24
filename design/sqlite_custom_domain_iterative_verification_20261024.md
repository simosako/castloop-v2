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
