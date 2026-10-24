# 独自domainの応答検証ログと調査結果

Issue #68。2026-10-24、管理者の指摘に基づき、契約変更より先に既存ログの調査とCLI診断の追加を行った。本書の初期調査では実機操作なし。その後、追加承認された[ログ付き再試験と修正](sqlite_custom_domain_iterative_verification_20261024.md)でPUT空文字を確認した。以下の3試験の元応答欠測は解消したことにせず、未知結果の非再送/非採用を維持する。

## 保存済みログの調査

3試験の失敗した`domain add`のstdout/stderrと保存journalを確認した。

| 試験 | stdoutの診断 | stderr | 保存phase |
| --- | --- | --- | --- |
| 初回 | invalid_input、field情報なし | 空 | connection_requested |
| 再試験 | invalid_input、field情報なし | 空 | connection_requested |
| 第3試験 | domain_connection_unverified、environment / invalid_value | 空 | connection_requested |

元PUTの応答本文は残っていない。そのため、過去のenvironmentが欠落・null・空文字・別文字列のどれかは、これらの記録からは判定できない。後のGETや追加した新ログから、過去のPUTの値を復元したことにはしない。

失敗地点はWorkerのfetch/Alarmではなく、**管理CLIがCloudflare管理APIの応答を検証する処理**だった。Worker側のログを増やしても、CLIだけが受け取るPUT応答の欠測は埋まらない。まずCLIのstderrへ構造化ログを追加した。

## 追加したログ

`packages/cli/src/sqlite-domain-cloudflare.ts`は失敗時に、stderrへ1行JSONの`event="sqlite_domain_cloudflare"`を出す。stdoutの`--json`結果envelopeは変更しない。成功時にはこのerror eventを出さない。

| field | 記録内容 |
| --- | --- |
| api_operation | domain_attach/get/list/detach、zone_get、dns_list、route_list、tls_probeという固定分類 |
| method | GET / PUT / DELETE / HEAD |
| reason_code | 下表の固定コード |
| http_status | 応答がある場合のstatus数値 |
| response_kind | 必要な場合だけ、missing/null/array/object/string/number/boolean/other |
| environment_kind | 接続receipt失敗時の固定分類。下記参照 |
| expected_environment | PUT acknowledgementはempty_or_production、完全GET connectionはproduction |
| fields | 既知field名と検証codeのみ、最大20件。未知key名は空pathへ伏せる |
| will_retry | false。診断追加による自動再送はしない |

### どこで失敗したか

| reason_code | 失敗地点 |
| --- | --- |
| transport_unverified | fetchの例外。応答を取得できない |
| http_status_unverified | 期待するHTTP 200以外 |
| body_missing | HTTP 200だがbodyなし |
| partial_response_unverified | 許可していないContent-Range付き応答 |
| body_unverified | 本文の完全読取・容量上限・UTF-8復号の検証 |
| json_unverified | JSON parse |
| envelope_unverified | success/errors等のAPI応答envelope検証 |
| connection_schema_unverified | 接続receiptのfield型・形式・固定値の検証 |
| connection_target_mismatch | schemaを通ったreceiptと凍結したWorker/hostname/Zone等との照合 |
| connection_receipt_mismatch | GETの接続と保存済みreceiptの一致確認 |
| tls_transport_unverified | 資格情報なしのTLS HEADで接続/名前解決/期限等の失敗。任意例外は保存しない |
| tls_status_unverified | TLS HEADが期待する404以外。redirectは追従しない |

PUTのreceipt検証で`http_status=200`が出た場合、HTTP・完全読取・JSON・success envelope検証までは通過したという意味である。接続完了や公開成功の意味ではない。

### environmentの区別

- `missing`: fieldなし。
- `null`: null。
- `empty_string`: 空文字。
- `production`: 期待する固定文字列。
- `other_string`: production以外の空でない文字列。文字列そのものは出さない。
- `non_string`: null以外の不正な型。
- `invalid_result`: result自体が接続objectではない。

これで「fieldがない」のか「値が違う」のかを区別できる。任意の応答値・未知field名・例外文・stack・HTTP本文・URL/hostname・domain/証明書ID・Authorization/管理鍵をログへ追加しない。新しいログを得る目的で、結果不明のPUTを再送したり、過去journalを書き換えたりしない。

## ローカル検証

- `sqlite-domain-cloudflare.test.ts`: environmentの欠落/null/空文字/別文字列/不正型、PUTとGETの検証境界、対象・保存receipt不一致、transport/HTTP/body/JSON/envelopeの失敗、秘密非出力、成功時にerror eventなしを確認した。
- `sqlite-domain-entrypoint.test.ts`: loopback模擬APIと独立CLI processを使い、PUT応答のenvironmentをnullにした場合にstderrへ固定分類が出ること、stdoutのunknown/connection_requestedが維持されること、PUT 1回・continue非再送を確認した。
- 実APIの元応答を再現したと主張する試験ではなく、想定した各分類とログ出力のローカル回帰である。
- `bun test`: **642 pass / 0 fail、76 files、81.03秒**。型検査・Linux単体CLI build・diff検査も成功。
- ログ実装commit: `661d411`。原本の3実機試験証跡は変更せず、調査表とテストログは別のgit-ignoredな私有証跡へ保存した。

## 次の調査境界

初期調査時点では実機の失敗値は未確認だった。その後の追加承認では新規環境での調査・修正・反復試験が許可され、第4試験のログで元PUTの`environment_kind=empty_string`を確認した。現行の修正・検証範囲は[反復試験記録](sqlite_custom_domain_iterative_verification_20261024.md)に記す。既存unknownを昇格・再送・切断する許可ではない。
