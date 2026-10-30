# 観測・診断コマンド

v0.8.0では公開job台帳とPause/Resume制御を廃止したため、`job-status`・`progress`・`watch`・`show-control-status`は提供しない。内部queue/content形式14/13の新規サービスを対象に、同期公開の`changed`／`unchanged`とrevision、現在内容、予約状態を確認する。

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

## 詳細確認

- `service-status`／`show-status SHOW`：稼働・準備状態。
- `preview-show`／`preview-episode`：ローカル入力と現在内容。
- `list-*-revisions`：公開履歴。
- `schedule-list`／`schedule-status`：予約の受付・停止・実行結果。

公開応答喪失後は同じ承認済み内容を再実行でき、既に反映済みなら`unchanged`になる。診断や`next_actions`は変更操作の承認ではない。
