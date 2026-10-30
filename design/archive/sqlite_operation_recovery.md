# 操作中断後の確認と再実行

フェーズ3開発版（内部queue/content形式 **14/13**）は、公開用の操作表・job台帳・個別upload journal・runtime停止（Pause/Resume）を廃止し、中断時は現在の状態をAPIで確認して同じ目標状態へ再実行・継続できる設計に統一した。`operation-*`、`job-status`、`progress`、`watch`、`show-pause`、`show-resume`は使用しない。

## 通常公開・非公開化・履歴採用

`preview-show`／`preview-episode`で現在内容を確認する。応答を失った場合でも、同じ承認済み入力で`publish-*`や`lifecycle-execute`、`revision-execute`を再実行できる。反映済みなら`unchanged`と現在revisionを返し、履歴やパージを追加しない。内容が異なり更新元が変わっていれば409となるため、変更内容を再確認する。

素材の配置だけでは公開しない。PUTに失敗したら公開へ進まず、未参照素材があっても公開状態には影響しない。原本やR2素材を削除しない。

## 予約とRSS

予約作成の応答が不明なら`schedule-list SHOW`で確認し、新規予約を無条件に再作成しない。`schedule-status`の`dispatched`とrevisionは公開確定と同じトランザクションで保存される。更新元競合やドメイン変更で`needs_approval`になった予約は明示再承認する。[予約ガイド](../../docs/admin_configuration.md)を参照。

RSSは一括進捗記録を保持し、中断時も同じ取り込み入力で`publish-rss-import`を再実行すれば続きから完了する。完了済みの同一内容は変更なしになる。[RSSガイド](../../docs/rss_migration.md)を参照。

## 初期化・Show登録・Worker更新・ドメイン変更

- `init`／`create-show`：各ステップは現在の状態をAPIで確認する冪等な処理となっており、通信断等で中断した場合は同じコマンドを再実行すれば完了する。
- `deploy`：ローカルjournalを持たない単発処理。R2の音源・画像は変更せず、中断時はもう一度`castloop deploy`を実行して完了させる。
- `domain`：変更前設定（`previous_config`）と変更後設定（`target_config`）をローカルjournalに保存する。中断時は`castloop domain status UUID`で状態を確認し、`castloop domain continue UUID`で未完了ステップから完了まで進める。[独自ドメインガイド](../../docs/sqlite_custom_domains.md)を参照。
