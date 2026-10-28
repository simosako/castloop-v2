# 公開中断後の確認

フェーズ2開発版は公開用の操作表・job台帳・個別upload journalを廃止した。`operation-*`、`job-status`、`progress`、`watch`は使用しない。旧版の記録は削除せずバックアップへ保持するが、この版で変換・再開しない。

## 通常公開

`preview-show`／`preview-episode`で現在内容を確認する。応答を失った場合でも、同じ承認済み入力で`publish-*`を再実行できる。反映済みなら`unchanged`と現在revisionを返し、履歴やパージを追加しない。内容が異なり更新元が変わっていれば409となるため、変更内容を再確認する。

素材の配置だけでは公開しない。PUTに失敗したら公開へ進まず、未参照素材があっても公開状態には影響しない。原本やR2素材を推測で削除しない。

## 予約とRSS

予約作成の応答が不明なら`schedule-list SHOW`で確認し、新規予約を無条件に再作成しない。`schedule-status`の`dispatched`とrevisionは公開確定と同じトランザクションで保存される。停止予約は明示再承認する。[予約ガイド](admin_configuration.md)を参照。

RSSは一括進捗記録を保持し、同じ取り込み入力で通常公開を続ける。完了済みの同一内容は変更なしになる。Show登録・Resume・ローカル配置の結果が不明な場合は自動再実行せず停止する。[RSSガイド](rss_migration.md)を参照。

## インフラ・制御操作は別

init・Show登録・Pause/Resume・Worker更新・domainの記録と未知結果の非再送条件は維持する。公開の冪等性をこれらへ一般化しない。同じ操作の保存済み結果を読み、[Worker更新](sqlite_sequential_development.md#互換worker更新)・[domain](sqlite_custom_domains.md)の限定続行手順を使う。lock・journalの削除や未知資源の採用は行わない。
