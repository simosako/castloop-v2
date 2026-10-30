# 制御DOと独自ドメイン変更の設計

制御DOはサービス単位の登録簿と独自ドメイン接続情報を保持する。各Showの公開内容は保持せず、登録・一覧・サービス全体の設定変更に必要な範囲でShow DOへ問い合わせる。

## Show登録と一覧

`create-show` はサービス設定、Show ID、`reservation_id` を使って登録する。

1. 制御DOが未完了のドメイン変更と既存登録を検査する。
2. 登録要求を `requested` として保存・同期する。
3. 対象Show DOを初期化し、同じShow ID・登録ID・サービス設定であることを確認する。
4. 制御DOの登録を `registered` にする。

両DOにまたがる単一トランザクションではない。同じ登録IDで再確認できるようにし、別の登録による同一Show IDの採用を拒否する。Show DOは登録情報と `draft` 状態を保持する。この時点では公開しない。

サービスhealthは登録簿とShowごとのhealthを集約する。Show一覧は各Show DOの現状を取得してページングし、取得した内容をサービス全体の同時点スナップショットとは扱わない。Episode一覧は対象Show DOから直接取得する。

## 独自ドメイン変更の対象

サービスは管理用 `workers.dev` オリジンと、Feed等に使う `public_base_url` を持つ。専用ホスト名の追加時は公開オリジンを独自ドメインへ、削除時は `workers.dev` へ戻す。

変更の入口はCLIの `domain add` / `remove`。CLIは次を固定する。

- 操作UUID、ホスト名、ゾーン、DO名前空間
- 変更前後のサービス設定とそれぞれのSHA-256
- Workerソースと配備メタデータのハッシュ
- 変更前の配備情報、既知の接続情報

同じホスト名・DNS・Workerドメインを外部から同時変更する運用は対象外。無関係な既存接続や不明なリモート操作の採用はしない。

## 変更フローと確定範囲

```text
CLIが変更前後の設定を保存
  → 制御DOと全Show DOを準備
  → 接続とTLSを確認
  → R2設定・Workerを変更後設定で配備
  → 稼働版と名前空間を確認
  → 各Show DOがキャッシュパージ後に設定を確定
  → 制御DOが設定を確定
  → ローカル設定を同期
  → 削除時の接続解除、制御DOの接続情報を最終確定
```

制御DOの準備は登録が確定しているShow群を対象にする。各DOは要求のハッシュと変更前設定を照合して `prepared` を保存する。Show DOでは未実行予約を再承認待ちにする。

準備済みで未確定のShow DOは、公開・配信を許可しない。公開配信はキャッシュを参照する前に503を返す。各Showは自分の必要なキャッシュパージを完了してから、サービス設定ハッシュ、公開中ShowのFeed世代、変更記録の `completed` をローカルトランザクションで確定する。

制御DOは全Showの確定を確認してから自分の設定を確定する。**全Showが同時に切り替わる分散トランザクションではない**。途中では確定済みShowと未確定Showが混在し、後者は引き続き配信を拒否する。

変更後設定のWorkerが起動しても、準備記録に一致する変更前設定をDOの実行対象として保持し、確定処理まで通常操作へ開放しない。コード配備だけでは保存設定ハッシュを変更できない。

## ローカルとリモートの状態

| 記録 | 状態と意味 |
| --- | --- |
| CLIジャーナル | `prepared` → `connected` → `deployed` → `remote_ready` → `local_synced` → `completed` |
| 各DOの変更表 | `prepared` / `completed`。要求・要求ハッシュと確定証拠を保持 |
| 制御DOの接続表 | 最終確認済みの接続。削除完了時に行を除去 |

ローカルフェーズは、接続・配備・リモート確定・ローカル同期・最終処理の確認済み範囲を表す。リモートの2状態と混同しない。保存形式は[SQLite表設計](../data/sqlite.md)と[スキーマ](../data/schemas.md)を参照する。

## 中断・競合時

- 通信やTLS反映待ちで中断したら、保存した同じ操作を `domain status` で確認し、明示的に `domain continue` する。
- 継続時もソース、設定、要求ハッシュ、配備証拠、名前空間、接続を再照合する。旧設定または目標設定以外に変わったローカルTOMLは上書きしない。
- Worker反映待ちでは再配備せず、同じ配備の観測を継続する。
- 設定をローカルへ同期する前に全DOの確定を確認する。削除では新しい配信先を確認した後、既知の接続だけを解除する。
- パージやShow RPCに失敗しても確定済み内容は破壊しない。残りのDOやローカル処理が未完了の場合は、サービス全体の完了とは報告しない。

変更前設定を保存することは、任意の段階を自動的にロールバックする機能を意味しない。継続は、保存した同一要求と現在のAPI状態が整合する範囲で行う。

## 定義元と関連テスト

- [制御DO](../../src/sqlite-service-control.ts)、[DO側の設定変更](../../src/sqlite-domain-runtime.ts)、[稼働設定の照合](../../src/sqlite-runtime-identity.ts)
- [CLIの変更処理](../../packages/cli/src/sqlite-domain-operation.ts)、[ローカルジャーナル](../../packages/cli/src/sqlite-domain-journal.ts)、[Cloudflare接続管理](../../packages/cli/src/sqlite-domain-cloudflare.ts)
- [Show分離テスト](../../packages/cli/src/sqlite-show-separation.test.ts)、[ドメイン操作テスト](../../packages/cli/src/sqlite-domain-operation.test.ts)、[稼働設定テスト](../../packages/cli/src/sqlite-domain-runtime.test.ts)、[サービス実行時テスト](../../src/sqlite-service-runtime.test.ts)
- 操作方法：[独自ドメイン利用ガイド](../../docs/custom_domains.md)
