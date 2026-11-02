# 診断分類の粒度見直しに関する検討

対象: [Issue #112: [refactor] 診断分類の粒度見直し(ドメイン操作語彙とキャッシュパージの*_kind)](https://github.com/simosako/castloop-v2/issues/112)

調査対象: コミット `e368f34`、2026-11-02時点(v0.8.7)

この文書は対応要否の判断と実施案の比較です。管理CLIの独自ドメイン操作が持つ診断語彙と、Workerのキャッシュパージ診断が持つ `*_kind` 分類の現状を確認し、複数の案のメリットとデメリットを示して、推奨を提示します。結論として、2026-11-03に案A(対応しない)を決定しました。キャッシュパージ経路を触る関連変更が発生したときに部分削減(案C)を評価する方針とし、Issue #112はnot plannedとしてクローズしました。

ここでの `*_kind` は、キャッシュパージ診断イベントの `failure_kind` / `exception_kind` / `result_kind` / `success_kind` の4分類軸の総称です。ドメイン操作語彙は、`packages/cli/src/sqlite-domain-cloudflare.ts` が持つ `DomainApiOperation`(どのCloudflare APIか)、`DomainFailureCode`(どの検証段階で失敗したか)、`DomainDiagnosticDetails`(失敗時の補助分類)の総称です。allowlist診断とは、あらかじめ固定した分類コードなど許可された値だけを記録し、任意の例外文・応答本文・識別子・秘密を出さない規約です。

## 現状と課題

### ドメイン操作の診断語彙(packages/cli/src/sqlite-domain-cloudflare.ts、262行)

| 構成要素 | 値 |
| --- | --- |
| `DomainApiOperation` | `domain_list` / `domain_attach` / `domain_get` / `domain_detach` / `zone_get` / `dns_list` / `route_list` / `tls_probe` の7値 |
| `DomainFailureCode` | `transport_unverified` / `http_status_unverified` / `body_missing` / `partial_response_unverified` / `body_unverified` / `json_unverified` / `envelope_unverified` / `connection_schema_unverified` / `connection_target_mismatch` / `connection_receipt_mismatch` / `tls_transport_unverified` / `tls_status_unverified` の12値 |
| `DomainDiagnosticDetails` | `http_status`、`response_kind`(7値)、`environment_kind`(7値)、`expected_environment`、`fields`(検証コードのみ、最大20件)、`body_kind`(3値)、`body_bytes`、`content_length_kind`(4値) |

出力は `logDomainFailure` によるstderrへの1行JSON(`event: "sqlite_domain_cloudflare"`)だけで、成功時には何も出しません。stdoutの `--json` 結果envelopeは変更しません。対応するテストは [sqlite-domain-cloudflare.test.ts](../../packages/cli/src/sqlite-domain-cloudflare.test.ts)(217行)で、各分類の内容検証に加えて、秘密・応答本文・hostname・識別子がログへ出ないことの保証を兼ねています。

導入の経緯は[Issue #68の調査記録](sqlite_domain_response_logging.md)(2026-10-24)にあります。当時3回の `domain add` が失敗し、stdoutの診断にfield情報がなく、stderrも空で、応答本文が残っていなかったため原因を特定できませんでした。このログ追加後の第4試験で `environment_kind=empty_string` が観測され、PUT応答の `environment` フィールドが空文字であることが初めて確定しました。つまりこの粒度は、実際の障害の原因特定に貢献した実績があります。

実際の復旧アクションはIssue本文のとおり `domain status`(観測)と `domain continue`(再開)に集約されており、`AgentError` の `domain_tls_pending` / `domain_rollout_pending` が明示的な継続を促します。

### キャッシュパージの*_kind(src/sqlite-cache-purge.ts、63行)

パージ診断イベント `sqlite_cache_purge` の分類軸は次のとおりです。

| 分類軸 | 値 | 運用上の意味 |
| --- | --- | --- |
| `reason_code` | `purge_rate_limited` / `purge_rejected` / `purge_unconfirmed` | 有限自動再試行中 / 再試行しない即時失敗 / 結果不明 |
| `attempt` / `will_retry` | 回数と真偽 | 再試行の状況 |
| `failure_kind` | `call_threw` / `invalid_acknowledgement` | purge呼び出しが例外を投げた / 応答の形式が契約に合わない |
| `exception_kind` | `type_error` / `internal_error` / `other` | 例外の固定分類(内容は出さない) |
| `result_kind` / `success_kind` | `typeof` による9値(`undefined` / `null` / `boolean` / `string` / `number` / `object` / `function` / `symbol` / `bigint`) | purge戻り値とその `success` フィールドの型分類 |

動作仕様は、明確なrate-limit拒否だけを最大6回・12秒間隔で再試行し、それ以外の失敗では再送せずに公開を中断します。イベントはWorker内の `console.error`(stderr)に出力し、運用記録用のSQLite表には保存しません。対応するテストは [sqlite-cache-purge.test.ts](../../src/sqlite-cache-purge.test.ts)(108行)で、`*_kind` を検証するのは3つのテストです。消費経路は `sqlite-worker.ts` のキャッシュ対象entrypoint3箇所、[decision-cache.ts](../../src/decision-cache.ts) の配信判定キャッシュ、[site-storage.ts](../../src/site-storage.ts) のサイトページの3系統です。

導入の経緯は[Issue #48の再試験記録](do_show_separation_live_retest_20261021.md)(2026-10-21)にあります。初回のpurge障害で保存ログが `purge_unconfirmed` だけで、API例外と不正な応答形式を区別できないことが課題として挙げられ、`failure_kind` / `exception_kind` が追加され、実機試験後に `result_kind` / `success_kind` が補強されました。ただし再試験では障害が再現せず、保存ログ約9,187件の照合でも `sqlite_cache_purge` の失敗診断は0件でした。`*_kind` が実機の障害調査で価値を発揮した記録はまだありません。初回障害の根本原因は現在も未特定です。

### 文書上の位置づけ

この語彙の詳細な一覧を規定している現行文書はありません。詳細表は[アーカイブ](sqlite_domain_response_logging.md)と[Issue #48記録](do_show_separation_live_retest_20261021.md)にだけあり、[CLI設計](../components/cli.md)・[配信設計](../components/delivery.md)・docs配下(アーカイブ外)はファイル参照だけを持っています。このため `*_kind` を削減しても、更新が必要な現行設計文書の範囲はごく小さくて済みます。

## Podcast配信サービスとしての評価軸

このサービスの運用は「単一管理者がCLIで公開し、リスナーはキャッシュ経由でフィード・音声・サイトを受け取る」形です。診断分類の価値は、この利用ケースの2つの経路で異なります。

1. **エピソード公開(高頻度・収益経路)**: キャッシュパージは毎回の公開でコミット前に必須です。失敗すれば公開全体が中断しますが、これは安全側に倒れる設計で、既存配信は壊れません。パージ失敗時に管理者が行うことは「待つ(rate limitの自動再試行)」か「Cloudflare側の状態を調べてから公開をやり直す」の2つで、これは `reason_code` + `attempt` + `will_retry` だけで決まります。`result_kind` が `"undefined"` でも `"object"` でも、管理者の次のアクションは「プラットフォーム側の応答契約の異常として調査する」で変わらず、自分側で取れる対策もありません。
2. **独自ドメイン変更(低頻度・手動・本番影響)**: カスタムドメインはPodcastの公開URL自体を変える操作で、フィードURLをディレクトリ登録しているリスナーの継続性に関わります。PUT/DELETEなど結果不明のミューテーションを含むため、「未知結果を絶対に再送しない」プロトコルの中核であり、どこで失敗したかの分類が「journalを保全して `status` / `continue` で再開するか、前提を確認してやり直すか」の判断材料になります。年間の発生回数は多くても数回で、失敗時の切り分け能力を平時に保つコストに見合います。

また、両者ともログ収集基盤はなく、管理者が人間としてstderrやWorker logsを読む前提です。分類は機械的な集計のためではなく、人の切り分けのために存在します。allowlist診断の規約(秘密・例外文・本文を出さない)と、失敗時のみ出力し成功時には出さない現行の挙動は、どの案でも維持します。

## 案

### 案A: 対応しない(現状維持)

- メリット: 実績のある調査能力をそのまま保持する。変更・検証コストがゼロで、テストと設計記録の整合も保たれる。
- デメリット: 運用アクションに対応しない分類軸(`result_kind` / `success_kind` 等)を抱えたままになる。語彙の追加が続いた場合、単一管理者ツールの診断として過大になり得る。

### 案B: キャッシュパージを最小セットへ縮小

`reason_code` + `attempt` + `will_retry` に集約し、`failure_kind` / `exception_kind` / `result_kind` / `success_kind` をすべて削除する。

- メリット: 分類軸が運用アクションと完全に一致する。テスト3件と実装約10行が削れる。
- デメリット: Issue #48で「区別できない」ことが明確な課題として挙げられ、原因未特定のままの障害の再発時に、また同じ情報不足に戻る。削減量が小さい(実装は10行程度)ため、得られる保守性の向上も小さい。

### 案C: キャッシュパージの応答構造依存の分類だけ削除

`result_kind` / `success_kind`(`typeof` による9値分類)だけを削除し、`failure_kind` / `exception_kind` は維持する。

- メリット: 運用アクションに寄与せず、実機観測実績もない、価値が最も低い軸だけを取り除ける。`failure_kind` / `exception_kind` は「自分側の呼び出しの不備か、プラットフォーム側の応答異常か」の一次切り分けに使えるため残る。
- デメリット: 案Bと比べて残る軸の妥当性の説明が一文で済まず、中間的な判断として層の根拠を残し続ける必要がある。単独で実施するには文書・テスト更新の手数に見合わない。

### 案D: ドメイン操作語彙も含めた全面縮小

`DomainApiOperation` を観測系・変更系の2値に、`DomainFailureCode` を数段階に集約するなど、両方を大幅に減らす。

- メリット: コードとテストが最も短くなる。
- デメリット: Issue #68で実際に原因特定に使った粒度(`environment_kind` の区別、失敗段階の区別)を手放すことになり、実績と矛盾する。ドメイン変更は結果不明のミューテーションを含む安全プロトコルの中核で、失敗位置の分類がjournal保全の判断に直結する。実装の大部分は型定義と既存の検証分岐であり、語彙を減らしても行数はほとんど減らない。テスト217行の相当部分は秘密非露出の保証検証で、語彙削減では不要にならない。

## 推奨

**案A(現時点では対応しない)を基本とし、キャッシュパージ経路を触る関連変更が発生したときに限って案Cを評価する。** ドメイン操作語彙は将来も維持します。

理由は次の3点です。

1. 削減による実利が小さい。`*_kind` の実装は10行程度で、テストも3件の一部です。ドメイン側は語彙の大半が型定義であり、削減してもコードはほぼ縮みません。一方で失うものは、ドメイン側では実証済みの調査能力(Issue #68)、パージ側では原因未特定障害の再発時の切り分け能力です。
2. 二つの経路での価値が非対称です。エピソード公開は高頻度ですが失敗時の管理者アクションは `reason_code` + `will_retry` で足り、ドメイン変更は低頻度ですが失敗位置の分類が安全プロトコルの判断材料になります。一括の縮小(案D)はこの違いを無視します。
3. Issue本文も「関連変更のついでに評価するのが現実的」としており、単独実施のコストに見合わないというこの推奨と判断が一致します。

見送りを決定した場合、Issue #112はこの文書を判断記録としてクローズできます。2026-11-03にこの推奨を採用し、実際にnot plannedとしてクローズしました。

## 関連変更時に案Cを実施する場合の作業範囲

キャッシュパージ経路(`src/sqlite-cache-purge.ts` / `src/decision-cache.ts` / `src/site-storage.ts`)やその診断を変更する機会が生じたときに、次を評価します。

1. `SqliteCachePurgeEvent` から `result_kind` / `success_kind` と `valueKind` を削除し、`emit` のdiagnostic引数を `failure_kind` / `exception_kind` だけにする。
2. [sqlite-cache-purge.test.ts](../../src/sqlite-cache-purge.test.ts) の「不正な応答の型分類」2テストを、`failure_kind: "invalid_acknowledgement"` の出力と秘密非露出の検証だけに縮小する。
3. [配信設計](../components/delivery.md)の参照に変更がなければ追記不要。アーカイブの経緯記録は歴史としてそのまま残す。
4. allowlist診断・失敗時のみの出力・再試行条件・公開の中断条件は一切変更しない。

`failure_kind` / `exception_kind` の削除(案B)は、初回障害の原因が特定されるか、実機でこれらの分類が観測・活用された記録が揃うまで提案しません。
