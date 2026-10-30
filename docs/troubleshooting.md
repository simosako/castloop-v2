# 状態確認とトラブルシューティング

まず「ローカル入力」「サーバーの公開確定」「公開URLの配信」のどこを確認するかを分けます。診断は読取専用であり、修復・再公開・キャッシュパージを行いません。秘密・未公開本文・所有者メールを問い合わせやGitへ転載しないでください。

## ローカルと稼働状態の確認

```sh
castloop doctor --local --workspace /path/to/service --json
castloop service-status --workspace /path/to/service --json
castloop show-status daily --workspace /path/to/service --json
```

`doctor --local` は通信せず、設定・管理キーの読み取り等を確認します。鍵や操作記録を生成せず、不正な設定を自動修復しません。認証情報の存在は、有効性・権限の証明ではありません。

`service-status`／`show-status` はサーバーの稼働・準備状態を取得します。設定・保存形式・対象が一致しない場合は、そのエラーを解消する前に別の版やサービスへ切り替えて変更操作を繰り返さないでください。

## diagnose

```sh
castloop diagnose daily --workspace /path/to/service --json
castloop diagnose daily another --max-shows 10 --external --json
```

ローカル設定・鍵、Cloudflare accountの読取、service identity・ドメイン状態、Show登録・準備状態・確定内容を確認する。既定は5 Show、`--max-shows`は1〜20。`--external`指定時だけ公開配信も検査する。

各検査は`scope`と`pass`／`warn`／`fail`／`not_checked`を返す。観測できなかった結果を成功や差分なしにしない。診断は読取専用であり、修復・purge・公開を行わない。failがあれば終了1、warnだけなら0。

## verify

```sh
castloop verify daily --workspace /path/to/service --json
castloop verify daily --episode first --workspace /path/to/service --json
```

認証付き管理APIから確定済み内容を読み、公開FeedへのGETとカバー・指定音源へのHEAD等を照合する。GUID、公開origin、配信サイズ、手元にある未公開Episodeの混入を検査する。公開確定の確認と公開配信の確認は別々に報告する。管理APIを観測できなければ比較未確認を明示し、配信が読めたことだけで公開成功を推測しない。

配信検査は修復・再送や全量音声のhash検証ではない。非公開状態・ドメイン変更中・Access等により公開URLが読めない場合がある。実際の許可された閲覧条件を確認する。

## 内容・履歴・予約の確認

- `service-status`／`show-status SHOW`：稼働・準備状態。
- `preview-show`／`preview-episode`：ローカル入力と現在内容。
- `list-*-revisions`：公開履歴。
- `schedule-list`／`schedule-status`：予約の受付・停止・実行結果。

通常公開の `changed`／`unchanged` と `revision_id` は確定結果です。一方、予約の `scheduled` は受付であり、公開成功ではありません。`schedule-status` の `dispatched` とリビジョンで確認します。

一覧はページ分割されます。`next_cursor` が返った場合は `--cursor` へ渡してください。未取得のページや読取失敗を「対象がない」と判断しません。

## 操作が中断した場合

元プロセスの終了を確認し、入力・設定・原本・`.castloop/` を保持します。同じ場所を変更するCLIを並行起動しないでください。

| 中断した操作 | 確認と再実行 |
| --- | --- |
| 通常の公開 | 現在内容・履歴を読み、同じ承認済み入力で再実行。同じ内容なら `unchanged`。更新元が競合したら再プレビューして確認 |
| 非公開化・過去版の採用 | 現在状態を確認し、同じ確認済み計画を実行。同じ状態なら変更なし。古い計画は作り直して確認 |
| 予約作成 | `schedule-list` と `schedule-status` で受付を確認。応答不明のまま新規予約を作り直さない |
| 初期化 | 元の保存先で `castloop init /path/to/service` を再実行。保存された初期入力を変更しない |
| Show作成 | 元のワークスペース・同じShow IDで `create-show` を再実行 |
| Worker配備 | 同じ設定・対応形式で `deploy` を再実行。[保守手順](maintenance.md)を参照 |
| 独自ドメイン | `domain status UUID` で確認し、承認した対象に `domain continue UUID`。[専用手順](custom_domains.md#照会と中断後の継続)を参照 |
| RSS取り込み | 取り込み元と進捗を保持し、同じ出力先・入力で続行。[RSSガイド](rss_migration.md#停止した場合)を参照 |

CLIは通信エラーだけを理由に変更系要求を自動再送しません。管理GETの一時障害には有限回の再試行がありますが、その失敗を空の結果へ置き換えません。診断出力や `next_actions` は、変更操作の承認ではありません。

## 配信が期待どおりでない場合

- **404**：Show／Episodeの非公開状態、指定した公開パスを確認します。`restore` を行う前に対象と保存内容を確認してください。
- **503**：稼働準備やドメイン変更の状態を確認します。ドメイン変更中は公開配信を一時停止します。
- **Access等の認証応答**：許可された閲覧者・ホスト名・パスで確認します。診断を通す目的で保護を外しません。
- **公開は確定したが配信検査が未確認**：`verify` の管理API側と公開経路側の結果を分けて読みます。公開URLが読めたことだけで内容の確定を推測しません。

テスト用の実環境を追加する場合は、[保護条件と別承認](../design/security.md#非公開の実機試験)が必要です。ローカル検査の成功は、実機性能や全Free適合の証拠ではありません。
