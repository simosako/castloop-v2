# 独自domainのenvironment診断と接続receipt契約の追加レビュー

2026-10-24、Issue #68。以下は第3試験時点の診断と提案。管理者の指摘を受け、先に[保存済みログの調査とCLI診断の追加](sqlite_domain_response_logging.md)を実施した。その後の追加承認に基づく第4試験でPUT空文字を特定し、[限定した二段階receiptと反復試験](sqlite_custom_domain_iterative_verification_20261024.md)へ進んだ。現行仕様はそちらを優先する。旧unknownの採用・後続操作は行わない。

## 1. 診断結果と分かっていないこと

管理者の別途承認に基づき、既存2環境を保持したまま、`castloop-domain68-r3.otftalk.com`と別のfresh環境で診断した。今回の範囲は**Show 0件・素材公開なし**、domain接続、成功記録を正確に検証できた場合だけ切断すること。初期化後にdomain addを1回実行し、次の固定診断で停止した。

```json
{
  "code": "domain_connection_unverified",
  "outcome": "unknown",
  "fields": [{ "path": ["environment"], "code": "invalid_value" }]
}
```

停止箇所は、PUTの成功envelopeから取り出した接続応答に対する`environment = "production"`固定検証である。実装は`z.literal("production")`を要求するが、[公式Attach仕様](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)の応答fieldはdeprecatedなstringであり、この固定値を保証していない。現行公開入力にもenvironmentの指定は掲載されていない。

ただし、**元PUT応答の値やfieldの有無は記録していない**。空文字・省略・別の値のどれだったかは特定できない。`invalid_value`だけから空文字等を推測しない。後のGET一覧に`environment="production"`が見えても、元応答を復元できたことにはならない。初回・再試験にも同じ原因があったと断定する証拠ではない。

接続ID等の現在値を採用したり、`environment`をローカルで書き換えたりせず、成功receiptがない操作を`connection_requested`のまま保持した。**切断・後続配備・activation・再送・保守解除は行っていない**。

## 2. 第3試験時点の修正案（履歴）

PUT応答の一部fieldを根拠なく補正するのではなく、**接続PUTのacknowledgement**と**使用可能な接続の確定**を別の耐久checkpointにする。

1. Attach PUTは今までどおり1回だけ送る。HTTP 200、完全読取、`success: true`、空errors、既知の型/サイズ制限を維持する。
2. PUT acknowledgementでは、domain ID、証明書ID、hostname、service、Zone ID/name、enabled true、previews falseを検証し、凍結した正確な対象へ束縛する。deprecatedな`environment`はこの段階のrouting証拠として使わず、任意の値や本文も運用記録に保存しない。その他の未知field・応答の扱いを含め、専用の外部応答schemaを定義する。
3. 検証できたPUT acknowledgementを、**GETより前にdurable保存**する。新規phase案は`attachment_acknowledged`。この時点は接続確定でも設定切替完了でもない。
4. 保存済みacknowledgementの**正確なdomain IDへのGET**で、`environment="production"`を含む現行の完全接続schemaと、全allowlist field・cert_id・Worker/hostname/Zone/routing設定の一致を検証する。hostname検索結果や現在の一覧だけから接続を採用しない。
5. 完全一致して初めて、従来どおり`connected`の完全receiptを保存する。それまでR2設定書込・Worker配備・Feed切替・finalize・Resume・切断へ進めない。
6. GET/TLS待ちで停止した場合は、同一PUTの成功acknowledgement、元要求/hash/source/namespaceを再照合した上で、GETと未開始段階だけを限定続行する。PUT自体は再送しない。

`SqliteDomainConnection`およびDOへ送るactivation/finalizeの**production固定条件は維持**する。別environment・preview・別Workerを許容する提案ではない。単純に完全receiptからenvironment検証を削除したり、PUTの不一致値を`production`へ置き換えたりしない。

### 変えない境界

