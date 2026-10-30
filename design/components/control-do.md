# 制御DOと独自ドメインの設計

制御DOはサービス単位のShow登録簿と、独自ドメイン接続情報を管理します。番組の登録、一覧取得、サービス全体の設定変更で各Show DOと連携します。番組ごとの公開内容は[Show DO](show-do.md)が管理します。

## Showの登録

`create-show` は、サービス設定、Show ID、登録を識別する `reservation_id` を使って、次の順に処理します。

1. 制御DOが、サービスの準備状態と既存登録を確認します。
2. 登録要求を `requested` として保存・同期します。
3. 対象Show DOを初期化し、Show ID・登録ID・サービス設定の一致を確認します。
4. 制御DOの登録を `registered` に更新します。

各DOへの保存は別々に行います。途中で中断した場合は同じ登録IDで再実行し、保存済み情報を照合して登録を完了します。同じShow IDに別の登録IDが指定された場合は競合になります。登録直後のShowは `draft` 状態です。

## サービス状態と一覧取得

サービスのhealthは、制御DOの状態、登録簿、各Showのhealthをまとめて返します。

Show一覧では登録簿から対象を取り出し、各Show DOの現在の状態を取得してページ単位で返します。各Showの取得時点は異なるため、一覧はサービス全体の同時点スナップショットではありません。Episode一覧は、対象のShow DOから直接取得します。

## 独自ドメインとサービス設定

サービスは、管理用の `workers.dev` オリジンと、RSS・音声・サイトのURLに使う `public_base_url` を持ちます。独自ドメインを追加すると公開先がそのホスト名になり、削除すると `workers.dev` に戻ります。

ドメイン変更はCloudflare側の接続、R2の設定、Worker配備、各DO、ローカルTOMLを更新します。CLIは同じ変更を追跡できるよう、以下を保存します。

- 操作UUID、ホスト名、ゾーン、DO名前空間
- 変更前後のサービス設定とハッシュ
- Workerソースと配備メタデータのハッシュ
- 変更前の配備情報、確認済みの接続情報

変更中のホスト名・DNS・Workerドメインは、castloopの操作で管理します。継続時も保存した情報とAPIの現在状態を照合します。

## ドメイン変更の流れ

1. CLIが変更前後の設定をローカルへ保存します。
2. 制御DOと全Show DOが要求を保存し、変更の準備をします。
3. CLIが接続とTLSを確認します。
4. R2のサービス設定とWorkerを変更後の設定に更新します。
5. 稼働Worker版とDO名前空間を確認します。
6. 各Show DOが必要なキャッシュを消去し、設定を確定します。
7. 制御DOが全Showの確定を確認し、自身の設定を確定します。
8. CLIがローカル設定を同期します。
9. 削除の場合は接続を解除し、制御DOの接続情報を最終確定します。

### 準備中の公開・配信

準備対象は、登録が確定しているShowです。各DOは要求ハッシュと変更前設定を照合して `prepared` を保存します。Show DOは未実行予約を `needs_approval` に移します。

準備中のShow DOは、設定が確定するまで公開操作を受け付けず、公開配信に503を返します。キャッシュの参照より前にこの判定を行います。

### 設定を確定する単位

各Show DOは、キャッシュ消去後に、サービス設定ハッシュ・公開中ShowのFeed世代・変更記録の `completed` を同じトランザクションで確定します。制御DOは全Showの完了後に確定します。

このため、切り替え中には完了したShowと準備中のShowが混在します。準備中のShowは503を返し続けます。変更後のWorkerが起動していても、DOは保存済みの準備情報に基づいて確定処理を受け付け、通常操作は確定後に再開します。

## 進捗記録と中断後の継続

| 保存先 | 記録する状態 |
| --- | --- |
| CLIジャーナル | `prepared` → `connected` → `deployed` → `remote_ready` → `local_synced` → `completed` |
| 各DOの変更表 | `prepared` / `completed`、要求とハッシュ、配備・接続の確認情報 |
| 制御DOの接続表 | 最終確認済みの接続情報。ドメイン削除完了時に行を除去 |

CLIの各フェーズは、接続、配備、リモート確定、ローカル同期、最終処理までの確認済み範囲を示します。保存形式は[表設計](../data/sqlite.md)と[スキーマ](../data/schemas.md)を参照してください。

中断時は、保存した操作IDを使って `domain status` で確認し、`domain continue` で続けます。継続時は次を確認します。

- ソース、設定、要求ハッシュ、配備情報、DO名前空間、接続が保存記録と整合すること。
- Worker反映待ちの場合は、同じ配備の反映を観測すること。
- 全DOの確定後にローカル設定を同期すること。
- ドメイン削除時は、新しい配信先を確認してから、保存済みの接続を解除すること。

ローカル設定が変更前・変更後のどちらとも異なる場合はエラーにします。パージやShowへの問い合わせで失敗した場合も、各DOの確定済みデータを保持し、操作全体は未完了として報告します。継続処理は、保存した同一要求を完了させるために使います。

## 実装と関連テスト

- DO：[制御DO](../../src/sqlite-service-control.ts)、[設定変更](../../src/sqlite-domain-runtime.ts)、[稼働設定の照合](../../src/sqlite-runtime-identity.ts)
- CLI：[ドメイン操作](../../packages/cli/src/sqlite-domain-operation.ts)、[ジャーナル](../../packages/cli/src/sqlite-domain-journal.ts)、[Cloudflare接続](../../packages/cli/src/sqlite-domain-cloudflare.ts)
- テスト：[Show分離](../../packages/cli/src/sqlite-show-separation.test.ts)、[ドメイン操作](../../packages/cli/src/sqlite-domain-operation.test.ts)、[稼働設定](../../packages/cli/src/sqlite-domain-runtime.test.ts)、[サービス実行時](../../src/sqlite-service-runtime.test.ts)
- 操作方法：[独自ドメイン利用ガイド](../../docs/custom_domains.md)