- transport失敗、応答本文不明、不正envelope、ID/対象/証明書/routing不一致、acknowledgement保存失敗は未知結果のまま。後の存在GETから補完しない。
- **今回を含む3環境の既存`connection_requested`記録は補完・昇格しない。** 新しいcheckpointは、変更後の新規操作で最初から成功acknowledgementを保存した場合に限る。
- 同じhostname/DNS/Worker接続への外部同時変更は従来どおり想定外。新しいCAS保証、外部資源採用、移行、万能修復、token/lock強制解除は追加しない。
- 未記載のenvironment入力を追加してPUT応答を調整する回避や、Cloudflareの非公開APIへの切替は行わない。
- sharedの要求/接続型、nativeの公開gate、Show停止・履歴保全・未知IO非再送は維持する。新規journalのformatとcheckpointの整合条件は実装時に明記し、古い未知journalの変換を作らない。

## 3. 実装・回帰の予定

- `sqlite-domain-cloudflare.ts`: 外部PUT acknowledgementの専用検証、完全GET照合、固定診断。PUT応答だけから完全接続を作らない。
- `sqlite-domain-journal.ts` / `sqlite-domain-operation.ts`: acknowledgementと完全接続の別checkpoint、必要証拠の有無、元要求への束縛、GETのみの限定続行、removeとの区別。
- 回帰: PUT/GETのdeprecated field表現差、GETのproduction・全field/cert一致、GET失敗後もPUT 1回、保存失敗と未知PUT非採用、不正ID/対象/routing拒否、旧unknown非昇格、正式CLIのJSON診断・add/remove。
- `bun test`・型検査・単体CLI build後にcommit。成功したローカル試験を実機合格へ読み替えない。
- 実機の追加作成・接続や既存環境のcleanupは、この方針レビューとは別の対象・範囲の承認を必要とする。現時点で4つ目の環境は作らない。

## 4. 第3試験の保持状態と証拠

| 項目 | 状態 |
| --- | --- |
| service | `i68r3-4b40a3e2` |
| Worker | `castloop-i68r3-4b40a3e2-33fb8953` |
| private R2 bucket | `castloop-i68r3-4b40a3e2` |
| SQLite namespace | `b9560ab00e174a9c93007df29dbfd8b1` |
| Worker version | `2f99e319-9e1b-4383-831a-5c7d6cc2a741`（initから不変） |
| hostname | `castloop-domain68-r3.otftalk.com`。接続/管理DNSを保持、切断なし |
| 内容 | Show 0、公開0。素材upload・Resumeなし |
| native | paused / drained、publication_ready false、remote domain prepared、対象Show 0、queued 0、active null |
| local | connection_requested、成功receiptなし。configはworkers.devのまま |
| 最終読取確認 | 2026-10-24 08:22:49 UTC |

実行commitは`8d6a0b1bf74eccfa1016b4560473e8f8d2f13f02`、Linux CLI SHA-256は`5d778fef758a8fcc4e8983628f4ea79d91444e9486a972a13bc7e8ddcb9e9adc`。診断追加後の既存ローカル検証は637 tests成功・型検査成功。本試行前にCLIを再buildし、補助runnerのbundle確認も成功した。今回の変更は文書だけで、上の二段階receiptはまだコードへ実装していない。

4 CLI操作（init、add、status、list）の要求前記録・応答、診断、native healthとREST deployment、前後のDNS/domain/routes/Worker/bucket一覧を私有保存した。新規対象だけを除く一覧は試行前と一致した。既存2環境のhealthもGETで再確認し、元のversion・paused/drained・prepared保守拘束を維持した。既存DBやbucket全objectの完全backup/照合という意味ではない。

私有証跡はgit-ignoredな`.local-test-data/results/20261024/i68r3-4b40a3e2/`に保持する。30ファイルのSHA-256 manifestを保存後に再照合した。管理鍵・未公開ID・本文・raw応答をGitへ追加せず、未知journal・原本・旧証跡を削除しない。正規独自originへの切替、redirect、通常公開、履歴保持、接続維持deploy、切断復帰、性能/Free適合をこのShow 0件の診断で検証したとは扱わない。

## 5. 現在の進め方

第3試験後は二段階案を一旦保留してログ調査を優先した。追加承認された第4試験以降の観測と修正は[反復試験記録](sqlite_custom_domain_iterative_verification_20261024.md)を参照する。過去の欠測値を復元したとは扱わず、既存unknownは保持する。
